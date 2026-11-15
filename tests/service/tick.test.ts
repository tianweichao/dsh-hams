import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { recover, runTick } from '../../src/service/tick.ts'
import {
  AT,
  DAY,
  HOUR,
  IDS,
  alertInput,
  createHarness,
  driveToReview,
  ingestAndClaim,
  type Harness,
} from './fixtures.ts'

const TZ = 'Asia/Shanghai'

function tick(h: Harness, overrides: Partial<Parameters<typeof runTick>[0]> = {}) {
  return runTick({ db: h.db, runtimeEpoch: 1, now: () => h.clock.now, timeZone: TZ, ...overrides })
}

function count(h: Harness, sql: string, ...params: (string | number)[]): number {
  return Number((h.db.prepare(sql).get(...params) as { c: number }).c)
}

test('t01 到期复查：有在用线程就起 queued 运行，第二次 tick 不重复起跑', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '先提交' })
  h.advance(DAY + HOUR)

  const report = tick(h)
  assert.equal(report.steps.queuedCheckRuns, 1)
  assert.deepEqual(report.errors, [])

  const check = h.db
    .prepare("SELECT status FROM work_item_check WHERE work_item_id = ? ORDER BY generation DESC LIMIT 1")
    .get(workItemId) as { status: string }
  assert.equal(check.status, 'running')
  const run = h.db
    .prepare("SELECT status, trigger, fence, runtime_epoch FROM task_run WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(workItemId) as { status: string; trigger: string; fence: number; runtime_epoch: number }
  assert.deepEqual({ ...run }, { status: 'queued', trigger: 'check', fence: 2, runtime_epoch: 1 })
  assert.equal(count(h, "SELECT COUNT(*) AS c FROM work_item_event WHERE work_item_id = ? AND kind = 'check_run_queued'", workItemId), 1)

  const second = tick(h)
  assert.equal(second.steps.queuedCheckRuns, 0, '已有活跃运行，不得重复起跑')
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM task_run WHERE work_item_id = ?', workItemId), 2)
  h.close()
})

test('t02 到期复查但没有在用线程：记 missed 与关注项，不凭空造会话', () => {
  const h = createHarness(test)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  h.db
    .prepare(
      `INSERT INTO work_item_check
         (id, work_item_id, generation, execution_epoch, template_version_id, planned_due_at, status, created_at)
       VALUES ('chk-miss', ?, 1, 1, ?, ?, 'scheduled', ?)`,
    )
    .run(workItemId, IDS.templateVersion, AT - 1_000, AT)

  const report = tick(h)
  assert.equal(report.steps.missedChecks, 1)
  assert.equal((h.db.prepare('SELECT status FROM work_item_check WHERE id = ?').get('chk-miss') as { status: string }).status, 'unknown')
  const attentionRow = h.db.prepare("SELECT reason, to_member_id FROM attention_item WHERE work_item_id = ?").get(workItemId) as {
    reason: string
    to_member_id: string
  }
  assert.equal(attentionRow.reason, 'missed_check')
  assert.equal(attentionRow.to_member_id, IDS.owner)
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM task_run WHERE work_item_id = ?', workItemId), 0)
  h.close()
})

test('t03 审批过期：只置 expired，不自动通过、不上报', () => {
  const h = createHarness(test)
  const { workItemId, approvalId } = driveToReview(h)
  h.advance(25 * HOUR)

  const report = tick(h)
  assert.equal(report.steps.expiredApprovals, 1)
  assert.equal((h.db.prepare('SELECT status FROM approval WHERE id = ?').get(approvalId) as { status: string }).status, 'expired')
  assert.equal((h.db.prepare('SELECT status FROM work_item WHERE id = ?').get(workItemId) as { status: string }).status, 'waiting_review')
  // attention_item.reason 枚举里没有 approval_expired：这里刻意不生成关注项（见进展记录 §10 缺口 1）。
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM attention_item'), 0)
  h.close()
})

test('t04 租约过期：回收租约，运行结果记 unknown，不自动重跑', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.advance(11 * 60_000)

  const report = tick(h)
  assert.equal(report.steps.reclaimedLeases, 1)
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM lease WHERE work_item_id = ?', workItemId), 0)
  const run = h.db.prepare('SELECT status, error_kind FROM task_run WHERE id = ?').get(runId) as {
    status: string
    error_kind: string
  }
  assert.deepEqual({ ...run }, { status: 'unknown', error_kind: 'lease_expired' })
  h.close()
})

test('t05 recover：遗留 queued 取消、running 标孤儿、sending 转 unknown 并生成关注项', () => {
  const h = createHarness(test)
  const first = ingestAndClaim(h)
  const second = ingestAndClaim(h, { externalEventId: 'evt-2', dedupeKey: 'alert:2', sessionId: 'sess-2' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: second.runId })
  h.db
    .prepare(
      `INSERT INTO outbox (id, action, payload_json, idempotency_key, work_item_id, requested_by, status, available_at, created_at, sending_at)
       VALUES ('ob-1', 'lark.notify', '{}', 'idem-ob-1', ?, ?, 'sending', ?, ?, ?)`,
    )
    .run(second.workItemId, IDS.owner, AT, AT, AT)

  const report = recover({ db: h.db, runtimeEpoch: 2, now: () => h.clock.now, timeZone: TZ })
  assert.equal(report.cancelledQueuedRuns, 1)
  assert.equal(report.orphanedRunningRuns, 1)
  assert.equal(report.outboxUnknown, 1)

  const queuedRun = h.db.prepare('SELECT status, error_kind FROM task_run WHERE id = ?').get(first.runId) as {
    status: string
    error_kind: string
  }
  assert.deepEqual({ ...queuedRun }, { status: 'cancelled', error_kind: 'host_restart_before_start' })
  const runningRun = h.db.prepare('SELECT status, error_kind FROM task_run WHERE id = ?').get(second.runId) as {
    status: string
    error_kind: string
  }
  assert.deepEqual({ ...runningRun }, { status: 'orphaned', error_kind: 'host_restart_during_run' })
  // 孤儿运行必须同时释放租约，否则 ready 的工作项永远认领不上（uq_wi_active_run / lease 主键）。
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM lease').get() as { c: number }).c, 0)
  assert.equal((h.db.prepare("SELECT status FROM outbox WHERE id = 'ob-1'").get() as { status: string }).status, 'unknown')

  const reasons = (h.db.prepare('SELECT reason FROM attention_item ORDER BY created_at').all() as { reason: string }[]).map(
    (row) => row.reason,
  )
  assert.deepEqual(reasons, ['orphaned_run', 'outbox_unknown'])
  const log = h.db.prepare('SELECT recovered FROM tick_log ORDER BY tick_seq DESC LIMIT 1').get() as { recovered: number }
  assert.equal(log.recovered, 1)
  h.close()
})

test('t06 热力图日聚合：重算昨天，幂等可重跑', () => {
  const h = createHarness(test)
  const yesterdayAt = AT - DAY
  h.clock.now = yesterdayAt
  const { runId } = ingestAndClaim(h, { externalEventId: 'evt-y', dedupeKey: 'alert:y' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '昨天完成' })
  h.clock.now = AT

  // v3 已按权威 DDL 迁移 activity_daily；使用真实迁移后的表。
  const report = tick(h)
  assert.equal(report.steps.rollupRows, 1)
  const row = h.db.prepare('SELECT * FROM activity_daily WHERE member_id = ? AND date = ?').get(IDS.bot, '2026-11-13') as {
    runs: number
    succeeded: number
    failed: number
  }
  assert.deepEqual({ runs: row.runs, succeeded: row.succeeded, failed: row.failed }, { runs: 1, succeeded: 1, failed: 0 })

  h.clock.now = AT + HOUR
  tick(h)
  assert.equal(count(h, "SELECT COUNT(*) AS c FROM activity_daily WHERE date = '2026-11-13'"), 1, '聚合必须 upsert 而不是插两行')
  h.close()
})

test('t07 证据保留期满：删文件、置 purged_at，行与哈希永久保留', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  const evidence = h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), {
    workItemId,
    kind: 'photo',
    ref: 'evidence/2025/01/old-site.jpg',
    observedAt: AT - 400 * DAY,
    runId,
  })
  const evidenceId = String(evidence.detail?.evidenceId)
  const filePath = path.join(h.root, 'evidence/2025/01/old-site.jpg')
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'fake image')
  h.db.prepare('UPDATE evidence SET captured_at = ? WHERE id = ?').run(AT - 400 * DAY, evidenceId)

  const report = tick(h, { dataDir: h.root, evidenceRetentionDays: 365 })
  assert.equal(report.steps.purgedEvidence, 1)
  assert.equal(existsSync(filePath), false)
  const row = h.db.prepare('SELECT content_hash, purged_at FROM evidence WHERE id = ?').get(evidenceId) as {
    content_hash: string
    purged_at: number | null
  }
  assert.match(row.content_hash, /^[0-9a-f]{64}$/)
  assert.ok(row.purged_at)
  h.close()
})

test('t08 到期 schedule：occurrence 主键防双触发，物化工作项只做一次', () => {
  const h = createHarness(test)
  const plannedAt = AT - HOUR
  h.db
    .prepare(
      `INSERT INTO schedule
         (id, project_id, template_version_id, member_id, owner_human_id, kind, spec, timezone,
          misfire_policy, concurrency, fired_count, next_fire_at, enabled, revision, created_at)
       VALUES ('s1', ?, ?, ?, ?, 'every', '6h', 'Asia/Shanghai', 'catch_up_latest', 'skip', 0, ?, 1, 1, ?)`,
    )
    .run(IDS.project, IDS.templateVersion, IDS.bot, IDS.owner, plannedAt, AT)

  const report = tick(h)
  assert.equal(report.steps.firedSchedules, 1)
  assert.equal(report.steps.scheduledWorkItems, 1)
  assert.deepEqual(report.errors, [])

  const occurrence = h.db
    .prepare('SELECT status, work_item_id FROM schedule_occurrence WHERE schedule_id = ?')
    .get('s1') as { status: string; work_item_id: string }
  assert.equal(occurrence.status, 'fired')
  const item = h.db.prepare('SELECT * FROM work_item WHERE id = ?').get(occurrence.work_item_id) as {
    status: string
    dedupe_key: string
    owner_human_id: string
  }
  assert.equal(item.status, 'ready')
  assert.equal(item.dedupe_key, `schedule:s1:${plannedAt}`)
  assert.equal(item.owner_human_id, IDS.owner)

  const schedule = h.db.prepare("SELECT next_fire_at, fired_count FROM schedule WHERE id = 's1'").get() as {
    next_fire_at: number
    fired_count: number
  }
  assert.ok(schedule.next_fire_at > AT, '下一次触发应当推到未来')
  assert.equal(schedule.fired_count, 1)

  const second = tick(h)
  assert.equal(second.steps.firedSchedules, 0)
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM schedule_occurrence'), 1)
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM work_item'), 1)
  h.close()
})

test('t09 复查漏跑策略 skip：直接记 unknown 与关注项', () => {
  const h = createHarness(test)
  h.db.prepare("UPDATE work_template_version SET misfire_policy = 'skip' WHERE id = ?").run(IDS.templateVersion)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '提交' })
  h.advance(DAY + HOUR)

  const report = tick(h)
  assert.equal(report.steps.queuedCheckRuns, 0)
  assert.equal(report.steps.missedChecks, 1)
  assert.equal(
    (h.db.prepare('SELECT reason FROM attention_item WHERE work_item_id = ?').get(workItemId) as { reason: string }).reason,
    'missed_check',
  )
  h.close()
})

test('t10 单步失败不中断其余：坏 schedule 记错误，审批过期仍照常处理', () => {
  const h = createHarness(test)
  const { approvalId } = driveToReview(h)
  h.advance(25 * HOUR)
  h.db
    .prepare(
      `INSERT INTO schedule
         (id, owner_human_id, kind, spec, timezone, fired_count, next_fire_at, enabled, revision, created_at)
       VALUES ('s-bad', ?, 'cron', '* * * * *', 'Asia/Shanghai', 0, ?, 1, 1, ?)`,
    )
    .run(IDS.owner, AT - HOUR, AT)

  const report = tick(h)
  assert.equal(report.steps.expiredApprovals, 1)
  assert.ok(report.errors.some((message) => message.includes('s-bad')))
  assert.equal((h.db.prepare('SELECT status FROM approval WHERE id = ?').get(approvalId) as { status: string }).status, 'expired')
  assert.equal(count(h, 'SELECT COUNT(*) AS c FROM schedule_occurrence'), 1, '被跳过的触发也要留 occurrence 痕迹')
  h.close()
})

test('t11 复查起的运行可以单独收尾，判定仍由 evaluateCheck 做', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r2', observedAt: AT, runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'photo', ref: 'p1', observedAt: AT, runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '先提交' })
  h.advance(DAY + HOUR)

  const sliced = tick(h)
  assert.equal(sliced.steps.queuedCheckRuns, 1)
  const checkRun = h.db
    .prepare("SELECT id, check_id FROM task_run WHERE work_item_id = ? AND trigger = 'check'")
    .get(workItemId) as { id: string; check_id: string }
  assert.ok(checkRun.check_id)

  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: checkRun.id })
  const finished = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId: checkRun.id, summary: '复查执行完毕' })
  assert.equal(finished.detail?.checkOnly, true)
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), workItemId).status, 'waiting_check')

  const evaluated = h.service.evaluateCheck(h.ctx(IDS.bot, 'tool'), { checkId: String(finished.detail?.checkId) })
  assert.equal(evaluated.detail?.verdict, 'passed')
  h.close()
})
