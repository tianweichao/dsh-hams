/**
 * 项目记忆：把推进过程中值得留下来的短句收起来，并在需要时喂回给 bot。
 *
 * 三类来源：
 * - `auto`：群聊消息里被规则识别出来的决策 / 偏好 / 教训 / 能力 / 事实；
 * - `manual`：人在项目「记忆」页签手写；
 * - `tool`：bot 通过 hams_remember 主动记录。
 *
 * 能力类（kind='capability'）记忆会镜像一份到 `bot_memory`，并进入该 bot
 * 的会话上下文；其它类型只属于项目，避免把“项目口径”误当成 bot 的永久能力。
 *
 * 纪律：
 * - 自动提取只做保守的关键词规则，宁可少收，不把整段聊天搬进记忆；
 * - 同一项目内用 dedupe_key 去重，重复轮询/重复发送不会产生重复记忆；
 * - 归档只改 status，不删行；项目软删时记忆随项目一起隐藏。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { stateInvalid } from '../domain/errors.ts'
import type { IdFactory } from '../domain/ids.ts'

export const MEMORY_KINDS = ['fact', 'decision', 'preference', 'lesson', 'capability'] as const
export const MEMORY_ORIGINS = ['auto', 'manual', 'tool'] as const
export const MEMORY_STATUSES = ['active', 'archived'] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  preference: '偏好',
  lesson: '教训',
  capability: '能力',
}

const MAX_TITLE = 120
const MAX_BODY = 2000
const MAX_RETURN = 200

export interface ProjectMemoryRow {
  id: string
  project_id: string
  kind: MemoryKind
  title: string
  body: string
  origin: MemoryOrigin
  status: MemoryStatus
  member_id: string | null
  source_ref: string | null
  dedupe_key: string
  created_by: string
  created_at: number
  updated_at: number
  revision: number
}

export interface ProjectMemoryView extends ProjectMemoryRow {
  member_name: string | null
  created_by_name: string | null
}

export interface MemberMemoryRow {
  id: string
  member_id: string
  project_id: string
  memory_id: string
  kind: string
  title: string
  body: string
  created_at: number
  project_name?: string
}

export interface CreateMemoryInput {
  projectId: string
  kind: string
  title: string
  body: string
  origin?: string
  memberId?: string | null
  sourceRef?: string | null
  dedupeKey?: string | null
  status?: string
}

export interface CreateMemoryResult {
  memory: ProjectMemoryView
  created: boolean
  syncedTo: string | null
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) throw stateInvalid(`${field} 不能为空`)
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw stateInvalid(`${field} 只能是 ${allowed.join(' / ')}`)
  }
  return value as T
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function memoryDedupeKey(kind: string, title: string, body: string): string {
  return createHash('sha256').update(`${kind}\n${normalize(title)}\n${normalize(body)}`).digest('hex').slice(0, 32)
}

function projectOrThrow(db: DatabaseSync, projectId: string): { id: string; status: string } {
  const row = db
    .prepare('SELECT id, status FROM project WHERE id = ? AND deleted_at IS NULL')
    .get(projectId) as { id: string; status: string } | undefined
  if (!row) throw stateInvalid(`项目不存在：${projectId}`)
  return row
}

function memoryView(db: DatabaseSync, projectId: string, dedupeKey: string): ProjectMemoryView | null {
  return (
    (db
      .prepare(
        `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
           FROM project_memory m
           LEFT JOIN member mb ON mb.id = m.member_id
           LEFT JOIN member cb ON cb.id = m.created_by
          WHERE m.project_id = ? AND m.dedupe_key = ?`,
      )
      .get(projectId, dedupeKey) as ProjectMemoryView | undefined) ?? null
  )
}

/** 写一条记忆；能力类且指定了 bot 时同步一份到 bot_memory。返回是否真的新建。 */
export function createMemory(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  actorId: string,
  input: CreateMemoryInput,
): CreateMemoryResult {
  const project = projectOrThrow(db, input.projectId)
  if (project.status === 'archived') throw stateInvalid('归档项目只读，不能再写记忆')
  const kind = oneOf(input.kind, '记忆类型', MEMORY_KINDS)
  const origin = oneOf(input.origin, '记忆来源', MEMORY_ORIGINS, 'manual')
  const status = oneOf(input.status, '记忆状态', MEMORY_STATUSES, 'active')
  const title = text(input.title, '记忆标题', MAX_TITLE)
  const body = text(input.body, '记忆正文', MAX_BODY)
  const sourceRef = optionalText(input.sourceRef, '来源', 200)
  const dedupeKey = optionalText(input.dedupeKey, '去重键', 160) || memoryDedupeKey(kind, title, body)

  let memberId = optionalText(input.memberId, '归属 bot', 64)
  if (kind !== 'capability') memberId = null
  if (memberId) {
    const member = db.prepare('SELECT id, kind, status FROM member WHERE id = ?').get(memberId) as
      | { id: string; kind: string; status: string }
      | undefined
    if (!member || member.kind !== 'bot') throw stateInvalid('能力类记忆只能同步给 bot')
    if (member.status !== 'active') throw stateInvalid(`${memberId} 不在岗，暂不同步能力记忆`)
  }

  const insert = db
    .prepare(
      `INSERT OR IGNORE INTO project_memory
         (id, project_id, kind, title, body, origin, status, member_id, source_ref,
          dedupe_key, created_by, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(ids(), input.projectId, kind, title, body, origin, status, memberId, sourceRef, dedupeKey, actorId, now, now)
  const created = Number(insert.changes ?? 0) > 0
  const memory = memoryView(db, input.projectId, dedupeKey)
  if (!memory) throw stateInvalid('记忆写入失败')
  let syncedTo: string | null = null
  if (kind === 'capability' && memberId) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_memory (id, member_id, project_id, memory_id, kind, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids(), memberId, input.projectId, memory.id, kind, title, body, now)
    syncedTo = memberId
  }
  return { memory, created, syncedTo }
}

export interface UpdateMemoryInput {
  memoryId: string
  title?: string
  body?: string
  status?: string
}

/** 改标题/正文/状态；能力类记忆的 bot 快照跟着更新。 */
export function updateMemory(
  db: DatabaseSync,
  now: number,
  input: UpdateMemoryInput,
): ProjectMemoryView {
  const row = db.prepare('SELECT * FROM project_memory WHERE id = ?').get(input.memoryId) as ProjectMemoryRow | undefined
  if (!row) throw stateInvalid(`记忆不存在：${input.memoryId}`)
  const title = input.title === undefined ? row.title : text(input.title, '记忆标题', MAX_TITLE)
  const body = input.body === undefined ? row.body : text(input.body, '记忆正文', MAX_BODY)
  const status = input.status === undefined ? row.status : oneOf(input.status, '记忆状态', MEMORY_STATUSES)
  const revision = Number(row.revision) + 1
  db.prepare('UPDATE project_memory SET title = ?, body = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?').run(
    title,
    body,
    status,
    revision,
    now,
    row.id,
  )
  if (row.kind === 'capability' && row.member_id) {
    db.prepare('UPDATE bot_memory SET title = ?, body = ? WHERE memory_id = ?').run(title, body, row.id)
  }
  return (
    (db
      .prepare(
        `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
           FROM project_memory m
           LEFT JOIN member mb ON mb.id = m.member_id
           LEFT JOIN member cb ON cb.id = m.created_by
          WHERE m.id = ?`,
      )
      .get(row.id) as ProjectMemoryView | undefined) ?? { ...row, title, body, status, revision, member_name: null, created_by_name: null }
  )
}

export function listProjectMemories(
  db: DatabaseSync,
  filter: { projectId: string; status?: string; kind?: string; limit?: number },
): ProjectMemoryView[] {
  projectOrThrow(db, filter.projectId)
  const clauses = ['m.project_id = ?']
  const params: unknown[] = [filter.projectId]
  if (filter.status) {
    clauses.push('m.status = ?')
    params.push(oneOf(filter.status, '记忆状态', MEMORY_STATUSES))
  }
  if (filter.kind) {
    clauses.push('m.kind = ?')
    params.push(oneOf(filter.kind, '记忆类型', MEMORY_KINDS))
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
  return db
    .prepare(
      `SELECT m.*, mb.name AS member_name, cb.name AS created_by_name
         FROM project_memory m
         LEFT JOIN member mb ON mb.id = m.member_id
         LEFT JOIN member cb ON cb.id = m.created_by
        WHERE ${clauses.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit}`,
    )
    .all(...(params as never[])) as ProjectMemoryView[]
}

export function listMemberMemories(db: DatabaseSync, memberId: string, limit = 50): MemberMemoryRow[] {
  return db
    .prepare(
      `SELECT mm.*, p.name AS project_name
         FROM bot_memory mm
         LEFT JOIN project p ON p.id = mm.project_id
        WHERE mm.member_id = ?
        ORDER BY mm.created_at DESC, mm.id DESC
        LIMIT ?`,
    )
    .all(memberId, Math.min(Math.max(limit, 1), 200)) as MemberMemoryRow[]
}

function block(rows: ProjectMemoryView[], title: string): string {
  if (!rows.length) return ''
  const lines = rows.map((row) => {
    const body = normalize(row.body)
    const detail = body && body !== normalize(row.title) ? `：${body.slice(0, 180)}` : ''
    return `- [${MEMORY_KIND_LABEL[row.kind] ?? row.kind}] ${row.title.slice(0, 80)}${detail}`
  })
  return `【${title}】\n${lines.join('\n')}`
}

/** 注入项目群会话的上下文：最近的有效记忆，最多 8 条。 */
export function projectMemoryBlock(db: DatabaseSync, projectId: string, limit = 8): string {
  const rows = listProjectMemories(db, { projectId, status: 'active', limit })
    .slice()
    .reverse()
  return block(rows, `项目记忆 · ${rows.length} 条`)
}

/** 注入单个 bot 会话的上下文：它从项目里同步过的能力记忆。 */
export function memberMemoryBlock(db: DatabaseSync, memberId: string, limit = 6): string {
  const rows = listMemberMemories(db, memberId, limit)
    .slice()
    .reverse()
  if (!rows.length) return ''
  return `【bot 记忆（从项目同步）】\n${rows
    .map((row) => `- [${MEMORY_KIND_LABEL[row.kind as MemoryKind] ?? row.kind}] ${row.title.slice(0, 80)}（${row.project_name ?? ''}）`)
    .join('\n')}`
}

// ───────────────────────── 群聊自动发现 ─────────────────────────

export interface MemoryCandidate {
  kind: MemoryKind
  title: string
  body: string
  memberId: string | null
}

export interface ExtractContext {
  authorKind: 'human' | 'bot'
  authorId: string
  authorName: string
}

/** 顺序即优先级：一句话同时命中多个类型时，按更“值得记”的那个归类。 */
const CUES: Array<[MemoryKind, RegExp]> = [
  ['decision', /(决定|定了|敲定|拍板|确定用|结论[:：是]|采用|统一用|以后都|默认用|就这么|最终方案)/],
  ['lesson', /(教训|踩坑|注意|下次|避免|问题出在|原因是|根因|不要再|容易错)/],
  ['preference', /(偏好|喜欢|不喜欢|习惯|优先|尽量|更希望|不希望|别用|不要用|最好)/],
  ['capability', /(我会|我能|擅长|可以处理|处理流程|步骤是|工具是|方法就是|做法是)/],
  ['fact', /(口径[:：]|定义是|数据来源|阈值|统计口径|事实[:：]|发现[:：]|结论[:：]|目前实际)/],
]

function makeTitle(body: string): string {
  let title = body
    .replace(/^[@＠]\s*\S+\s*/, '')
    .replace(/^(决定|结论|注意|教训|偏好|事实|发现|口径|定义)\s*[：:，,\s]\s*/, '')
    .trim()
  if (title.length > 28) title = `${title.slice(0, 28)}…`
  if (title.length < 4) title = body.slice(0, 28)
  return title
}

/**
 * 从一条群聊消息里提取候选记忆（纯函数）。
 * 保守规则：只认关键词、句长 8–240、问句与寒暄跳过、单条最多 2 个。
 */
export function extractMemoryCandidates(text: string, ctx: ExtractContext): MemoryCandidate[] {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[@＠]\s*\S+\s*/, '')
  const sentences = clean
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const out: MemoryCandidate[] = []
  for (const body of sentences) {
    if (body.length < 8 || body.length > 240) continue
    if (/^(收到|好的|好|明白|稍等|谢谢|ok|OK|可以)[。.!！]?$/.test(body)) continue
    if (/[?？]\s*$/.test(body)) continue
    const hit = CUES.find(([kind, pattern]) => pattern.test(body) && (kind !== 'capability' || ctx.authorKind === 'bot'))
    if (!hit) continue
    out.push({
      kind: hit[0],
      title: makeTitle(body),
      body,
      memberId: hit[0] === 'capability' ? ctx.authorId : null,
    })
    if (out.length >= 2) break
  }
  return out
}
