/**
 * 项目读模型与写命令的落库实现（M6）。
 *
 * 这一层只碰 `project / project_target_version / project_metric / metric_observation /
 * project_budget` 五张 P1 表，不做事务包裹与权限判断——那是 HamsService 的职责。
 * 拆出来的原因只有一个：项目详情要拼的查询比工作项多，塞进 hams.ts 会让闭环代码更难读。
 *
 * 口径纪律（backend-design §7）：
 * - 目标一旦发布就是冻结版本，改目标要发新版本，这里不允许 UPDATE project_target_version；
 * - 指标只存「预置计算器 + 参数」，不存自由表达式；读数 value=NULL 表示缺数，界面必须显示未知；
 * - 推进计数（no_progress_streak）只有 tick 写，本模块不碰。
 */
import type { DatabaseSync } from 'node:sqlite'
import { stateInvalid } from '../domain/errors.ts'
import type { IdFactory } from '../domain/ids.ts'
import { defaultCoordinatorId } from './defaults.ts'

export const PROJECT_TYPES = ['one_off', 'continuous'] as const
export const PROJECT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export const METRIC_DIRECTIONS = ['higher', 'lower', 'range'] as const
export const METRIC_WINDOWS = ['day', 'week', 'month', 'snapshot'] as const

export interface ProjectRow {
  id: string
  name: string
  type: string
  status: string
  owner_human_id: string
  coordinator_id: string | null
  goal_text: string
  current_target_version: number
  no_progress_streak: number
  revision: number
  created_at: number
  updated_at: number
  /** 软删标记：归档项目「删除」后置时间；列表与详情都不再出现。 */
  deleted_at?: number | null
  deleted_by?: string | null
}

export interface MetricInput {
  name: string
  direction: string
  targetValue?: number | null
  targetMax?: number | null
  unit?: string | null
  windowKind: string
  definitionText?: string | null
  sourceKind?: string | null
  calculatorKey?: string | null
  calculatorParams?: Record<string, unknown>
  sourceRef?: string | null
}

export interface CreateProjectInput {
  name: string
  type: string
  goalText: string
  ownerHumanId?: string
  coordinatorId?: string | null
  metrics?: MetricInput[]
  /** 默认 true：创建即发布目标（status=active）；false 则留草稿，发布动作走 project/status。 */
  publish?: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  type: string
  status: string
  owner_human_id: string
  owner_name: string | null
  coordinator_id: string | null
  coordinator_name: string | null
  goal_text: string
  current_target_version: number
  revision: number
  created_at: number
  updated_at: number
  work_items: { total: number; open: number; byStatus: Record<string, number> }
  metric_count: number
  observation_count: number
  /** 项目「记忆」页签的有效条数（不含已归档）。 */
  memory_count: number
}

export interface MetricWithLatest {
  id: string
  name: string
  direction: string
  target_value: number | null
  target_max: number | null
  unit: string | null
  definition_text: string
  calculator_key: string | null
  window_kind: string
  source_kind: string | null
  source_ref: string | null
  calculator_params_json: string
  latest: {
    value: number | null
    observed_at: number
    window_start: number
    window_end: number
    source_ref: string | null
  } | null
  series: { value: number | null; window_end: number }[]
}

export interface ProjectDetail extends ProjectSummary {
  /** 草稿的项目：向导保存到一半的内容（步骤、指标、保存时间），发布后清空。 */
  draft: ProjectDraftState | null
  target_versions: {
    id: string
    version: number
    goal_text: string
    published_by: string
    published_by_name: string | null
    published_at: number
  }[]
  current_target: {
    id: string
    version: number
    goal_text: string
    published_at: number
  } | null
  metrics: MetricWithLatest[]
  budgets: { period_kind: string; period_start: string; metric: string; used: number; limit_value: number }[]
  recent_items: {
    id: string
    title: string
    domain: string
    status: string
    owner_human_id: string
    assignee_id: string | null
    due_at: number | null
    updated_at: number
  }[]
}

const MAX_NAME = 80
const MAX_GOAL = 4000
const MAX_METRICS = 12
const MAX_METRIC_NAME = 40

function text(value: unknown, field: string, max = MAX_NAME, allowEmpty = false): string {
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!allowEmpty && !trimmed) throw stateInvalid(`${field} 不能为空`)
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function optionalText(value: unknown, field: string, max = MAX_NAME): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw stateInvalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw stateInvalid(`${field} 超过 ${max} 字`)
  return trimmed
}

function finiteNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw stateInvalid(`${field} 必须是有限数字`)
  return value
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw stateInvalid(`${field} 只能是 ${allowed.join(' / ')}`)
  }
  return value as T
}

function memberName(db: DatabaseSync, id: string | null): string | null {
  if (!id) return null
  const row = db.prepare('SELECT name FROM member WHERE id = ?').get(id) as { name: string } | undefined
  return row?.name ?? null
}

function statusMap(db: DatabaseSync, projectIds: string[]): Map<string, Record<string, number>> {
  const result = new Map<string, Record<string, number>>()
  if (!projectIds.length) return result
  const placeholders = projectIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT project_id, status, COUNT(*) AS c FROM work_item
        WHERE project_id IN (${placeholders})
        GROUP BY project_id, status`,
    )
    .all(...(projectIds as never[])) as { project_id: string; status: string; c: number }[]
  for (const row of rows) {
    const bucket = result.get(row.project_id) ?? {}
    bucket[row.status] = Number(row.c)
    result.set(row.project_id, bucket)
  }
  return result
}

export function listProjects(
  db: DatabaseSync,
  filter: { status?: string; type?: string; limit?: number; projectId?: string } = {},
): ProjectSummary[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.projectId) { clauses.push('p.id = ?'); params.push(filter.projectId) }
  if (filter.status) {
    clauses.push('p.status = ?')
    params.push(filter.status)
  }
  if (filter.type) {
    clauses.push('p.type = ?')
    params.push(filter.type)
  }
  const where = `WHERE p.deleted_at IS NULL${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200)
  const rows = db
    .prepare(
      `SELECT p.*, o.name AS owner_name, c.name AS coordinator_name,
              (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id) AS item_total,
              (SELECT COUNT(*) FROM work_item w WHERE w.project_id = p.id
                 AND w.status NOT IN ('completed','cancelled','failed')) AS item_open,
              (SELECT COUNT(*) FROM project_metric m JOIN project_target_version t ON t.id=m.version_id WHERE m.project_id = p.id AND t.version=p.current_target_version) AS metric_count,
              (SELECT COUNT(*) FROM project_metric m
                 JOIN metric_observation ob ON ob.metric_id = m.id
                WHERE m.project_id = p.id) AS observation_count,
              (SELECT COUNT(*) FROM project_memory pm
                WHERE pm.project_id = p.id AND pm.status = 'active') AS memory_count
         FROM project p
         LEFT JOIN member o ON o.id = p.owner_human_id
         LEFT JOIN member c ON c.id = p.coordinator_id
         ${where}
        ORDER BY p.updated_at DESC
        LIMIT ${limit}`,
    )
    .all(...(params as never[])) as (ProjectRow & {
    owner_name: string | null
    coordinator_name: string | null
    item_total: number
    item_open: number
    metric_count: number
    observation_count: number
    memory_count: number
  })[]

  const byProject = statusMap(db, rows.map((row) => row.id))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    owner_human_id: row.owner_human_id,
    owner_name: row.owner_name,
    coordinator_id: row.coordinator_id,
    coordinator_name: row.coordinator_name,
    goal_text: row.goal_text,
    current_target_version: Number(row.current_target_version),
    revision: Number(row.revision),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    work_items: {
      total: Number(row.item_total),
      open: Number(row.item_open),
      byStatus: byProject.get(row.id) ?? {},
    },
    metric_count: Number(row.metric_count),
    observation_count: Number(row.observation_count),
    memory_count: Number(row.memory_count),
  }))
}

export function getProject(db: DatabaseSync, projectId: string): ProjectDetail {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as ProjectRow | undefined
  if (!row) throw stateInvalid(`项目不存在：${projectId}`)
  if (row.deleted_at) throw stateInvalid('项目已删除，不再出现在工作台里', '刷新项目列表')

  const summary = listProjects(db, { projectId, limit: 1 }).find((item) => item.id === projectId)
  if (!summary) throw stateInvalid(`项目读模型缺失：${projectId}`)

  const targetVersions = db
    .prepare(
      `SELECT t.id, t.version, t.goal_text, t.published_by, t.published_at, m.name AS published_by_name
         FROM project_target_version t
         LEFT JOIN member m ON m.id = t.published_by
        WHERE t.project_id = ?
        ORDER BY t.version DESC`,
    )
    .all(projectId) as {
    id: string
    version: number
    goal_text: string
    published_by: string
    published_by_name: string | null
    published_at: number
  }[]
  const currentTarget = targetVersions.find((item) => Number(item.version) === Number(row.current_target_version)) ?? null

  const metricRows = db
    .prepare(
      `SELECT m.* FROM project_metric m
        WHERE m.project_id = ? AND m.version_id = ?
        ORDER BY m.name`,
    )
    .all(projectId, currentTarget?.id ?? '') as {
    id: string
    name: string
    direction: string
    target_value: number | null
    target_max: number | null
    unit: string | null
    definition_text: string
    calculator_key: string | null
    window_kind: string
    source_kind: string | null
    source_ref: string | null
    calculator_params_json: string
  }[]

  const observations = metricRows.length
    ? (db
        .prepare(
          `SELECT metric_id, value, observed_at, window_start, window_end, source_ref
             FROM metric_observation
            WHERE metric_id IN (${metricRows.map(() => '?').join(',')})
            ORDER BY window_end DESC, observed_at DESC, rowid DESC`,
        )
        .all(...(metricRows.map((metric) => metric.id) as never[])) as {
        metric_id: string
        value: number | null
        observed_at: number
        window_start: number
        window_end: number
        source_ref: string | null
      }[])
    : []
  const byMetric = new Map<string, typeof observations>()
  for (const observation of observations) {
    const list = byMetric.get(observation.metric_id) ?? []
    list.push(observation)
    byMetric.set(observation.metric_id, list)
  }

  const metrics: MetricWithLatest[] = metricRows.map((metric) => {
    const list = byMetric.get(metric.id) ?? []
    const latest = list[0] ?? null
    return {
      id: metric.id,
      name: metric.name,
      direction: metric.direction,
      target_value: metric.target_value === null ? null : Number(metric.target_value),
      target_max: metric.target_max === null ? null : Number(metric.target_max),
      unit: metric.unit,
      definition_text: metric.definition_text,
      calculator_key: metric.calculator_key,
      window_kind: metric.window_kind,
      source_kind: metric.source_kind,
      source_ref: metric.source_ref,
      calculator_params_json: metric.calculator_params_json,
      latest: latest
        ? {
            value: latest.value === null ? null : Number(latest.value),
            observed_at: Number(latest.observed_at),
            window_start: Number(latest.window_start),
            window_end: Number(latest.window_end),
            source_ref: latest.source_ref,
          }
        : null,
      series: list
        .slice(0, 12)
        .reverse()
        .map((item) => ({ value: item.value === null ? null : Number(item.value), window_end: Number(item.window_end) })),
    }
  })

  const budgets = db
    .prepare(
      `SELECT period_kind, period_start, metric, used, limit_value
         FROM project_budget WHERE project_id = ?
        ORDER BY period_start DESC, metric LIMIT 40`,
    )
    .all(projectId) as ProjectDetail['budgets']

  const recentItems = db
    .prepare(
      `SELECT id, title, domain, status, owner_human_id, assignee_id, due_at, updated_at
         FROM work_item WHERE project_id = ?
        ORDER BY updated_at DESC LIMIT 8`,
    )
    .all(projectId) as ProjectDetail['recent_items']

  return {
    ...summary,
    draft: row.status === 'draft' ? readProjectDraft(db, projectId) : null,
    target_versions: targetVersions.map((item) => ({
      ...item,
      version: Number(item.version),
      published_at: Number(item.published_at),
    })),
    current_target: currentTarget
      ? {
          id: currentTarget.id,
          version: Number(currentTarget.version),
          goal_text: currentTarget.goal_text,
          published_at: Number(currentTarget.published_at),
        }
      : null,
    metrics,
    budgets: budgets.map((item) => ({
      ...item,
      used: Number(item.used),
      limit_value: Number(item.limit_value),
    })),
    recent_items: recentItems.map((item) => ({
      ...item,
      due_at: item.due_at === null ? null : Number(item.due_at),
      updated_at: Number(item.updated_at),
    })),
  }
}

export interface InsertedProject {
  id: string
  revision: number
  targetVersionId: string | null
}

export function insertProject(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  actorId: string,
  input: CreateProjectInput,
): InsertedProject {
  const name = text(input.name, '项目名')
  const type = oneOf(input.type, '项目类型', PROJECT_TYPES)
  const publish = input.publish !== false
  // 草稿向导可以在只填了名称时保存，所以草稿允许空目标；发布目标时仍由 publishTarget 校验。
  const goalText = text(input.goalText ?? '', '目标', MAX_GOAL, !publish)
  const ownerHumanId = input.ownerHumanId ?? actorId
  // 没显式选推进 bot 时用默认的「项目管理」；显式 null 表示这个项目不要推进 bot。
  const coordinatorId =
    input.coordinatorId === undefined
      ? defaultCoordinatorId(db)
      : input.coordinatorId === null || input.coordinatorId === ''
        ? null
        : text(input.coordinatorId, '推进 bot', 64)

  const duplicate = db
    .prepare('SELECT id FROM project WHERE name = ? AND deleted_at IS NULL')
    .get(name) as { id: string } | undefined
  if (duplicate) {
    throw stateInvalid(`项目名已存在：${name}`, '换一个名字，或打开已有项目')
  }

  const owner = db.prepare('SELECT id, kind FROM member WHERE id = ?').get(ownerHumanId) as
    | { id: string; kind: string }
    | undefined
  if (!owner || owner.kind !== 'human') throw stateInvalid('项目负责人必须是存在的人')
  if (coordinatorId) {
    const coordinator = db.prepare('SELECT id, kind FROM member WHERE id = ?').get(coordinatorId) as
      | { id: string; kind: string }
      | undefined
    if (!coordinator) throw stateInvalid(`推进成员不存在：${coordinatorId}`)
  }

  const metrics = Array.isArray(input.metrics) ? input.metrics : []
  if (metrics.length > MAX_METRICS) throw stateInvalid(`指标最多 ${MAX_METRICS} 个`)

  const id = ids()
  const status = publish ? 'active' : 'draft'

  db.prepare(
    `INSERT INTO project
       (id, name, type, status, owner_human_id, coordinator_id, goal_text,
        current_target_version, no_progress_streak, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
  ).run(id, name, type, status, ownerHumanId, coordinatorId, goalText, now, now)

  let targetVersionId: string | null = null
  if (publish) {
    targetVersionId = ids()
    db.prepare(
      `INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(targetVersionId, id, goalText, actorId, now)
    db.prepare('UPDATE project SET current_target_version = 1 WHERE id = ?').run(id)
    for (const metric of metrics) insertMetric(db, ids, id, targetVersionId, metric)
  }

  return { id, revision: 1, targetVersionId }
}

export function insertMetric(
  db: DatabaseSync,
  ids: IdFactory,
  projectId: string,
  versionId: string,
  input: MetricInput,
): string {
  const name = text(input.name, '指标名', MAX_METRIC_NAME)
  const direction = oneOf(input.direction, '指标方向', METRIC_DIRECTIONS)
  const windowKind = oneOf(input.windowKind, '统计窗口', METRIC_WINDOWS)
  const targetValue = finiteNumber(input.targetValue, '目标值')
  const targetMax = finiteNumber(input.targetMax, '上界')
  const unit = optionalText(input.unit, '单位', 20)
  const definitionText = optionalText(input.definitionText, '口径说明', 500) ?? ''
  const sourceKind = input.sourceKind
    ? oneOf(input.sourceKind, '数据来源', ['ledger', 'work_item', 'webhook', 'manual'] as const)
    : 'manual'
  if (direction === 'range' && (targetValue === null || targetMax === null)) {
    throw stateInvalid('区间指标要同时给下界与上界')
  }
  if (direction !== 'range' && targetValue === null) {
    throw stateInvalid('非区间指标要给目标值')
  }
  if (direction === 'range' && targetMax! < targetValue!) throw stateInvalid('区间上界不能小于下界')
  const calculatorKey = optionalText(input.calculatorKey, '计算方式', 80)
  if (calculatorKey && !['manual_latest', 'work_item_count', 'work_item_completion_rate'].includes(calculatorKey)) throw stateInvalid('未知的预置计算方式')
  if (calculatorKey === 'manual_latest' && sourceKind !== 'manual') throw stateInvalid('manual_latest 需要 manual 来源')
  if (calculatorKey?.startsWith('work_item_') && sourceKind !== 'work_item') throw stateInvalid('工作项计算器需要 work_item 来源')
  const params = input.calculatorParams ?? {}
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['domain', 'status'].includes(key)) || Object.values(params).some(value => typeof value !== 'string')) throw stateInvalid('计算器参数仅支持 domain / status 字符串筛选')
  const sourceRef = optionalText(input.sourceRef, '数据来源引用', 500)
  const id = ids()
  db.prepare(
    `INSERT INTO project_metric
       (id, project_id, version_id, name, direction, target_value, target_max, unit,
        definition_text, calculator_key, calculator_params_json, window_kind, source_kind, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, versionId, name, direction, targetValue, targetMax, unit, definitionText, calculatorKey, JSON.stringify(params), windowKind, sourceKind, sourceRef)
  return id
}

export interface StatusChange {
  before: string
  after: string
  revision: number
  targetVersionId: string | null
}

/** 状态机：draft → active（发布目标）→ paused ⇄ active；任一状态可归档，归档不删数据。 */
export function setProjectStatus(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  actorId: string,
  projectId: string,
  to: string,
): StatusChange {
  const project = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as ProjectRow | undefined
  if (!project) throw stateInvalid(`项目不存在：${projectId}`)
  if (project.deleted_at) throw stateInvalid('项目已删除，不能再改状态')
  const target = oneOf(to, '项目状态', PROJECT_STATUSES)
  const before = project.status
  if (before === target) return { before, after: target, revision: Number(project.revision), targetVersionId: null }
  const allowed: Record<string, string[]> = {
    draft: ['active', 'archived'],
    active: ['paused', 'archived'],
    paused: ['active', 'archived'],
    archived: [],
  }
  if (!allowed[before]?.includes(target)) {
    throw stateInvalid(`项目状态不能从 ${before} 改为 ${target}`, '归档后只能新建项目；草稿要先发布目标')
  }

  let targetVersionId: string | null = null
  if (target === 'active' && Number(project.current_target_version) === 0) {
    const goal = String(project.goal_text ?? '').trim()
    if (!goal) throw stateInvalid('没有目标口径的项目不能进入进行中', '先写目标，再发布')
    targetVersionId = ids()
    db.prepare(
      `INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(targetVersionId, projectId, goal, actorId, now)
    db.prepare('UPDATE project SET current_target_version = 1 WHERE id = ?').run(projectId)
  }

  const revision = Number(project.revision) + 1
  db.prepare('UPDATE project SET status = ?, revision = ?, updated_at = ? WHERE id = ?').run(target, revision, now, projectId)
  return { before, after: target, revision, targetVersionId }
}

export interface ObservationInput {
  projectId: string
  metricId: string
  value?: number | null
  observedAt?: number
  windowStart?: number
  windowEnd?: number
  sourceRef?: string | null
}

export interface InsertedObservation {
  id: string
  metricId: string
  windowStart: number
  windowEnd: number
  value: number | null
}

const WINDOW_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  snapshot: 0,
}

export function recordObservation(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  input: ObservationInput,
): InsertedObservation {
  const metric = db
    .prepare(
      `SELECT m.id, m.window_kind, m.project_id FROM project_metric m WHERE m.id = ? AND m.project_id = ?`,
    )
    .get(input.metricId, input.projectId) as { id: string; window_kind: string; project_id: string } | undefined
  if (!metric) throw stateInvalid(`指标不属于该项目：${input.metricId}`)

  const observedAt = input.observedAt === undefined ? now : finiteNumber(input.observedAt, '观测时间')
  if (observedAt === null) throw stateInvalid('观测时间必须给值')
  const value = input.value === undefined ? null : finiteNumber(input.value, '读数')
  const span = WINDOW_MS[metric.window_kind] ?? 0
  const windowEnd = input.windowEnd === undefined ? observedAt : finiteNumber(input.windowEnd, '窗口结束')
  if (windowEnd === null) throw stateInvalid('窗口结束必须给值')
  const windowStart =
    input.windowStart === undefined
      ? metric.window_kind === 'snapshot'
        ? windowEnd
        : windowEnd - span
      : finiteNumber(input.windowStart, '窗口开始')
  if (windowStart === null) throw stateInvalid('窗口开始必须给值')
  if (windowStart > windowEnd) throw stateInvalid('窗口开始不能晚于结束')

  const sourceRef = optionalText(input.sourceRef, '数据引用', 500)
  const id = ids()
  db.prepare(
    `INSERT INTO metric_observation (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, metric.id, observedAt, windowStart, windowEnd, value, sourceRef, now)
  db.prepare('UPDATE project SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, input.projectId)
  return { id, metricId: metric.id, windowStart, windowEnd, value }
}

// ───────────────────────── 新建向导草稿 ─────────────────────────

/**
 * 向导草稿：项目已经是 draft，但向导还可能只填到第 2 步。
 * 步骤与指标（含未发布的试算结果）存在 `hams_meta` 的 `project:draft:<id>` 里，
 * 不改表结构，也不把未发布的指标塞进 `project_metric`（那张表只属于已发布版本）。
 */
export interface ProjectDraftState {
  step: number
  metrics: MetricInput[]
  savedAt: number
  savedBy: string
}

export interface SaveDraftInput {
  projectId?: string | null
  name: string
  type: string
  goalText?: string
  coordinatorId?: string | null
  metrics?: MetricInput[]
  step?: number
}

const DRAFT_KEY_PREFIX = 'project:draft:'
const MAX_DRAFT_STEP = 4

function draftKey(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}${projectId}`
}

function sanitizeDraftMetrics(input: unknown): MetricInput[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, MAX_METRICS).map((raw) => {
    const metric = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const direction = (METRIC_DIRECTIONS as readonly string[]).includes(String(metric.direction))
      ? (metric.direction as (typeof METRIC_DIRECTIONS)[number])
      : 'higher'
    const windowKind = (METRIC_WINDOWS as readonly string[]).includes(String(metric.windowKind))
      ? (metric.windowKind as (typeof METRIC_WINDOWS)[number])
      : 'week'
    const numberOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null
    return {
      name: String(metric.name ?? '').slice(0, MAX_METRIC_NAME),
      direction,
      targetValue: numberOrNull(metric.targetValue),
      targetMax: numberOrNull(metric.targetMax),
      unit: typeof metric.unit === 'string' ? metric.unit.slice(0, 20) : null,
      windowKind,
      definitionText: typeof metric.definitionText === 'string' ? metric.definitionText.slice(0, 500) : null,
      sourceKind:
        typeof metric.sourceKind === 'string' && ['ledger', 'work_item', 'webhook', 'manual'].includes(metric.sourceKind)
          ? metric.sourceKind
          : 'manual',
      calculatorKey: typeof metric.calculatorKey === 'string' ? metric.calculatorKey.slice(0, 80) : null,
      calculatorParams:
        metric.calculatorParams && typeof metric.calculatorParams === 'object' && !Array.isArray(metric.calculatorParams)
          ? (metric.calculatorParams as Record<string, unknown>)
          : {},
      sourceRef: typeof metric.sourceRef === 'string' ? metric.sourceRef.slice(0, 500) : null,
    }
  })
}

export function readProjectDraft(db: DatabaseSync, projectId: string): ProjectDraftState | null {
  const row = db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(draftKey(projectId)) as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<ProjectDraftState>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      step: Math.min(Math.max(Number(parsed.step) || 0, 0), MAX_DRAFT_STEP),
      metrics: sanitizeDraftMetrics(parsed.metrics),
      savedAt: Number(parsed.savedAt) || 0,
      savedBy: String(parsed.savedBy || ''),
    }
  } catch {
    return null
  }
}

export function clearProjectDraft(db: DatabaseSync, projectId: string): void {
  db.prepare('DELETE FROM hams_meta WHERE key = ?').run(draftKey(projectId))
}

export interface SavedProjectDraft {
  projectId: string
  revision: number
  created: boolean
  savedAt: number
  step: number
}

/**
 * 保存/更新新建向导草稿。新建时项目就是 draft；更新只允许改 draft，
 * 已发布/暂停/归档的项目必须走正式的项目编辑路径。
 */
export function saveProjectDraft(
  db: DatabaseSync,
  ids: IdFactory,
  now: number,
  actorId: string,
  input: SaveDraftInput,
): SavedProjectDraft {
  const step = Math.min(Math.max(Number(input.step) || 0, 0), MAX_DRAFT_STEP)
  const metrics = sanitizeDraftMetrics(input.metrics)

  let projectId = optionalText(input.projectId, '项目 id', 64)
  let created = false
  let revision: number

  if (!projectId) {
    const inserted = insertProject(db, ids, now, actorId, {
      name: input.name,
      type: input.type,
      goalText: input.goalText ?? '',
      coordinatorId: input.coordinatorId,
      metrics: [],
      publish: false,
    })
    projectId = inserted.id
    revision = inserted.revision
    created = true
  } else {
    const row = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as ProjectRow | undefined
    if (!row) throw stateInvalid(`项目不存在：${projectId}`)
    if (row.deleted_at) throw stateInvalid('项目已删除，不能再保存草稿')
    if (row.status !== 'draft') throw stateInvalid('只有草稿项目能在新建向导里继续修改', '已发布项目请发布新目标版本')

    const name = text(input.name, '项目名')
    const type = oneOf(input.type, '项目类型', PROJECT_TYPES)
    const goalText = text(input.goalText ?? '', '目标', MAX_GOAL, true)
    const coordinatorId =
      input.coordinatorId === undefined
        ? row.coordinator_id
        : input.coordinatorId === null || input.coordinatorId === ''
          ? null
          : text(input.coordinatorId, '推进 bot', 64)
    if (coordinatorId) {
      const coordinator = db.prepare('SELECT id FROM member WHERE id = ?').get(coordinatorId) as { id: string } | undefined
      if (!coordinator) throw stateInvalid(`推进成员不存在：${coordinatorId}`)
    }
    const duplicate = db
      .prepare('SELECT id FROM project WHERE name = ? AND id <> ? AND deleted_at IS NULL')
      .get(name, projectId) as { id: string } | undefined
    if (duplicate) throw stateInvalid(`项目名已存在：${name}`, '换一个名字，或打开已有项目')

    revision = Number(row.revision) + 1
    db.prepare(
      'UPDATE project SET name = ?, type = ?, goal_text = ?, coordinator_id = ?, revision = ?, updated_at = ? WHERE id = ?',
    ).run(name, type, goalText, coordinatorId, revision, now, projectId)
  }

  const state: ProjectDraftState = { step, metrics, savedAt: now, savedBy: actorId }
  db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)").run(draftKey(projectId), JSON.stringify(state))
  return { projectId, revision, created, savedAt: now, step }
}

// ───────────────────────── 归档项目删除 ─────────────────────────

export interface DeletedProject {
  id: string
  revision: number
  detachedWorkItems: number
}

/**
 * 「删除」归档项目：只打软删标记，列表/详情/群聊不再出现；
 * 工作项解绑为「无项目」继续留在任务里（证据与审计不删，符合库的追加式约束）。
 */
export function softDeleteProject(
  db: DatabaseSync,
  now: number,
  actorId: string,
  projectId: string,
): DeletedProject {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as ProjectRow | undefined
  if (!row) throw stateInvalid(`项目不存在：${projectId}`)
  if (row.deleted_at) throw stateInvalid('项目已经删除')
  if (row.status !== 'archived') throw stateInvalid('只有已归档的项目可以删除', '先归档项目，再删除')
  // work_item 的 revision 只能向前：解绑也必须 +1，否则被 trg_wi_counters_monotonic 拒绝。
  const detached = db.prepare('UPDATE work_item SET project_id = NULL, revision = revision + 1 WHERE project_id = ?').run(projectId)
  const revision = Number(row.revision) + 1
  // project.name 有 UNIQUE 约束：软删也把名字换成墓碑，原名保留在 deleted_name，名字可再次使用。
  const tombstone = `${row.name}·已删除·${projectId.slice(-6)}`
  db.prepare(
    'UPDATE project SET deleted_at = ?, deleted_by = ?, deleted_name = ?, name = ?, revision = ?, updated_at = ? WHERE id = ?',
  ).run(now, actorId, row.name, tombstone, revision, now, projectId)
  clearProjectDraft(db, projectId)
  return { id: projectId, revision, detachedWorkItems: Number(detached.changes ?? 0) }
}
