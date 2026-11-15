/**
 * 人机成员读模型与落库实现（M6）。
 *
 * 与 `permissions.ts` 的分工：这里只回答「这个成员是谁、在什么岗位、有哪些能力、
 * 手上还有多少活」，不参与「当前请求的主体能不能做某事」——后者仍由
 * `resolvePrincipal` + `requireCapability` 决定，避免读模型顺手把权限放出去。
 *
 * 两条硬规则（schema 触发器 + backend-design §4）：
 * - 岗位只能给人（`trg_member_position_human_only`）；人的能力只来自在岗岗位的并集；
 * - bot 的能力只来自 `member_permission`，审批/发布类能力由库触发器拒绝授予。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { stateInvalid } from '../domain/errors.ts'
import type { IdFactory } from '../domain/ids.ts'
import { CAPABILITY } from './permissions.ts'

export const MEMBER_KINDS = ['human', 'bot'] as const
export const MEMBER_ROLES = ['coordinator', 'executor', 'observer'] as const
export const MEMBER_STATUSES = ['active', 'paused', 'retired'] as const

export interface MemberRow {
  id: string
  kind: string
  name: string
  domain: string | null
  responsibility: string
  role: string
  status: string
  current_version: number
  owner_human_id: string | null
  created_at: number
  updated_at: number
}

export interface MemberSummary {
  id: string
  kind: string
  name: string
  domain: string | null
  responsibility: string
  role: string
  status: string
  current_version: number
  owner_human_id: string | null
  owner_name: string | null
  created_at: number
  updated_at: number
  positions: { id: string; name: string }[]
  capabilities: string[]
  work: { total: number; open: number; byStatus: Record<string, number> }
  runs: { total: number; last_at: number | null }
}

export interface MemberDetail extends MemberSummary {
  position_history: {
    position_id: string
    position_name: string
    starts_at: number
    ends_at: number | null
    assigned_by: string
    active: boolean
  }[]
  permissions: { capability: string; scope: string; granted_by: string; granted_at: number }[]
  recent_work: {
    id: string
    title: string
    status: string
    project_id: string | null
    owner_human_id: string
    assignee_id: string | null
    due_at: number | null
    next_action_at: number | null
    updated_at: number
  }[]
  recent_runs: {
    id: string
    work_item_id: string
    status: string
    trigger: string
    started_at: number | null
    finished_at: number | null
    created_at: number
  }[]
  bot_versions: {
    id: string
    version: number
    model: string | null
    agent_preset: string | null
    prompt: string
    change_class: string
    published_by: string
    published_at: number
  }[]
  /** 非空 = 这是宿主 subagent 自动登记的子代理，没有 HAMS 托管配置。 */
  subagent_session_id?: string | null
  login: {
    id: string
    login: string
    display_name: string
    auth_source: string
    is_admin: number
    status: string
    last_login_at: number | null
  } | null
}

export interface PositionSummary {
  id: string
  name: string
  domain: string | null
  description: string
  status: string
  capabilities: { capability: string; scope: string }[]
  holders: number
}

const MAX_NAME = 60
const MAX_TEXT = 500

function requiredText(value: unknown, field: string, max = MAX_NAME): string {
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) throw stateInvalid(`${field} 不能为空`)
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function optionalText(value: unknown, field: string, max = MAX_TEXT): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw stateInvalid(`${field} 只能是 ${allowed.join(' / ')}`)
  }
  return value as T
}

function capabilitiesOf(db: DatabaseSync, memberId: string, kind: string, now: number): string[] {
  if (kind === 'bot') {
    return (db.prepare('SELECT capability FROM member_permission WHERE member_id = ?').all(memberId) as {
      capability: string
    }[]).map((row) => row.capability)
  }
  if (kind !== 'human') return []
  return (
    db
      .prepare(
        `SELECT DISTINCT pp.capability AS capability
           FROM member_position mp
           JOIN position p ON p.id = mp.position_id AND p.status = 'active'
           JOIN position_permission pp ON pp.position_id = mp.position_id
          WHERE mp.member_id = ? AND mp.starts_at <= ? AND (mp.ends_at IS NULL OR mp.ends_at > ?)`,
      )
      .all(memberId, now, now) as { capability: string }[]
  ).map((row) => row.capability)
}

function workStats(db: DatabaseSync, memberId: string): MemberSummary['work'] {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM work_item
        WHERE owner_human_id = ? OR assignee_id = ?
        GROUP BY status`,
    )
    .all(memberId, memberId) as { status: string; c: number }[]
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byStatus[row.status] = Number(row.c)
    total += Number(row.c)
  }
  const closed = (byStatus.completed ?? 0) + (byStatus.cancelled ?? 0)
  return { total, open: total - closed, byStatus }
}

function positionsOf(db: DatabaseSync, memberId: string): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT p.id, p.name FROM member_position mp
         JOIN position p ON p.id = mp.position_id
        WHERE mp.member_id = ? AND mp.ends_at IS NULL
        ORDER BY p.name`,
    )
    .all(memberId) as { id: string; name: string }[]
}

export function listMembers(
  db: DatabaseSync,
  now: number,
  filter: { kind?: string; status?: string; projectId?: string; limit?: number } = {},
): MemberSummary[] {
  const clauses: string[] = ["m.kind <> 'system'"]
  const params: unknown[] = []
  // 临时 bot 只属于某个项目群：默认不出现在全局成员列表，按 projectId 查时才带出来。
  if (filter.projectId) {
    clauses.push('m.scope_project_id = ?')
    params.push(filter.projectId)
  } else {
    clauses.push('m.scope_project_id IS NULL')
  }
  if (filter.kind) {
    clauses.push('m.kind = ?')
    params.push(filter.kind)
  }
  if (filter.status) {
    clauses.push('m.status = ?')
    params.push(filter.status)
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200)
  const rows = db
    .prepare(
      `SELECT m.*, o.name AS owner_name,
              (SELECT COUNT(*) FROM task_run r WHERE r.member_id = m.id) AS run_total,
              (SELECT MAX(r.created_at) FROM task_run r WHERE r.member_id = m.id) AS last_run_at
         FROM member m
         LEFT JOIN member o ON o.id = m.owner_human_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY CASE m.kind WHEN 'bot' THEN 1 ELSE 0 END, m.status, m.name
        LIMIT ${limit}`,
    )
    .all(...(params as never[])) as (MemberRow & { owner_name: string | null; run_total: number; last_run_at: number | null })[]

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    domain: row.domain,
    responsibility: row.responsibility,
    role: row.role,
    status: row.status,
    current_version: Number(row.current_version),
    owner_human_id: row.owner_human_id,
    owner_name: row.owner_name,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    positions: positionsOf(db, row.id),
    // 停用 / 退休的主体按 resolvePrincipal 的口径不再拥有任何能力（界面显示为空）。
    capabilities: row.status === 'active' ? capabilitiesOf(db, row.id, row.kind, now).sort() : [],
    work: workStats(db, row.id),
    runs: { total: Number(row.run_total), last_at: row.last_run_at === null ? null : Number(row.last_run_at) },
  }))
}

export function getMember(db: DatabaseSync, now: number, memberId: string): MemberDetail {
  // 临时 bot 的 scope_project_id 非空，默认列表故意不带它们；按它归属的项目查才拿得到。
  const scope = db.prepare('SELECT scope_project_id FROM member WHERE id = ?').get(memberId) as
    | { scope_project_id: string | null }
    | undefined
  if (!scope) throw stateInvalid(`成员不存在：${memberId}`)
  const summary = listMembers(db, now, {
    ...(scope.scope_project_id ? { projectId: scope.scope_project_id } : {}),
    limit: 200,
  }).find((item) => item.id === memberId)
  if (!summary) throw stateInvalid(`成员不存在：${memberId}`)

  const positionHistory = db
    .prepare(
      `SELECT mp.position_id, p.name AS position_name, mp.starts_at, mp.ends_at, mp.assigned_by
         FROM member_position mp JOIN position p ON p.id = mp.position_id
        WHERE mp.member_id = ?
        ORDER BY mp.starts_at DESC`,
    )
    .all(memberId) as {
    position_id: string
    position_name: string
    starts_at: number
    ends_at: number | null
    assigned_by: string
  }[]

  const permissions = db
    .prepare(
      `SELECT capability, scope, granted_by, granted_at FROM member_permission
        WHERE member_id = ? ORDER BY capability, scope`,
    )
    .all(memberId) as MemberDetail['permissions']

  const recentWork = db
    .prepare(
      `SELECT id, title, status, project_id, owner_human_id, assignee_id, due_at, next_action_at, updated_at
         FROM work_item WHERE owner_human_id = ? OR assignee_id = ?
        ORDER BY updated_at DESC LIMIT 10`,
    )
    .all(memberId, memberId) as MemberDetail['recent_work']

  const recentRuns = db
    .prepare(
      `SELECT id, work_item_id, status, trigger, started_at, finished_at, created_at
         FROM task_run WHERE member_id = ?
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(memberId) as MemberDetail['recent_runs']

  const botVersions = db
    .prepare(
      `SELECT id, version, model, agent_preset, prompt, change_class, published_by, published_at
         FROM member_version WHERE member_id = ?
        ORDER BY version DESC LIMIT 10`,
    )
    .all(memberId) as MemberDetail['bot_versions']

  const subagent = db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`member:${memberId}:subagent`) as
    | { value: string }
    | undefined
  const login = (db
    .prepare(
      `SELECT id, login, display_name, auth_source, is_admin, status, last_login_at
         FROM hams_user WHERE member_id = ? LIMIT 1`,
    )
    .get(memberId) as MemberDetail['login']) ?? null

  return {
    ...summary,
    position_history: positionHistory.map((item) => ({
      ...item,
      starts_at: Number(item.starts_at),
      ends_at: item.ends_at === null ? null : Number(item.ends_at),
      active: item.ends_at === null,
    })),
    permissions: permissions.map((item) => ({ ...item, granted_at: Number(item.granted_at) })),
    recent_work: recentWork.map((item) => ({
      ...item,
      due_at: item.due_at === null ? null : Number(item.due_at),
      next_action_at: item.next_action_at === null ? null : Number(item.next_action_at),
      updated_at: Number(item.updated_at),
    })),
    recent_runs: recentRuns.map((item) => ({
      ...item,
      started_at: item.started_at === null ? null : Number(item.started_at),
      finished_at: item.finished_at === null ? null : Number(item.finished_at),
      created_at: Number(item.created_at),
    })),
    bot_versions: botVersions.map((item) => ({ ...item, version: Number(item.version), published_at: Number(item.published_at) })),
    subagent_session_id: subagent?.value ?? null,
    login,
  }
}

export function listPositions(db: DatabaseSync): PositionSummary[] {
  const positions = db
    .prepare('SELECT id, name, domain, description, status FROM position ORDER BY name')
    .all() as { id: string; name: string; domain: string | null; description: string; status: string }[]
  return positions.map((position) => ({
    ...position,
    capabilities: db
      .prepare('SELECT capability, scope FROM position_permission WHERE position_id = ? ORDER BY capability, scope')
      .all(position.id) as { capability: string; scope: string }[],
    holders: Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM member_position
              WHERE position_id = ? AND ends_at IS NULL`,
          )
          .get(position.id) as { c: number }
      ).c,
    ),
  }))
}

export interface CreateMemberInput {
  kind: string
  name: string
  role?: string
  domain?: string | null
  responsibility?: string | null
  positionId?: string | null
  ownerHumanId?: string | null
  agentPreset?: string | null
  model?: string | null
  /** bot 的人设提示词；空 = 用 HAMS 基础规则，创建时默认取职责。 */
  prompt?: string | null
  capabilities?: string[]
  scope?: string | null
}

export interface InsertedMember {
  id: string
  kind: string
  version: number
  capabilities: string[]
}

/** bot 可以拿到的能力白名单：工具通道 + 业务动作，不含审批/发布/管理。 */
export const BOT_GRANTABLE_CAPABILITIES = [
  CAPABILITY.workItemCreate,
  CAPABILITY.workItemClaim,
  CAPABILITY.workItemExecute,
  CAPABILITY.workItemRequestClosure,
  CAPABILITY.evidenceAppend,
  CAPABILITY.checkEvaluate,
  CAPABILITY.proposalCreate,
  CAPABILITY.connectorIngest,
  CAPABILITY.metricRecord,
  CAPABILITY.knowledgeWrite,
] as const

export function insertMember(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  actorId: string,
  input: CreateMemberInput,
): InsertedMember {
  const kind = oneOf(input.kind, '成员类型', MEMBER_KINDS)
  const name = requiredText(input.name, '姓名')
  const role = oneOf(input.role, '角色', MEMBER_ROLES, 'executor')
  const domain = optionalText(input.domain, '业务域', 40)
  const responsibility = optionalText(input.responsibility, '职责', MAX_TEXT) ?? ''
  const duplicate = db.prepare('SELECT id FROM member WHERE name = ?').get(name) as { id: string } | undefined
  if (duplicate) throw stateInvalid(`成员名已存在：${name}`, '换一个名字，或打开已有成员')

  const id = ids()
  if (kind === 'human') {
    const positionId = requiredText(input.positionId, '岗位')
    const position = db.prepare("SELECT id, status FROM position WHERE id = ?").get(positionId) as
      | { id: string; status: string }
      | undefined
    if (!position) throw stateInvalid(`岗位不存在：${positionId}`, '先在岗位列表里选一个')
    if (position.status !== 'active') throw stateInvalid(`岗位已停用：${positionId}`)
    db.prepare(
      `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                           owner_human_id, created_at, updated_at)
       VALUES (?, 'human', ?, ?, ?, ?, 'active', 0, NULL, ?, ?)`,
    ).run(id, name, domain, responsibility, role, now, now)
    db.prepare(
      `INSERT INTO member_position (member_id, position_id, starts_at, ends_at, assigned_by)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(id, positionId, now, actorId)
    return { id, kind, version: 0, capabilities: capabilitiesOf(db, id, kind, now).sort() }
  }

  // bot：配置快照发布即不可变；责任人必须是存在的人。
  const ownerId = optionalText(input.ownerHumanId, '责任人', 64) ?? actorId
  const owner = db.prepare('SELECT id, kind FROM member WHERE id = ?').get(ownerId) as
    | { id: string; kind: string }
    | undefined
  if (!owner || owner.kind !== 'human') throw stateInvalid('bot 的责任人必须是存在的人')
  const agentPreset = optionalText(input.agentPreset, 'agent preset', 80)
  const model = optionalText(input.model, '模型', 120)
  // 2026-11-15：职责不再只挂在成员表上——创建时默认把它作为提示词，随版本冻结。
  const prompt = optionalText(input.prompt, '提示词', 8192) ?? responsibility
  const granted = [...new Set(Array.isArray(input.capabilities) ? input.capabilities : [])]
  for (const capability of granted) {
    if (!(BOT_GRANTABLE_CAPABILITIES as readonly string[]).includes(capability)) {
      throw stateInvalid(`bot 不能获得能力：${capability}`, '审批、发布、成员管理只能给人')
    }
  }
  const scope = optionalText(input.scope, '授权范围', 80) ?? 'global'
  if (!/^(global|domain:[^:]+|project:[^:]+)$/.test(scope)) {
    throw stateInvalid('授权范围只能是 global / domain:<域> / project:<id>')
  }
  const promptDigest = createHash('sha256')
    .update(JSON.stringify({ name, responsibility, agentPreset, model, prompt }))
    .digest('hex')

  db.prepare(
    `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                         owner_human_id, created_at, updated_at)
     VALUES (?, 'bot', ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
  ).run(id, name, domain, responsibility, role, ownerId, now, now)
  db.prepare(
    `INSERT INTO member_version
       (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
        change_class, published_by, published_at)
     VALUES (?, ?, 1, ?, ?, '{}', ?, ?, 'major', ?, ?)`,
  ).run(ids(), id, agentPreset, model, prompt, promptDigest, actorId, now)
  const grant = db.prepare(
    `INSERT INTO member_permission (member_id, capability, scope, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const capability of [...granted].sort()) grant.run(id, capability, scope, actorId, now)
  return { id, kind, version: 1, capabilities: capabilitiesOf(db, id, kind, now).sort() }
}

export interface MemberStatusChange {
  before: string
  after: string
  closedPositions: number
}

export function setMemberStatus(
  db: DatabaseSync,
  now: number,
  actorId: string,
  memberId: string,
  to: string,
): MemberStatusChange {
  const row = db.prepare('SELECT * FROM member WHERE id = ?').get(memberId) as MemberRow | undefined
  if (!row) throw stateInvalid(`成员不存在：${memberId}`)
  if (row.kind === 'system') throw stateInvalid('系统主体不能停用')
  if (memberId === actorId) throw stateInvalid('不能改变自己的状态', '请由另一名有成员管理权限的人操作')
  const target = oneOf(to, '成员状态', MEMBER_STATUSES)
  const before = row.status
  if (before === target) return { before, after: target, closedPositions: 0 }

  const allowed: Record<string, string[]> = {
    active: ['paused', 'retired'],
    paused: ['active', 'retired'],
    retired: ['active'],
  }
  if (!allowed[before]?.includes(target)) {
    throw stateInvalid(`成员状态不能从 ${before} 改为 ${target}`)
  }
  db.prepare('UPDATE member SET status = ?, updated_at = ? WHERE id = ?').run(target, now, memberId)
  let closed = 0
  if (target === 'retired' && row.kind === 'human') {
    const result = db
      .prepare(
        `UPDATE member_position
            SET ends_at = CASE WHEN starts_at >= ? THEN starts_at + 1 ELSE ? END
          WHERE member_id = ? AND ends_at IS NULL`,
      )
      .run(now, now, memberId)
    closed = Number(result.changes ?? 0)
  }
  return { before, after: target, closedPositions: closed }
}
