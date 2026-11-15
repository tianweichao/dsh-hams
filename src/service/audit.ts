/**
 * 审计、时间线与变更游标。
 *
 * 三者都只追加：`audit_log` 与 `work_item_event` 有触发器禁止 UPDATE；`change_log`
 * 靠自增 seq 生成界面游标。任何写命令都应当在这三张表里留下痕迹——顺序固定：
 * 先改业务行，再写事件 / 变更 / 审计（同一事务内，失败一起回滚）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Channel, MemberKind } from './types.ts'

export interface AuditEntry {
  actorId: string
  actorKind: MemberKind
  onBehalfOf?: string | null
  channel: Channel
  authSubject?: string | null
  hostPreset?: string | null
  action: string
  subjectKind: string
  subjectId: string
  before?: unknown
  after?: unknown
  correlationId: string
  at: number
}

export function writeAudit(db: DatabaseSync, id: string, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log
       (id, actor_id, actor_kind, on_behalf_of, channel, auth_subject, host_preset,
        action, subject_kind, subject_id, before_json, after_json, correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.actorId,
    entry.actorKind,
    entry.onBehalfOf ?? null,
    entry.channel,
    entry.authSubject ?? null,
    entry.hostPreset ?? null,
    entry.action,
    entry.subjectKind,
    entry.subjectId,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.correlationId,
    entry.at,
  )
}

export interface EventEntry {
  workItemId: string
  kind: string
  actorId: string
  actorKind: MemberKind
  payload?: Record<string, unknown>
  revision: number
  executionEpoch: number
  at: number
}

export function writeEvent(db: DatabaseSync, id: string, entry: EventEntry): void {
  db.prepare(
    `INSERT INTO work_item_event
       (id, work_item_id, kind, actor_id, actor_kind, payload_json, revision, execution_epoch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.workItemId,
    entry.kind,
    entry.actorId,
    entry.actorKind,
    JSON.stringify(entry.payload ?? {}),
    entry.revision,
    entry.executionEpoch,
    entry.at,
  )
}

export interface ChangeEntry {
  objectKind: string
  objectId: string
  revision: number
  changeKind: string
  at: number
}

export function writeChange(db: DatabaseSync, entry: ChangeEntry): void {
  db.prepare(
    `INSERT INTO change_log (object_kind, object_id, revision, change_kind, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(entry.objectKind, entry.objectId, entry.revision, entry.changeKind, entry.at)
}
