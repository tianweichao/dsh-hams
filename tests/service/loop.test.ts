import test from 'node:test'
import assert from 'node:assert/strict'
import { AT, DAY, HOUR, IDS, alertInput, createHarness, ingestAndClaim } from './fixtures.ts'

test('t01 一条完整闭环：告警 → 认领 → 执行 → 证据 → 复查 → 申请 → 审批 → 关单', () => {
  const h = createHarness(test)
  const svc = h.service
  const system = h.ctx('system', 'system')

  const ingested = svc.ingestAlert(system, alertInput())
  assert.equal(ingested.status, 'applied')
  assert.ok(ingested.objectId)
  const workItemId = ingested.objectId as string

  let item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'ready')
  assert.equal(item.revision, 1)
  assert.equal(item.execution_epoch, 1)
  assert.equal(item.close_requires_approval, 1)
  assert.equal(item.evidence_set_hash, '')
  assert.ok(item.allowedActions.includes('accept'), '负责人应当可以接单')

  const inbox = h.db.prepare('SELECT * FROM event_inbox WHERE id = ?').get(ingested.detail?.eventId) as {
    work_item_id: string
    disposition: string
  }
  assert.equal(inbox.work_item_id, workItemId)
  assert.equal(inbox.disposition, 'created')
  const asset = h.db.prepare("SELECT id FROM asset WHERE external_id = 'BT-20871'").get() as { id: string }
  assert.ok(asset.id, '入站事件应当建立资产映射')

  const budget = h.db
    .prepare("SELECT period_kind, used FROM project_budget WHERE project_id = ? ORDER BY period_kind")
    .all(IDS.project) as { period_kind: string; used: number }[]
  assert.deepEqual(
    budget.map((row) => [row.period_kind, row.used]),
    [
      ['day', 1],
      ['week', 1],
    ],
  )

  const claimed = svc.claim(h.ctx(IDS.bot, 'tool'), { workItemId, sessionId: 'sess-loop-1' })
  const runId = String(claimed.detail?.runId)
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'active')
  assert.equal(item.assignee_id, IDS.bot)
  assert.equal(item.execution_epoch, 2, '认领必须升一次执行代次')
  assert.equal(item.fence_seq, 1)

  const thread = h.db
    .prepare('SELECT * FROM work_item_thread WHERE work_item_id = ?')
    .get(workItemId) as { id: string; generation: number; status: string; session_id: string }
  assert.equal(thread.generation, 1)
  assert.equal(thread.status, 'active')
  assert.equal(thread.session_id, 'sess-loop-1')
  assert.ok(h.db.prepare('SELECT 1 FROM task_run WHERE id = ? AND status = ?').get(runId, 'queued'))
  assert.ok(h.db.prepare('SELECT 1 FROM lease WHERE work_item_id = ?').get(workItemId), 'bot 认领要建租约')

  svc.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  assert.equal((h.db.prepare('SELECT turn_count FROM work_item_thread WHERE id = ?').get(thread.id) as { turn_count: number }).turn_count, 1)

  svc.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'reading-08-00', observedAt: AT - HOUR, runId })
  svc.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'reading-08-10', observedAt: AT - HOUR + 600_000, runId })
  const photo = svc.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'photo', ref: 'photo-site-1', observedAt: AT, runId })
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.match(item.evidence_set_hash, /^[0-9a-f]{64}$/)
  assert.equal(item.revision, 8, '三条证据各触发两次修订：插入与哈希重算')

  const submitted = svc.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '已现场复位并复核读数' })
  const checkId = String(submitted.detail?.checkId)
  const plannedDueAt = Number(submitted.detail?.plannedDueAt)
  assert.equal(plannedDueAt, Date.UTC(2026, 10, 15, 1, 0, 0), '次日 09:00 Asia/Shanghai 应当是 UTC 01:00')
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'waiting_check')
  assert.equal(item.check_generation, 1)
  assert.equal(item.next_action_at, plannedDueAt)

  h.advance(DAY)
  const evaluated = svc.evaluateCheck(h.ctx(IDS.bot, 'tool'), { checkId })
  assert.equal(evaluated.detail?.verdict, 'passed')
  assert.equal(evaluated.detail?.autoClosed, false, '需要人工验收的单不能被复查自动关掉')
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'waiting_check')

  const closure = svc.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId, reason: '过放已恢复，证据齐全' })
  const approvalId = closure.approvalId as string
  assert.ok(approvalId)
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'waiting_review')

  const approval = h.db.prepare('SELECT * FROM approval WHERE id = ?').get(approvalId) as {
    status: string
    approver_id: string
    subject_revision: number
    evidence_set_hash: string
    criteria_ref: string
    requested_channel: string
    expires_at: number
  }
  assert.equal(approval.status, 'pending')
  assert.equal(approval.approver_id, IDS.owner, 'review_policy=owner 时审批人是负责人')
  assert.equal(approval.requested_channel, 'tool')
  assert.equal(approval.subject_revision, item.revision, '审批锁定申请当时的修订号')
  assert.equal(approval.evidence_set_hash, item.evidence_set_hash)
  assert.equal(approval.criteria_ref, IDS.templateVersion)
  assert.equal(approval.expires_at, h.clock.now + 24 * HOUR)

  const decided = svc.decideApproval(h.ctx(IDS.owner), { approvalId, decision: 'approve' })
  assert.equal(decided.detail?.workItemStatus, 'completed')
  item = svc.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'completed')
  assert.ok(item.completed_at)
  assert.equal(
    (h.db.prepare('SELECT status FROM work_item_thread WHERE work_item_id = ?').get(workItemId) as { status: string }).status,
    'closed',
  )
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM lease WHERE work_item_id = ?').get(workItemId)!.c, 0)

  const eventKinds = (
    h.db.prepare('SELECT kind FROM work_item_event WHERE work_item_id = ? ORDER BY created_at, rowid').all(workItemId) as {
      kind: string
    }[]
  ).map((row) => row.kind)
  assert.deepEqual(eventKinds, [
    'work_item_created',
    'work_item_claimed',
    'run_started',
    'evidence_appended',
    'evidence_appended',
    'evidence_appended',
    'result_submitted',
    'closure_requested',
    'work_item_closed',
  ])

  const audits = h.db.prepare('SELECT action, channel FROM audit_log ORDER BY created_at, rowid').all() as {
    action: string
    channel: string
  }[]
  assert.equal(audits.length, 10, '每条写命令一次审计（含复查判定）')
  assert.ok(audits.some((row) => row.action === 'approval/decide' && row.channel === 'ui'))
  assert.ok(audits.some((row) => row.action === 'check/evaluate'))
  h.close()
})

test('t02 同一外部事件重放：只产生一次业务效果', () => {
  const h = createHarness(test)
  const first = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const second = h.service.ingestAlert(h.ctx('system', 'system'), alertInput({ title: '换个标题的重放' }))

  assert.equal(second.status, 'accepted')
  assert.equal(second.detail?.duplicate, true)
  assert.equal(second.objectId, first.objectId)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM work_item').get() as { c: number }).c, 1)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM event_inbox').get() as { c: number }).c, 1)
  h.close()
})

test('t03 同一资产再次告警但 dedupe_key 相同：并入未结单，不新建', () => {
  const h = createHarness(test)
  const first = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const second = h.service.ingestAlert(
    h.ctx('system', 'system'),
    alertInput({ externalEventId: 'evt-2', title: '同一电池第二次过放' }),
  )
  assert.equal(second.status, 'accepted')
  assert.equal(second.detail?.disposition, 'attached')
  assert.equal(second.objectId, first.objectId)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM work_item').get() as { c: number }).c, 1)
  const disposals = (
    h.db.prepare('SELECT disposition FROM event_inbox ORDER BY external_event_id').all() as { disposition: string }[]
  ).map((row) => row.disposition)
  assert.deepEqual(disposals, ['created', 'attached'])
  h.close()
})

test('t04 提议：bot 发起、重复自动归并、人决定后才落单', () => {
  const h = createHarness(test)
  const proposal = {
    kind: 'create_task' as const,
    subjectKey: 'project:p1',
    dedupeKey: 'recount:offline-12',
    deciderId: IDS.owner,
    title: '对离线 12 小时的电池补一次读数',
    body: '连续 12 小时无上报，建议现场补采。',
    rationale: { evidence: [{ ref: 'alert:offline-12' }], expectedEffect: '补齐读数，避免误判' },
  }
  const proposed = h.service.propose(h.ctx(IDS.bot, 'tool'), proposal)
  assert.equal(proposed.status, 'applied')
  assert.ok(proposed.objectId)
  const duplicate = h.service.propose(h.ctx(IDS.bot, 'tool'), proposal)
  assert.equal(duplicate.status, 'accepted')
  assert.equal(duplicate.detail?.duplicate, true)
  assert.equal(duplicate.detail?.duplicateCount, 1)
  assert.equal((h.db.prepare("SELECT COUNT(*) AS c FROM proposal WHERE status = 'open'").get() as { c: number }).c, 1)

  assert.throws(
    () => h.service.decideProposal(h.ctx(IDS.owner), {
      proposalId: proposed.objectId as string,
      decision: 'accept',
      note: '',
    }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )

  const decided = h.service.decideProposal(h.ctx(IDS.owner), {
    proposalId: proposed.objectId as string,
    decision: 'accept',
    note: '同意补采',
    workItem: {
      domain: '安全',
      category: '安全响应',
      title: proposal.title,
      ownerHumanId: IDS.owner,
      projectId: IDS.project,
      templateVersionId: IDS.templateVersion,
    },
  })
  assert.equal(decided.status, 'applied')
  const workItemId = decided.detail?.workItemId as string
  assert.ok(workItemId)
  const item = h.service.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.status, 'ready')
  assert.equal(item.dedupe_key, proposal.dedupeKey)
  const proposalRow = h.db.prepare('SELECT status, result_work_item_id FROM proposal WHERE id = ?').get(proposed.objectId) as {
    status: string
    result_work_item_id: string
  }
  assert.equal(proposalRow.status, 'accepted')
  assert.equal(proposalRow.result_work_item_id, workItemId)

  const rejected = h.service.propose(h.ctx(IDS.bot, 'tool'), { ...proposal, dedupeKey: 'recount:offline-13' })
  assert.throws(
    () => h.service.decideProposal(h.ctx(IDS.owner), {
      proposalId: rejected.objectId as string,
      decision: 'reject',
      note: '',
    }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  const rejectedOk = h.service.decideProposal(h.ctx(IDS.owner), {
    proposalId: rejected.objectId as string,
    decision: 'reject',
    note: '已有同类单在跑',
  })
  assert.equal(rejectedOk.status, 'applied')
  assert.equal((h.db.prepare("SELECT COUNT(*) AS c FROM work_item WHERE dedupe_key = 'recount:offline-13'").get() as { c: number }).c, 0)
  h.close()
})

test('t05 自动关单：close_requires_approval=0 时复查通过即关，不生成审批', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h, {
    templateVersionId: IDS.templateVersionAuto,
    dedupeKey: 'routine:BT-20871',
    externalEventId: 'evt-auto',
  })
  const item = h.service.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.equal(item.close_requires_approval, 0)

  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'reading-ok', observedAt: AT, runId })
  const submitted = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '复查完成' })
  h.advance(DAY)
  const evaluated = h.service.evaluateCheck(h.ctx(IDS.bot, 'tool'), { checkId: String(submitted.detail?.checkId) })
  assert.equal(evaluated.detail?.verdict, 'passed')
  assert.equal(evaluated.detail?.autoClosed, true)
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), workItemId).status, 'completed')
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM approval').get() as { c: number }).c, 0)
  h.close()
})

test('t06 幂等：同键同载荷返回首次回执，同键不同载荷拒绝', () => {
  const h = createHarness(test)
  const first = h.service.ingestAlert(h.ctx('system', 'system', 'idem-1'), alertInput())
  const replay = h.service.ingestAlert(h.ctx('system', 'system', 'idem-1'), alertInput())

  assert.equal(replay.objectId, first.objectId)
  assert.equal(replay.auditId, first.auditId, '同键必须返回首次回执，而不是重跑一遍')
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM work_item').get() as { c: number }).c, 1)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM command_receipt').get() as { c: number }).c, 1)

  assert.throws(
    () => h.service.ingestAlert(h.ctx('system', 'system', 'idem-1'), alertInput({ externalEventId: 'evt-other' })),
    (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_MISMATCH',
  )
  h.close()
})

test('t07 未结单的范围与库里的 dedupe 索引一致：failed 也算未结', () => {
  const h = createHarness(test)
  const first = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = first.objectId as string
  // 白名单只有 active→failed，没有 ready→failed；分两步造一个 failed 单。
  h.db.prepare("UPDATE work_item SET status = 'active', revision = revision + 1 WHERE id = ?").run(workItemId)
  h.db.prepare("UPDATE work_item SET status = 'failed', revision = revision + 1 WHERE id = ?").run(workItemId)

  const second = h.service.ingestAlert(
    h.ctx('system', 'system'),
    alertInput({ externalEventId: 'evt-after-fail' }),
  )
  assert.equal(second.status, 'accepted')
  assert.equal(second.detail?.disposition, 'attached')
  assert.equal(second.objectId, workItemId)
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM work_item').get() as { c: number }).c, 1)
  h.close()
})
