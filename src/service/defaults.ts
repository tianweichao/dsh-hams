/**
 * 默认 bot：项目管理 / 数据分析。
 *
 * 两个 bot 是「开箱就能用」的底座，不是样例数据：
 * - 项目管理（`bot-pm`）是新项目默认的推进 bot：拆目标、派活、汇总；它没有审批/关单能力；
 * - 数据分析（`bot-data`）默认进入每个项目的群聊：查数、对比、给结论。
 *
 * 三条纪律：
 * 1. 幂等：按固定 id + 名字双查，已存在就不动（用户改过名字/配置也不覆盖）；
 * 2. 只补缺失：默认 bot 被退休/暂停后不自动复活，避免覆盖人的决定；
 * 3. 责任人必须是本机操作者（人）——bot 不能没有责任人，也不能归 bot。
 *
 * 这两个 bot 由宿主启动时调用 `ensureDefaultBots` 落库；测试里直接调用它。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { IdFactory } from '../domain/ids.ts'
import { stateInvalid } from '../domain/errors.ts'

export const DEFAULT_COORDINATOR_NAME = '项目管理'
export const DEFAULT_ANALYST_NAME = '数据分析'
export const DEFAULT_COORDINATOR_ID = 'bot-pm'
export const DEFAULT_ANALYST_ID = 'bot-data'

export interface DefaultBotSpec {
  id: string
  name: string
  domain: string
  role: 'coordinator' | 'executor'
  responsibility: string
  capabilities: string[]
}

export const DEFAULT_BOTS: readonly DefaultBotSpec[] = Object.freeze([
  {
    id: DEFAULT_COORDINATOR_ID,
    name: DEFAULT_COORDINATOR_NAME,
    domain: '通用',
    role: 'coordinator',
    responsibility:
      '新项目默认推进 bot：把目标拆成工作项、在项目群里 @ 具体成员派活、汇总进展；改目标口径、审批与关单仍由人做。',
    capabilities: [
      'work_item.claim',
      'work_item.execute',
      'work_item.request_closure',
      'evidence.append',
      'check.evaluate',
      'proposal.create',
    ],
  },
  {
    id: DEFAULT_ANALYST_ID,
    name: DEFAULT_ANALYST_NAME,
    domain: '通用',
    role: 'executor',
    responsibility:
      '默认数据分析 bot：查指标与工作项数据、做对比、给结论并登记证据；不下市场判断、不批准关单。',
    capabilities: [
      'work_item.claim',
      'work_item.execute',
      'evidence.append',
      'metric.record',
      'connector.ingest',
    ],
  },
])

export interface DefaultBotResult {
  created: { key: string; id: string; name: string }[]
  existing: { key: string; id: string; name: string }[]
}

interface BotRow {
  id: string
  name: string
  kind: string
  status: string
}

function findBot(db: DatabaseSync, spec: DefaultBotSpec): BotRow | undefined {
  // 固定 id 优先；同名只认全局成员（scope_project_id 为空），别把项目内临时 bot 当默认。
  return db
    .prepare(
      `SELECT id, name, kind, status FROM member
        WHERE id = ? OR (name = ? AND scope_project_id IS NULL)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(spec.id, spec.name, spec.id) as BotRow | undefined
}

/** 按成员 id 或默认名字找一个在岗的默认 bot。 */
export function findDefaultBot(db: DatabaseSync, key: 'coordinator' | 'analyst'): BotRow | null {
  const spec = key === 'coordinator' ? DEFAULT_BOTS[0] : DEFAULT_BOTS[1]
  const row = findBot(db, spec)
  return row && row.kind === 'bot' && row.status === 'active' ? row : null
}

/** 新项目没有显式指定推进 bot 时用它。找不到返回 null，不阻断建项目。 */
export function defaultCoordinatorId(db: DatabaseSync): string | null {
  return findDefaultBot(db, 'coordinator')?.id ?? null
}

/** 幂等创建两个默认 bot；已存在（同名或同 id）就跳过。 */
export function ensureDefaultBots(db: DatabaseSync, ids: IdFactory, now: number, ownerHumanId: string): DefaultBotResult {
  const owner = db.prepare('SELECT id, kind, status FROM member WHERE id = ?').get(ownerHumanId) as
    | { id: string; kind: string; status: string }
    | undefined
  if (!owner || owner.kind !== 'human' || owner.status !== 'active') {
    throw stateInvalid('默认 bot 的责任人必须是本机在岗的人')
  }

  const result: DefaultBotResult = { created: [], existing: [] }
  const insertMember = db.prepare(
    `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                         owner_human_id, created_at, updated_at)
     VALUES (?, 'bot', ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
  )
  const insertVersion = db.prepare(
    `INSERT INTO member_version
       (id, member_id, version, agent_preset, model, memory_scope_json, prompt_digest,
        change_class, published_by, published_at)
     VALUES (?, ?, 1, 'hams-bot', NULL, '{}', ?, 'major', ?, ?)`,
  )
  const grant = db.prepare(
    'INSERT OR IGNORE INTO member_permission (member_id, capability, scope, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
  )

  for (const spec of DEFAULT_BOTS) {
    const existing = findBot(db, spec)
    if (existing) {
      result.existing.push({ key: spec.id, id: existing.id, name: existing.name })
      continue
    }
    const digest = createHash('sha256').update(`${spec.name}\n${spec.responsibility}`).digest('hex').slice(0, 16)
    insertMember.run(
      spec.id,
      spec.name,
      spec.domain,
      spec.responsibility,
      spec.role,
      ownerHumanId,
      now,
      now,
    )
    insertVersion.run(ids(), spec.id, digest, ownerHumanId, now)
    for (const capability of spec.capabilities) grant.run(spec.id, capability, 'global', ownerHumanId, now)
    result.created.push({ key: spec.id, id: spec.id, name: spec.name })
  }
  return result
}

/**
 * 新项目默认把数据分析 bot 拉进群：否则「@数据分析 去查一下」在开箱状态下无人可点。
 * 只补缺失，不复活被移出的人；推进 bot 自己不当群成员。
 */
export function ensureDefaultAnalystInProject(
  db: DatabaseSync,
  projectId: string,
  coordinatorId: string | null,
  addedBy: string,
  now: number,
): { added: boolean; memberId: string | null } {
  const analyst = findDefaultBot(db, 'analyst')
  if (!analyst || analyst.id === coordinatorId) return { added: false, memberId: null }
  const project = db.prepare('SELECT id, status FROM project WHERE id = ? AND deleted_at IS NULL').get(projectId) as
    | { id: string; status: string }
    | undefined
  if (!project) return { added: false, memberId: null }
  const existing = db
    .prepare('SELECT removed_at FROM project_participant WHERE project_id = ? AND member_id = ?')
    .get(projectId, analyst.id) as { removed_at: number | null } | undefined
  if (existing && existing.removed_at === null) return { added: false, memberId: analyst.id }
  db.prepare(
    `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
     VALUES (?, ?, 'member', ?, ?, ?, NULL, NULL)
     ON CONFLICT(project_id, member_id) DO UPDATE SET
       kind = 'member', brief = excluded.brief, added_by = excluded.added_by,
       added_at = excluded.added_at, removed_by = NULL, removed_at = NULL`,
  ).run(projectId, analyst.id, '默认数据分析：查指标与工作项数据，出结论。', addedBy, now)
  return { added: true, memberId: analyst.id }
}
