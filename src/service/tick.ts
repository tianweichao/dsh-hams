/**
 * 调度与恢复（M4）。
 *
 * 两个入口：
 * - `runTick(db, opts)`：5 秒一拍的唯一业务调度权威。每步一个 `BEGIN IMMEDIATE`，
 *   单步失败不中断其余；一拍总量有上限（默认 50）。
 * - `recover(db, opts)`：宿主启动时按 `runtime_epoch` 对账，只收拾「上个进程留下的」，
 *   不碰业务代次。run 的 queued→cancelled、running→orphaned，outbox 的 sending→unknown。
 *
 * 与设计的偏差：
 * - 审批过期只置 expired，**不生成 attention_item**：`attention_item.reason` 枚举里没有
 *   `approval_expired`，硬塞 `no_progress` 会污染「为什么需要人关注」的语义；
 * - 到期复查起运行需要「同工作项同 bot 的 active 线程」；没有线程就记 missed + 关注项，
 *   不凭空造会话（会话由宿主创建，属于 M5 的适配器）；
 * - 复查的漏跑策略按模板 `misfire_policy` 做了最小实现：`skip` 直接记账，`catch_up_latest`
 *   同一工作项只补最新一条，其余取消；
 * - outbox 发送需要连接器；没注入 `sendOutbox` 时只统计「待发送」，绝不假装发过。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createIdFactory, type IdFactory } from '../domain/ids.ts'
import { wallToUtc } from '../domain/check.ts'
import { writeChange, writeEvent } from './audit.ts'
import { insertWorkItem } from './work-item-create.ts'
import type { CheckRow, WorkItemRow } from './types.ts'
import { existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export interface TickOptions {
  db: DatabaseSync
  runtimeEpoch: number
  now?: () => number
  ids?: IdFactory
  maxItems?: number
  timeZone?: string
  dataDir?: string
  evidenceRetentionDays?: number
  /** 注入后才真正发送出站动作；未注入时只统计待发送，不假装成功。 */
  sendOutbox?: OutboxSender
}

export type OutboxSender = (row: {
  id: string
  action: string
  payloadJson: string
  idempotencyKey: string
  attempts: number
}) => { status: 'sent' | 'failed' | 'unknown'; externalRef?: string; error?: string }

export interface TickReport {
  tickSeq: number
  runtimeEpoch: number
  startedAt: number
  finishedAt: number
  fired: number
  steps: {
    expiredApprovals: number
    reclaimedLeases: number
    queuedCheckRuns: number
    missedChecks: number
    cancelledChecks: number
    firedSchedules: number
    scheduledWorkItems: number
    outboxSent: number
    outboxFailed: number
    outboxUnknown: number
    outboxPending: number
    rollupRows: number
    purgedEvidence: number
  }
  errors: string[]
}

export interface RecoverReport {
  runtimeEpoch: number
  startedAt: number
  finishedAt: number
  cancelledQueuedRuns: number
  orphanedRunningRuns: number
  outboxUnknown: number
  expiredApprovals: number
  missedChecks: number
  tickSeq: number
}

const DEFAULT_MAX_ITEMS = 50
const DEFAULT_TZ = 'Asia/Shanghai'
const DEFAULT_RETENTION_DAYS = 365
const OPEN_DEDUPE_STATUSES = ['ready', 'active', 'waiting_check', 'waiting_review', 'blocked', 'paused', 'failed']

interface StepBag {
  errors: string[]
}

function rollbackIfNeeded(db: DatabaseSync): void {
  if (db.isTransaction) db.exec('ROLLBACK')
}

function runStep<T>(db: DatabaseSync, bag: StepBag, name: string, fn: () => T): T | null {
  rollbackIfNeeded(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    rollbackIfNeeded(db)
    bag.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function attention(
  db: DatabaseSync,
  ids: IdFactory,
  input: {
    workItemId?: string | null
    projectId?: string | null
    reason: 'orphaned_run' | 'retries_exhausted' | 'no_progress' | 'severity_raised' | 'outbox_unknown' | 'missed_check'
    detail: string
    toMemberId: string
    at: number
  },
): void {
  db.prepare(
    `INSERT INTO attention_item (id, work_item_id, project_id, reason, detail, to_member_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ids(),
    input.workItemId ?? null,
    input.projectId ?? null,
    input.reason,
    input.detail,
    input.toMemberId,
    input.at,
  )
}

function humanOwnerOf(db: DatabaseSync, workItemId: string | null | undefined): string | null {
  if (!workItemId) return null
  const row = db
    .prepare(
      `SELECT w.owner_human_id AS owner, m.kind AS kind
         FROM work_item w JOIN member m ON m.id = w.owner_human_id
        WHERE w.id = ?`,
    )
    .get(workItemId) as { owner: string; kind: string } | undefined
  return row && row.kind === 'human' ? row.owner : null
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  )
}

export function readRuntimeEpoch(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get() as
    | { value: string }
    | undefined
  return Number(row?.value ?? 0)
}

function parseInterval(spec: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(spec.trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2]
  const factor = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return value * factor
}

export function recover(options: TickOptions): RecoverReport {
  const db = options.db
  const now = options.now ?? (() => Date.now())
  const ids = options.ids ?? createIdFactory(now)
  const runtimeEpoch = options.runtimeEpoch
  const startedAt = now()
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS
  const bag: StepBag = { errors: [] }

  const runs = runStep(db, bag, 'recover-runs', () => {
    const stale = db
      .prepare(
        `SELECT id, work_item_id, status, member_id FROM task_run
          WHERE runtime_epoch < ? AND status IN ('queued','running')
          LIMIT ?`,
      )
      .all(runtimeEpoch, max) as { id: string; work_item_id: string; status: string; member_id: string }[]
    let cancelled = 0
    let orphaned = 0
    for (const run of stale) {
      // 租约也要收：否则租约还占着 work_item 主键，新的认领会撞 lease 的唯一约束。
      db.prepare('DELETE FROM lease WHERE run_id = ?').run(run.id)
      if (run.status === 'queued') {
        db.prepare("UPDATE task_run SET status = 'cancelled', finished_at = ?, error_kind = 'host_restart_before_start' WHERE id = ?").run(startedAt, run.id)
        cancelled += 1
      } else {
        db.prepare("UPDATE task_run SET status = 'orphaned', finished_at = ?, error_kind = 'host_restart_during_run' WHERE id = ?").run(startedAt, run.id)
        orphaned += 1
        const owner = humanOwnerOf(db, run.work_item_id)
        if (owner) {
          attention(db, ids, {
            workItemId: run.work_item_id,
            reason: 'orphaned_run',
            detail: `宿主重启时运行 ${run.id} 仍在执行，已标孤儿，需人工核对是否已产生外部副作用`,
            toMemberId: owner,
            at: startedAt,
          })
        }
      }
    }
    return { cancelled, orphaned }
  })

  const outbox = runStep(db, bag, 'recover-outbox', () => {
    const sending = db
      .prepare("SELECT id, work_item_id, requested_by, action FROM outbox WHERE status = 'sending' LIMIT ?")
      .all(max) as { id: string; work_item_id: string | null; requested_by: string; action: string }[]
    let unknown = 0
    for (const row of sending) {
      db.prepare("UPDATE outbox SET status = 'unknown', last_error = 'host_restart_during_send' WHERE id = ?").run(row.id)
      unknown += 1
      const requesterIsHuman = (db.prepare('SELECT kind FROM member WHERE id = ?').get(row.requested_by) as { kind: string } | undefined)?.kind === 'human'
      const to = humanOwnerOf(db, row.work_item_id) ?? (requesterIsHuman ? row.requested_by : null)
      if (to) {
        attention(db, ids, {
          workItemId: row.work_item_id,
          reason: 'outbox_unknown',
          detail: `出站动作 ${row.action}（${row.id}）发送结果未知，需对账，不要直接重发`,
          toMemberId: to,
          at: startedAt,
        })
      }
    }
    return unknown
  })

  const approvals = runStep(db, bag, 'recover-approvals', () => {
    const expired = db
      .prepare("UPDATE approval SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
      .run(startedAt)
    return Number(expired.changes)
  })

  const missed = runStep(db, bag, 'recover-checks', () => {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM work_item_check WHERE status = 'scheduled' AND planned_due_at <= ?")
      .get(startedAt) as { c: number }
    return Number(row.c)
  })

  const finishedAt = now()
  const report: RecoverReport = {
    runtimeEpoch,
    startedAt,
    finishedAt,
    cancelledQueuedRuns: runs?.cancelled ?? 0,
    orphanedRunningRuns: runs?.orphaned ?? 0,
    outboxUnknown: outbox ?? 0,
    expiredApprovals: approvals ?? 0,
    missedChecks: missed ?? 0,
    tickSeq: 0,
  }

  const logged = runStep(db, bag, 'recover-log', () => {
    db.prepare(
      `INSERT INTO tick_log (runtime_epoch, started_at, finished_at, fired, recovered, error_text)
       VALUES (?, ?, ?, 0, 1, ?)`,
    ).run(runtimeEpoch, startedAt, finishedAt, bag.errors.length ? bag.errors.join('; ') : null)
    return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
  })
  report.tickSeq = logged ?? 0
  return report
}

export function runTick(options: TickOptions): TickReport {
  const db = options.db
  const now = options.now ?? (() => Date.now())
  const ids = options.ids ?? createIdFactory(now)
  const runtimeEpoch = options.runtimeEpoch ?? readRuntimeEpoch(db)
  const timeZone = options.timeZone ?? DEFAULT_TZ
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS
  const startedAt = now()
  const bag: StepBag = { errors: [] }

  const steps: TickReport['steps'] = {
    expiredApprovals: 0,
    reclaimedLeases: 0,
    queuedCheckRuns: 0,
    missedChecks: 0,
    cancelledChecks: 0,
    firedSchedules: 0,
    scheduledWorkItems: 0,
    outboxSent: 0,
    outboxFailed: 0,
    outboxUnknown: 0,
    outboxPending: 0,
    rollupRows: 0,
    purgedEvidence: 0,
  }

  // 1. 审批过期只失效：没有自动通过、没有上报。
  const expired = runStep(db, bag, 'expire-approvals', () => {
    const result = db
      .prepare("UPDATE approval SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
      .run(startedAt)
    return Number(result.changes)
  })
  steps.expiredApprovals = expired ?? 0

  // 2. 回收过期租约：运行结果未知，标 unknown，不自动重跑。
  const leases = runStep(db, bag, 'reclaim-leases', () => {
    const rows = db
      .prepare('SELECT work_item_id, run_id FROM lease WHERE lease_until <= ? LIMIT ?')
      .all(startedAt, max) as { work_item_id: string; run_id: string }[]
    for (const row of rows) {
      db.prepare('DELETE FROM lease WHERE work_item_id = ?').run(row.work_item_id)
      db.prepare("UPDATE task_run SET status = 'unknown', finished_at = ?, error_kind = 'lease_expired' WHERE id = ? AND status = 'running'").run(startedAt, row.run_id)
    }
    return rows.length
  })
  steps.reclaimedLeases = leases ?? 0

  // 3. 到期复查：按 misfire_policy 处理，没有 active 线程就记 missed。
  const checks = runStep(db, bag, 'due-checks', () => {
    const due = db
      .prepare(
        `SELECT c.*, v.misfire_policy AS misfire_policy
           FROM work_item_check c
           LEFT JOIN work_template_version v ON v.id = c.template_version_id
          WHERE c.status = 'scheduled' AND c.planned_due_at <= ?
          ORDER BY c.work_item_id, c.planned_due_at
          LIMIT ?`,
      )
      .all(startedAt, max * 2) as (CheckRow & { misfire_policy: string | null })[]

    // catch_up_latest：同一工作项只补最新一条，其余取消。
    const latestByItem = new Map<string, string>()
    for (const check of due) {
      if ((check.misfire_policy ?? 'each') !== 'catch_up_latest') continue
      const current = latestByItem.get(check.work_item_id)
      if (!current || (db.prepare('SELECT planned_due_at FROM work_item_check WHERE id = ?').get(current) as { planned_due_at: number }).planned_due_at < check.planned_due_at) {
        latestByItem.set(check.work_item_id, check.id)
      }
    }

    let queuedRuns = 0
    let missed = 0
    let cancelled = 0
    for (const check of due) {
      const policy = check.misfire_policy ?? 'each'
      const item = db.prepare('SELECT * FROM work_item WHERE id = ?').get(check.work_item_id) as WorkItemRow | undefined
      if (!item || ['completed', 'cancelled', 'failed'].includes(item.status)) {
        db.prepare("UPDATE work_item_check SET status = 'cancelled' WHERE id = ?").run(check.id)
        cancelled += 1
        continue
      }
      if (policy === 'catch_up_latest' && latestByItem.get(item.id) !== check.id) {
        db.prepare("UPDATE work_item_check SET status = 'cancelled' WHERE id = ?").run(check.id)
        cancelled += 1
        continue
      }
      if (policy === 'skip') {
        db.prepare("UPDATE work_item_check SET status = 'unknown', evaluated_at = ? WHERE id = ?").run(startedAt, check.id)
        const owner = humanOwnerOf(db, item.id)
        if (owner) {
          attention(db, ids, {
            workItemId: item.id,
            reason: 'missed_check',
            detail: `复查 ${check.id} 到期但模板策略为 skip，未执行`,
            toMemberId: owner,
            at: startedAt,
          })
        }
        missed += 1
        continue
      }
      if (item.status === 'waiting_review' || item.status === 'paused') continue
      const thread = db
        .prepare(
          `SELECT * FROM work_item_thread
            WHERE work_item_id = ? AND member_id = ? AND status = 'active'
            ORDER BY generation DESC LIMIT 1`,
        )
        .get(item.id, item.assignee_id ?? '') as { id: string; member_id: string; member_version: number } | undefined
      const activeRun = db
        .prepare("SELECT 1 FROM task_run WHERE work_item_id = ? AND status IN ('queued','running')")
        .get(item.id)
      if (!thread || !item.assignee_id || activeRun) {
        db.prepare("UPDATE work_item_check SET status = 'unknown', evaluated_at = ? WHERE id = ?").run(startedAt, check.id)
        const owner = humanOwnerOf(db, item.id)
        if (owner) {
          attention(db, ids, {
            workItemId: item.id,
            reason: 'missed_check',
            detail: thread
              ? `复查 ${check.id} 到期，但该工作项已有活跃运行，未重复起跑`
              : `复查 ${check.id} 到期，但工作项没有在用的会话线程，无法起运行`,
            toMemberId: owner,
            at: startedAt,
          })
        }
        missed += 1
        continue
      }

      const fenceRow = db
        .prepare('SELECT fence_seq FROM work_item WHERE id = ?')
        .get(item.id) as { fence_seq: number }
      const fence = Number(fenceRow.fence_seq) + 1
      const runId = ids()
      db.prepare(
        `UPDATE work_item SET fence_seq = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).run(fence, startedAt, item.id)
      db.prepare(
        `INSERT INTO task_run
           (id, work_item_id, thread_id, check_id, member_id, member_version, skill_versions_json,
            execution_epoch, runtime_epoch, fence, trigger, attempt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'check', 1, 'queued', ?)`,
      ).run(
        runId,
        item.id,
        thread.id,
        check.id,
        item.assignee_id,
        thread.member_version,
        item.execution_epoch,
        runtimeEpoch,
        fence,
        startedAt,
      )
      db.prepare("UPDATE work_item_check SET status = 'running' WHERE id = ?").run(check.id)
      const after = db.prepare('SELECT revision FROM work_item WHERE id = ?').get(item.id) as { revision: number }
      writeEvent(db, ids(), {
        workItemId: item.id,
        kind: 'check_run_queued',
        actorId: 'system',
        actorKind: 'system',
        payload: { checkId: check.id, runId, fence },
        revision: after.revision,
        executionEpoch: item.execution_epoch,
        at: startedAt,
      })
      writeChange(db, { objectKind: 'task_run', objectId: runId, revision: 1, changeKind: 'check_run_queued', at: startedAt })
      queuedRuns += 1
    }
    return { queuedRuns, missed, cancelled }
  })
  steps.queuedCheckRuns = checks?.queuedRuns ?? 0
  steps.missedChecks = checks?.missed ?? 0
  steps.cancelledChecks = checks?.cancelled ?? 0

  // 4. 到期 schedule：先插 occurrence（主键防双触发），再物化工作项。
  const schedules = runStep(db, bag, 'due-schedules', () => {
    const due = db
      .prepare(
        `SELECT * FROM schedule
          WHERE enabled = 1 AND next_fire_at <= ?
          ORDER BY next_fire_at
          LIMIT ?`,
      )
      .all(startedAt, max) as {
      id: string
      project_id: string | null
      template_version_id: string | null
      member_id: string | null
      owner_human_id: string
      kind: string
      spec: string
      timezone: string
      max_fires: number | null
      fired_count: number
      next_fire_at: number
    }[]

    let fired = 0
    let created = 0
    for (const schedule of due) {
      const plannedAt = schedule.next_fire_at
      const existing = db
        .prepare('SELECT work_item_id FROM schedule_occurrence WHERE schedule_id = ? AND planned_at = ?')
        .get(schedule.id, plannedAt) as { work_item_id: string | null } | undefined
      if (existing) {
        // 已经被另一条触发路径处理过：只推进 next_fire_at，不再生单。
        db.prepare('UPDATE schedule SET next_fire_at = ?, fired_count = fired_count + 1 WHERE id = ?').run(plannedAt + 1_000, schedule.id)
        continue
      }

      let nextFire: number | null = null
      if (schedule.kind === 'every') {
        const interval = parseInterval(schedule.spec)
        if (!interval) {
          bag.errors.push(`schedule ${schedule.id}: 不支持的周期写法 ${schedule.spec}`)
          db.prepare(
            `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, fired_at) VALUES (?, ?, 'skipped', ?)`,
          ).run(schedule.id, plannedAt, startedAt)
          continue
        }
        nextFire = plannedAt + interval
        while (nextFire <= startedAt) nextFire += interval
      } else if (schedule.kind === 'at') {
        nextFire = null
      } else {
        bag.errors.push(`schedule ${schedule.id}: tick 暂不支持 kind=${schedule.kind}`)
        db.prepare(
          `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, fired_at) VALUES (?, ?, 'skipped', ?)`,
        ).run(schedule.id, plannedAt, startedAt)
        continue
      }

      let workItemId: string | null = null
      if (schedule.template_version_id) {
        const dedupeKey = `schedule:${schedule.id}:${plannedAt}`
        const open = db
          .prepare(
            `SELECT id FROM work_item WHERE dedupe_key = ? AND status IN (${OPEN_DEDUPE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
          )
          .get(dedupeKey, ...OPEN_DEDUPE_STATUSES) as { id: string } | undefined
        if (open) {
          workItemId = open.id
        } else {
          const template = db
            .prepare(
              `SELECT v.id, t.name FROM work_template_version v JOIN work_template t ON t.id = v.template_id WHERE v.id = ?`,
            )
            .get(schedule.template_version_id) as { id: string; name: string } | undefined
          if (template) {
            try {
              const item = insertWorkItem(
                { db, ids, now: () => startedAt, timeZone },
                {
                  domain: '运营',
                  category: '例行',
                  title: `${template.name}（${new Date(plannedAt).toISOString().slice(0, 10)}）`,
                  ownerHumanId: schedule.owner_human_id,
                  projectId: schedule.project_id,
                  templateVersionId: template.id,
                  dedupeKey,
                  createdBy: 'system',
                  actorKind: 'system',
                },
              )
              workItemId = item.id
              created += 1
            } catch (error) {
              bag.errors.push(`schedule ${schedule.id} 生单失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }

      const reachedMax = schedule.max_fires !== null && schedule.fired_count + 1 >= Number(schedule.max_fires)
      db.prepare(
        `INSERT INTO schedule_occurrence (schedule_id, planned_at, status, work_item_id, fired_at)
         VALUES (?, ?, 'fired', ?, ?)`,
      ).run(schedule.id, plannedAt, workItemId, startedAt)
      db.prepare('UPDATE schedule SET next_fire_at = ?, fired_count = fired_count + 1, enabled = ?, revision = revision + 1 WHERE id = ?').run(
        nextFire ?? plannedAt,
        reachedMax || nextFire === null ? 0 : 1,
        schedule.id,
      )
      fired += 1
    }
    return { fired, created }
  })
  steps.firedSchedules = schedules?.fired ?? 0
  steps.scheduledWorkItems = schedules?.created ?? 0

  // 5. 出站：注入发送器才真正发；三等（代次 / 对象 / 批准）由调用方在发送器里复核。
  const outbox = runStep(db, bag, 'due-outbox', () => {
    const due = db
      .prepare(
        `SELECT * FROM outbox
          WHERE status = 'pending' AND available_at <= ?
            AND (not_after IS NULL OR not_after > ?)
          ORDER BY available_at LIMIT ?`,
      )
      .all(startedAt, startedAt, max) as {
      id: string
      action: string
      payload_json: string
      idempotency_key: string
      attempts: number
    }[]
    if (!options.sendOutbox) return { sent: 0, failed: 0, unknown: 0, pending: due.length }
    let sent = 0
    let failed = 0
    let unknown = 0
    for (const row of due) {
      db.prepare("UPDATE outbox SET status = 'sending', sending_at = ?, attempts = attempts + 1 WHERE id = ?").run(startedAt, row.id)
      const result = options.sendOutbox({
        id: row.id,
        action: row.action,
        payloadJson: row.payload_json,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
      })
      if (result.status === 'sent') {
        db.prepare("UPDATE outbox SET status = 'sent', external_ref = ?, finished_at = ? WHERE id = ?").run(result.externalRef ?? null, startedAt, row.id)
        sent += 1
      } else if (result.status === 'failed') {
        db.prepare("UPDATE outbox SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?").run(result.error ?? 'send_failed', startedAt, row.id)
        failed += 1
      } else {
        db.prepare("UPDATE outbox SET status = 'unknown', last_error = ?, finished_at = ? WHERE id = ?").run(result.error ?? 'unknown_result', startedAt, row.id)
        unknown += 1
      }
    }
    return { sent, failed, unknown, pending: 0 }
  })
  steps.outboxSent = outbox?.sent ?? 0
  steps.outboxFailed = outbox?.failed ?? 0
  steps.outboxUnknown = outbox?.unknown ?? 0
  steps.outboxPending = outbox?.pending ?? 0

  // 6. 热力图日聚合：重算昨天，幂等 upsert。
  //    activity_daily 属于 P2（v1 只建 P1 41 表），没迁移到 P2 时这一步整段跳过，不算错误。
  const rollup = hasTable(db, 'activity_daily')
    ? runStep(db, bag, 'rollup-activity', () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(startedAt))
    const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
    const today = new Date(Date.UTC(pick('year'), pick('month') - 1, pick('day')))
    const yesterday = new Date(today.getTime() - 86_400_000)
    const date = yesterday.toISOString().slice(0, 10)
    const start = wallToUtc(timeZone, yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate(), 0, 0)
    const end = start + 86_400_000
    const rows = db
      .prepare(
        `SELECT member_id,
                COUNT(*) AS runs,
                SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status IN ('failed','unknown','orphaned') THEN 1 ELSE 0 END) AS failed
           FROM task_run
          WHERE finished_at IS NOT NULL AND finished_at >= ? AND finished_at < ?
          GROUP BY member_id`,
      )
      .all(start, end) as { member_id: string; runs: number; succeeded: number; failed: number }[]
    const upsert = db.prepare(
      `INSERT INTO activity_daily (member_id, date, runs, succeeded, failed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member_id, date) DO UPDATE SET
           runs = excluded.runs, succeeded = excluded.succeeded, failed = excluded.failed`,
    )
    for (const row of rows) upsert.run(row.member_id, date, Number(row.runs), Number(row.succeeded), Number(row.failed))
    return rows.length
    })
    : 0
  steps.rollupRows = rollup ?? 0

  // 7. 证据保留期满：只删文件、置 purged_at，行与哈希永久保留。
  const purged = runStep(db, bag, 'purge-evidence', () => {
    const retentionDays = options.evidenceRetentionDays ?? DEFAULT_RETENTION_DAYS
    const cutoff = startedAt - retentionDays * 86_400_000
    const rows = db
      .prepare(
        `SELECT id, work_item_id, ref FROM evidence
          WHERE purged_at IS NULL AND captured_at <= ? LIMIT ?`,
      )
      .all(cutoff, max) as { id: string; work_item_id: string; ref: string }[]
    let removed = 0
    for (const row of rows) {
      if (options.dataDir) {
        const base = path.resolve(options.dataDir, 'evidence')
        const target = path.resolve(options.dataDir, row.ref)
        const inside = target === base || target.startsWith(`${base}${path.sep}`)
        if (!inside) {
          bag.errors.push(`evidence ${row.id}: ref 越出证据目录，拒绝删除文件`)
          continue
        }
        if (existsSync(target)) {
          unlinkSync(target)
        }
      }
      db.prepare('UPDATE evidence SET purged_at = ? WHERE id = ?').run(startedAt, row.id)
      removed += 1
    }
    return removed
  })
  steps.purgedEvidence = purged ?? 0

  // 8. 记账：一拍一行，失败原因写进 error_text，不吞错。
  const finishedAt = now()
  const firedTotal =
    steps.expiredApprovals +
    steps.reclaimedLeases +
    steps.queuedCheckRuns +
    steps.firedSchedules +
    steps.scheduledWorkItems +
    steps.outboxSent
  const tickSeq = runStep(db, bag, 'tick-log', () => {
    db.prepare(
      `INSERT INTO tick_log (runtime_epoch, started_at, finished_at, fired, recovered, error_text)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(runtimeEpoch, startedAt, finishedAt, firedTotal, bag.errors.length ? bag.errors.join('; ') : null)
    return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
  })

  return {
    tickSeq: tickSeq ?? 0,
    runtimeEpoch,
    startedAt,
    finishedAt,
    fired: firedTotal,
    steps,
    errors: bag.errors,
  }
}

export interface TickerHandle {
  runOnce(): TickReport
  start(): void
  stop(): void
  running(): boolean
}

/** 给插件用的定时器；同一时刻只跑一拍，上一拍没结束就跳过。 */
export function createTicker(options: TickOptions & { intervalMs?: number }): TickerHandle {
  const intervalMs = options.intervalMs ?? 5_000
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false
  return {
    runOnce(): TickReport {
      return runTick(options)
    },
    running(): boolean {
      return busy
    },
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        if (busy) return
        busy = true
        try {
          runTick(options)
        } finally {
          busy = false
        }
      }, intervalMs)
      if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
    },
    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}
