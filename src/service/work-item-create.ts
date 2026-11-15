/**
 * 建工作项与额度记账：命令层（告警入站 / 提议采纳）与调度（schedule 物化）共用这一份。
 *
 * 抽出来的原因：建单要同时满足五个不变量——负责人必须是人、模板必须已发布、
 * `dedupe_key` 未结单唯一、项目额度未超、事件与变更游标同事务。调度如果再抄一遍，
 * 迟早出现「人建的扣额度、定时建的不扣」这种账。
 */
import type { DatabaseSync } from 'node:sqlite'
import { denied, stateInvalid } from '../domain/errors.ts'
import type { IdFactory } from '../domain/ids.ts'
import { parseReviewPolicy } from '../domain/check.ts'
import { writeChange, writeEvent } from './audit.ts'
import type { MemberKind, TemplateVersionRow, WorkItemRow } from './types.ts'

export interface WorkItemFactory {
  db: DatabaseSync
  ids: IdFactory
  now: () => number
  /** 预算按哪个时区切日/周。 */
  timeZone: string
}

export interface InsertWorkItemInput {
  domain: string
  category: string
  title: string
  ownerHumanId: string
  projectId?: string | null
  templateVersionId?: string | null
  assetId?: string | null
  dedupeKey?: string | null
  priority?: number
  dueAt?: number | null
  createdBy: string
  actorKind: MemberKind
}

export function insertWorkItem(factory: WorkItemFactory, input: InsertWorkItemInput): WorkItemRow {
  const { db } = factory
  const at = factory.now()

  const owner = db.prepare('SELECT kind FROM member WHERE id = ?').get(input.ownerHumanId) as
    | { kind: string }
    | undefined
  if (!owner) throw stateInvalid(`负责人不存在：${input.ownerHumanId}`)
  if (owner.kind !== 'human') throw denied('工作项负责人必须是人')

  let closeRequiresApproval = 1
  if (input.templateVersionId) {
    const template = db.prepare('SELECT * FROM work_template_version WHERE id = ?').get(input.templateVersionId) as
      | TemplateVersionRow
      | undefined
    if (!template) throw stateInvalid(`模板版本不存在：${input.templateVersionId}`)
    if (template.status !== 'published') throw stateInvalid(`模板版本未发布：${template.status}`)
    closeRequiresApproval = parseReviewPolicy(template.review_policy_json).autoClose ? 0 : 1
  }

  if (input.projectId) consumeBudget(factory, input.projectId, at)

  const workItemId = factory.ids()
  db.prepare(
    `INSERT INTO work_item
       (id, project_id, parent_id, template_version_id, asset_id, domain, category, title, priority, status,
        owner_human_id, assignee_id, due_at, next_action_at, check_generation, close_requires_approval,
        dedupe_key, revision, execution_epoch, fence_seq, evidence_set_hash, created_by, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, ?, NULL, 0, ?, ?, 1, 1, 0, '', ?, ?, ?)`,
  ).run(
    workItemId,
    input.projectId ?? null,
    input.templateVersionId ?? null,
    input.assetId ?? null,
    input.domain,
    input.category,
    input.title,
    input.priority ?? 0,
    input.ownerHumanId,
    input.dueAt ?? null,
    closeRequiresApproval,
    input.dedupeKey ?? null,
    input.createdBy,
    at,
    at,
  )

  const item = db.prepare('SELECT * FROM work_item WHERE id = ?').get(workItemId) as WorkItemRow
  writeEvent(db, factory.ids(), {
    workItemId,
    kind: 'work_item_created',
    actorId: input.createdBy,
    actorKind: input.actorKind,
    payload: {
      title: input.title,
      dedupeKey: input.dedupeKey ?? null,
      templateVersionId: input.templateVersionId ?? null,
    },
    revision: item.revision,
    executionEpoch: item.execution_epoch,
    at,
  })
  writeChange(db, {
    objectKind: 'work_item',
    objectId: workItemId,
    revision: item.revision,
    changeKind: 'created',
    at,
  })
  return item
}

/**
 * 建单额度：日与周是两行，各自滚动；没有额度行视为不限。
 * 条件更新 `used < limit_value` 保证并发下不会超卖（单写者其实已足够，但这样更直白）。
 */
export function consumeBudget(factory: WorkItemFactory, projectId: string, at: number): void {
  const { db } = factory
  const { dayStart, weekStart } = periodStarts(factory.timeZone, at)
  for (const [kind, start] of [
    ['day', dayStart],
    ['week', weekStart],
  ] as const) {
    const row = db
      .prepare(
        `SELECT used, limit_value FROM project_budget
          WHERE project_id = ? AND period_kind = ? AND period_start = ? AND metric = 'new_tasks'`,
      )
      .get(projectId, kind, start) as { used: number; limit_value: number } | undefined
    if (!row) continue
    if (Number(row.used) >= Number(row.limit_value)) {
      throw denied(
        `项目「${kind === 'day' ? '日' : '周'}」建单额度已用尽（${row.used}/${row.limit_value}）`,
        '调高额度或等下一个周期',
      )
    }
    const updated = db
      .prepare(
        `UPDATE project_budget SET used = used + 1
          WHERE project_id = ? AND period_kind = ? AND period_start = ? AND metric = 'new_tasks' AND used < limit_value`,
      )
      .run(projectId, kind, start)
    if (updated.changes !== 1) {
      throw denied(`项目「${kind === 'day' ? '日' : '周'}」建单额度竞争失败`, '刷新后重试')
    }
  }
}

export function periodStarts(timeZone: string, at: number): { dayStart: string; weekStart: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at))
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  const date = new Date(Date.UTC(pick('year'), pick('month') - 1, pick('day')))
  const weekday = date.getUTCDay()
  const monday = new Date(date.getTime() - ((weekday + 6) % 7) * 86_400_000)
  const format = (value: Date): string => value.toISOString().slice(0, 10)
  return { dayStart: format(date), weekStart: format(monday) }
}
