import test from 'node:test'
import assert from 'node:assert/strict'
import { HamsService } from '../../src/service/hams.ts'
import { AT, DAY, HOUR, IDS, alertInput, createHarness, driveToReview, ingestAndClaim } from './fixtures.ts'

test('t01 无在岗岗位的人：写命令一律 POLICY_DENIED', () => {
  const h = createHarness(test)
  const { workItemId } = ingestAndClaim(h)
  assert.throws(
    () => h.service.pause(h.ctx(IDS.intern), { workItemId }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  assert.throws(
    () => h.service.appendEvidence(h.ctx(IDS.intern), { workItemId, kind: 'reading', ref: 'x', observedAt: AT }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  const who = h.service.whoami(h.ctx(IDS.intern))
  assert.deepEqual(who.capabilities, [])
  assert.deepEqual(who.principal.positions, [])
  h.close()
})

test('t02 bot 永远不能审批，也不能决定提议', () => {
  const h = createHarness(test)
  const { approvalId } = driveToReview(h)
  assert.throws(
    () => h.service.decideApproval(h.ctx(IDS.bot, 'tool'), { approvalId, decision: 'approve' }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  const proposed = h.service.propose(h.ctx(IDS.bot, 'tool'), {
    kind: 'create_task',
    subjectKey: 'project:p1',
    dedupeKey: 'bot-decide',
    deciderId: IDS.owner,
    title: 't',
    body: 'b',
    rationale: { evidence: [{ ref: 'e' }] },
  })
  assert.throws(
    () => h.service.decideProposal(h.ctx(IDS.bot, 'tool'), {
      proposalId: proposed.objectId as string,
      decision: 'accept',
      note: '',
      workItem: { domain: '安全', category: '安全响应', title: 't', ownerHumanId: IDS.owner },
    }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  h.close()
})

test('t03 不是指定审批人：NOT_APPROVER', () => {
  const h = createHarness(test)
  const { approvalId } = driveToReview(h)
  assert.throws(
    () => h.service.decideApproval(h.ctx(IDS.otherApprover), { approvalId, decision: 'approve' }),
    (error: unknown) => (error as { code?: string }).code === 'NOT_APPROVER',
  )
  h.close()
})

test('t04 审批过期后决定：APPROVAL_EXPIRED，工作项留在待验收', () => {
  const h = createHarness(test)
  const { workItemId, approvalId } = driveToReview(h)
  h.advance(25 * HOUR)
  assert.throws(
    () => h.service.decideApproval(h.ctx(IDS.owner), { approvalId, decision: 'approve' }),
    (error: unknown) => (error as { code?: string }).code === 'APPROVAL_EXPIRED',
  )
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), workItemId).status, 'waiting_review')
  h.close()
})

test('t05 证据不足：EVIDENCE_INCOMPLETE，状态不变', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '只补了读数' })
  h.advance(DAY)
  assert.throws(
    () => h.service.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId, reason: '申请关单' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'EVIDENCE_INCOMPLETE')
      const detail = (error as { detail?: { kind: string; need: number; have: number }[] }).detail
      assert.ok(Array.isArray(detail))
      assert.ok(detail!.some((item) => item.kind === 'photo' && item.need === 1 && item.have === 0))
      return true
    },
  )
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), workItemId).status, 'waiting_check')
  h.close()
})

test('t06 待决审批遇到新材料：立即作废，不能再批（不变式 3）', () => {
  const h = createHarness(test)
  const { workItemId, approvalId } = driveToReview(h)
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r3-late', observedAt: AT })

  const approval = h.db.prepare('SELECT * FROM approval WHERE id = ?').get(approvalId) as {
    status: string
    invalidated_reason: string
  }
  assert.equal(approval.status, 'invalidated')
  assert.equal(approval.invalidated_reason, 'subject_changed')
  assert.throws(
    () => h.service.decideApproval(h.ctx(IDS.owner), { approvalId, decision: 'approve' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), workItemId).status, 'waiting_review')
  h.close()
})

test('t07 批准后材料再变：旧批准不能用于关单（不变式 2，库层拦）', () => {
  const h = createHarness(test)
  const { workItemId, approvalId } = driveToReview(h)
  const approval = h.db.prepare('SELECT * FROM approval WHERE id = ?').get(approvalId) as {
    approver_id: string
    subject_revision: number
  }

  // 模拟「已批准但还没关单」的窗口：直接改成 approved，不触发关单。
  h.db
    .prepare(
      `UPDATE approval SET status = 'approved', decided_by = ?, decided_channel = 'ui',
              decided_at = ?, decision_note = '模拟批准' WHERE id = ?`,
    )
    .run(approval.approver_id, h.clock.now, approvalId)
  assert.equal((h.db.prepare('SELECT status FROM approval WHERE id = ?').get(approvalId) as { status: string }).status, 'approved')

  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r4-after-approve', observedAt: AT })
  const item = h.service.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.notEqual(item.revision, approval.subject_revision, '新材料必须让修订号前进')

  assert.throws(
    () =>
      h.db
        .prepare("UPDATE work_item SET status = 'completed', revision = revision + 1 WHERE id = ?")
        .run(workItemId),
    /APPROVAL_REQUIRED/,
  )
  h.close()
})

test('t08 执行代次过期：旧运行的结果必须被拒（EPOCH_STALE）', () => {
  const h = createHarness(test)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })

  // 模拟另一个生命周期动作把代次推走（真实路径是 pause/reopen，这里直接造出代次差）。
  h.db
    .prepare('UPDATE work_item SET execution_epoch = execution_epoch + 1, revision = revision + 1 WHERE id = ?')
    .run(workItemId)
  assert.throws(
    () => h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: '迟到的结果' }),
    (error: unknown) => (error as { code?: string }).code === 'EPOCH_STALE',
  )
  h.close()
})

test('t09 暂停的联动：运行作废、租约回收、复查取消、待决审批撤回（T9 六件事）', () => {
  const h = createHarness(test)

  // A. 运行中暂停：运行取消、租约回收、代次前进，恢复只能回到暂停前状态
  const a = ingestAndClaim(h, { externalEventId: 'evt-a', dedupeKey: 'alert:pause-a' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: a.runId })
  const pausedA = h.service.pause(h.ctx(IDS.owner), { workItemId: a.workItemId, reason: '现场断电' })
  assert.equal(pausedA.detail?.status, 'paused')
  let item = h.service.getWorkItem(h.ctx(IDS.owner), a.workItemId)
  assert.equal(item.resume_state, 'active')
  assert.equal(item.execution_epoch, 3, '暂停必须升一次执行代次')
  assert.equal((h.db.prepare('SELECT status FROM task_run WHERE id = ?').get(a.runId) as { status: string }).status, 'cancelled')
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM lease WHERE work_item_id = ?').get(a.workItemId) as { c: number }).c, 0)
  const resumed = h.service.resume(h.ctx(IDS.owner), { workItemId: a.workItemId })
  assert.equal(resumed.detail?.status, 'active')
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), a.workItemId).execution_epoch, 4)

  // B. 已排复查时暂停：待执行的复查被取消
  const b = ingestAndClaim(h, { externalEventId: 'evt-b', dedupeKey: 'alert:pause-b' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: b.runId })
  const submitted = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId: b.runId, summary: '先提交' })
  const checkId = String(submitted.detail?.checkId)
  h.service.pause(h.ctx(IDS.owner), { workItemId: b.workItemId })
  assert.equal((h.db.prepare('SELECT status FROM work_item_check WHERE id = ?').get(checkId) as { status: string }).status, 'cancelled')

  // C. 待验收时暂停：待决审批撤回；恢复回 waiting_review 后可重新申请
  const c = driveToReview(h, { externalEventId: 'evt-c', dedupeKey: 'alert:pause-c' })
  const pausedC = h.service.pause(h.ctx(IDS.owner), { workItemId: c.workItemId })
  assert.ok(pausedC.detail)
  assert.equal(
    (h.db.prepare('SELECT status FROM approval WHERE id = ?').get(c.approvalId) as { status: string }).status,
    'withdrawn',
  )
  h.service.resume(h.ctx(IDS.owner), { workItemId: c.workItemId })
  item = h.service.getWorkItem(h.ctx(IDS.owner), c.workItemId)
  assert.equal(item.status, 'waiting_review')
  const again = h.service.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId: c.workItemId, reason: '重新申请' })
  assert.ok(again.approvalId)
  assert.notEqual(again.approvalId, c.approvalId)

  // D. 取消是终态，不再接受新的申请
  h.service.cancel(h.ctx(IDS.owner), { workItemId: c.workItemId, reason: '资产已报废' })
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), c.workItemId).status, 'cancelled')
  assert.throws(
    () => h.service.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId: c.workItemId, reason: '再申请' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  h.close()
})

test('t10 重复认领与跨人认领：同一单只能有一个赢家', () => {
  const h = createHarness(test)
  const { workItemId } = ingestAndClaim(h)
  assert.throws(
    () => h.service.claim(h.ctx(IDS.bot, 'tool'), { workItemId, sessionId: 'sess-second' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  h.close()
})

test('t11 建单额度用尽：POLICY_DENIED，告警事件仍留痕', () => {
  const h = createHarness(test)
  h.db.prepare("UPDATE project_budget SET limit_value = 1 WHERE project_id = ? AND period_kind = 'day'").run(IDS.project)
  h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  assert.throws(
    () =>
      h.service.ingestAlert(
        h.ctx('system', 'system'),
        alertInput({ externalEventId: 'evt-budget', dedupeKey: 'alert:BT-99999:overdischarge' }),
      ),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM work_item').get() as { c: number }).c, 1)
  h.close()
})

test('t12 whoami 与 allowedActions 按岗位/能力计算', () => {
  const h = createHarness(test)
  const { workItemId } = ingestAndClaim(h)
  const owner = h.service.whoami(h.ctx(IDS.owner))
  assert.ok(owner.capabilities.includes('work_item.accept'))
  assert.ok(owner.capabilities.includes('approval.decide'))
  assert.equal(owner.principal.positions.length, 1)

  const bot = h.service.whoami(h.ctx(IDS.bot, 'tool'))
  assert.ok(bot.capabilities.includes('work_item.claim'))
  assert.ok(!bot.capabilities.includes('approval.decide'), 'bot 能力里不应出现审批')

  const item = h.service.getWorkItem(h.ctx(IDS.owner), workItemId)
  assert.ok(item.allowedActions.includes('pause'))
  assert.ok(!item.allowedActions.includes('claim'), '人看不到 bot 的认领动作')
  h.close()
})

test('t13 未注册的判据验证器：失败关闭，不假装校验过', () => {
  const h = createHarness(test)
  h.db.prepare("UPDATE work_template_version SET validator_key = 'soc_recovered' WHERE id = ?").run(IDS.templateVersion)
  const { workItemId, runId } = ingestAndClaim(h)
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r2', observedAt: AT, runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId, kind: 'photo', ref: 'p1', observedAt: AT, runId })
  h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId, summary: 'ok' })

  assert.throws(
    () => h.service.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId, reason: '申请' }),
    (error: unknown) => (error as { code?: string }).code === 'HOST_CAPABILITY_MISSING',
  )

  const withValidator = new HamsService({
    db: h.db,
    now: () => h.clock.now,
    runtimeEpoch: 1,
    validators: { soc_recovered: () => ({ passed: true, detail: { simulated: true } }) },
  })
  const closure = withValidator.requestClosure(h.ctx(IDS.bot, 'tool'), { workItemId, reason: '申请' })
  assert.ok(closure.approvalId)
  h.close()
})

test('t14 复查判定三态：缺数据 unknown、部分不足 failed', () => {
  const h = createHarness(test)

  // 一单什么都没补：复查只能是 unknown，工作项转 blocked(data_source)
  const a = ingestAndClaim(h, { externalEventId: 'evt-a', dedupeKey: 'alert:a' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: a.runId })
  const subA = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId: a.runId, summary: '什么都没补' })
  h.advance(DAY)
  const unknown = h.service.evaluateCheck(h.ctx(IDS.bot, 'tool'), { checkId: String(subA.detail?.checkId) })
  assert.equal(unknown.detail?.verdict, 'unknown')
  const blocked = h.service.getWorkItem(h.ctx(IDS.owner), a.workItemId)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blocked_reason, 'data_source')

  // 另一单只有一条读数、缺照片：复查 failed，工作项回 active 且清空到期时间
  const b = ingestAndClaim(h, { externalEventId: 'evt-b', dedupeKey: 'alert:b' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: b.runId })
  h.service.appendEvidence(h.ctx(IDS.bot, 'tool'), { workItemId: b.workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId: b.runId })
  const subB = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId: b.runId, summary: '只补了读数' })
  h.advance(DAY)
  const failed = h.service.evaluateCheck(h.ctx(IDS.bot, 'tool'), { checkId: String(subB.detail?.checkId) })
  assert.equal(failed.detail?.verdict, 'failed')
  const active = h.service.getWorkItem(h.ctx(IDS.owner), b.workItemId)
  assert.equal(active.status, 'active')
  assert.equal(active.next_action_at, null)
  h.close()
})
