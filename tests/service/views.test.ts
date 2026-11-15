import test from 'node:test'
import assert from 'node:assert/strict'
import { HamsError } from '../../src/domain/errors.ts'
import { AT, DAY, HOUR, IDS, createHarness, driveToReview, ingestAndClaim } from './fixtures.ts'

test('v01 人工建单：默认负责人是自己，dedupe 未结唯一，bot/无岗位被拒', () => {
  const h = createHarness(test)
  const created = h.service.createWorkItem(h.ctx(IDS.owner), {
    domain: '安全',
    category: '安全响应',
    title: '人工补录的追踪单',
    projectId: IDS.project,
    templateVersionId: IDS.templateVersion,
  })
  assert.equal(created.status, 'applied')
  const item = h.service.getWorkItem(h.ctx(IDS.owner), created.objectId as string)
  assert.equal(item.owner_human_id, IDS.owner)
  assert.equal(item.status, 'ready')
  assert.equal(item.revision, 1)

  const first = h.service.createWorkItem(h.ctx(IDS.owner), {
    domain: '安全',
    category: '安全响应',
    title: '带去重键的单',
    dedupeKey: 'manual:dedupe-1',
  })
  const duplicate = h.service.createWorkItem(h.ctx(IDS.owner), {
    domain: '安全',
    category: '安全响应',
    title: '重复建单',
    dedupeKey: 'manual:dedupe-1',
  })
  assert.equal(duplicate.status, 'accepted')
  assert.equal(duplicate.detail?.duplicate, true)
  assert.equal(duplicate.objectId, first.objectId)

  assert.throws(
    () =>
      h.service.createWorkItem(h.ctx(IDS.bot, 'tool'), {
        domain: '安全',
        category: '安全响应',
        title: 'bot 直接建单',
      }),
    (error: unknown) => error instanceof HamsError && error.code === 'POLICY_DENIED',
  )
  assert.throws(
    () =>
      h.service.createWorkItem(h.ctx(IDS.intern), {
        domain: '安全',
        category: '安全响应',
        title: '无岗位建单',
      }),
    (error: unknown) => error instanceof HamsError && error.code === 'POLICY_DENIED',
  )
  assert.throws(
    () =>
      h.service.createWorkItem(h.ctx(IDS.owner), {
        domain: '安全',
        category: '安全响应',
        title: '负责人是 bot',
        ownerHumanId: IDS.bot,
      }),
    (error: unknown) => error instanceof HamsError && error.code === 'POLICY_DENIED',
  )
  h.close()
})

test('v01b 推进 bot 可直接给本项目建单；同标题自动去重，非推进 bot 仍被拒', () => {
  const h = createHarness(test)
  const created = h.service.createWorkItem(h.ctx(IDS.coord, 'tool'), {
    projectId: IDS.project,
    domain: '安全',
    category: '巡检',
    title: '推进 bot 建的工作项',
  })
  assert.equal(created.status, 'applied')
  const item = h.service.getWorkItem(h.ctx(IDS.owner), created.objectId as string)
  assert.equal(item.project_id, IDS.project)
  assert.equal(item.owner_human_id, IDS.owner, '负责人默认是项目负责人，不是 bot')
  assert.equal(item.created_by, IDS.coord)

  const duplicate = h.service.createWorkItem(h.ctx(IDS.coord, 'tool'), {
    projectId: IDS.project,
    domain: '安全',
    category: '巡检',
    title: '推进 bot 建的工作项',
  })
  assert.equal(duplicate.status, 'accepted')
  assert.equal(duplicate.detail?.duplicate, true, '同一项目 + 标题自动去重')
  assert.equal(duplicate.objectId, created.objectId)

  assert.throws(
    () => h.service.createWorkItem(h.ctx(IDS.bot, 'tool'), { projectId: IDS.project, domain: '安全', category: '巡检', title: '非推进 bot 建单' }),
    (error: unknown) => error instanceof HamsError && error.code === 'POLICY_DENIED',
  )
  h.close()
})

test('v02 overview：待我把关、到期复查、执行中都聚合到负责人视角', () => {
  const h = createHarness(test)
  const review = driveToReview(h)
  const overview = h.service.overview(h.ctx(IDS.owner))
  assert.equal(overview.approvals.length, 1)
  assert.equal(overview.approvals[0].id, review.approvalId)
  assert.equal(overview.counts.myOpen, 1)
  assert.ok(overview.latestChangeSeq > 0)
  assert.equal(overview.executions.length, 0, 'driveToReview 的运行已结束')

  const running = ingestAndClaim(h, { externalEventId: 'evt-running', dedupeKey: 'alert:running' })
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId: running.runId })
  const withRun = h.service.overview(h.ctx(IDS.owner))
  assert.equal(withRun.executions.length, 1)
  assert.equal(withRun.executions[0].workItemId, running.workItemId)

  const submitted = h.service.submitResult(h.ctx(IDS.bot, 'tool'), { runId: running.runId, summary: '提交' })
  h.advance(DAY + HOUR)
  const due = h.service.overview(h.ctx(IDS.owner))
  const dueIds = due.dueChecks.map((check) => check.id)
  assert.ok(dueIds.includes(String(submitted.detail?.checkId)))

  const botView = h.service.overview(h.ctx(IDS.bot, 'tool'))
  assert.equal(botView.approvals.length, 0, 'bot 不应看到人的待办')
  h.close()
})

test('v03 changes/since：游标单调、可增量；游标超出保留期报 CURSOR_EXPIRED', () => {
  const h = createHarness(test)
  for (let index = 0; index < 6; index += 1) {
    h.service.createWorkItem(h.ctx(IDS.owner), { domain: '安全', category: '安全响应', title: `单 ${index}` })
  }

  const first = h.service.changesSince(h.ctx(IDS.owner), { limit: 20 })
  assert.ok(first.items.length > 0)
  assert.ok(first.nextCursor > 0)
  assert.ok(first.latestCursor >= first.nextCursor)
  assert.equal(first.items[0].objectKind, 'work_item')

  const empty = h.service.changesSince(h.ctx(IDS.owner), { cursor: first.nextCursor })
  assert.equal(empty.items.length, 0)
  assert.equal(empty.nextCursor, first.nextCursor)

  // 模拟保留期清理：删掉最早的几行后，旧游标必须被拒绝。
  h.db.prepare('DELETE FROM change_log WHERE seq <= 3').run()
  assert.throws(
    () => h.service.changesSince(h.ctx(IDS.owner), { cursor: 0 }),
    (error: unknown) => error instanceof HamsError && error.code === 'CURSOR_EXPIRED',
  )
  h.close()
})

test('v04 proposal/list：按决定人与状态过滤', () => {
  const h = createHarness(test)
  h.service.propose(h.ctx(IDS.bot, 'tool'), {
    kind: 'create_task',
    subjectKey: `project:${IDS.project}`,
    dedupeKey: 'view-proposal-1',
    deciderId: IDS.owner,
    title: '补一次读数',
    body: '离线 12 小时',
    rationale: { evidence: [{ ref: 'alert:offline' }] },
  })
  const open = h.service.listProposals(h.ctx(IDS.owner), { deciderId: IDS.owner, status: 'open' })
  assert.equal(open.length, 1)
  assert.equal(open[0].dedupe_key, 'view-proposal-1')
  const other = h.service.listProposals(h.ctx(IDS.otherApprover), { deciderId: IDS.otherApprover, status: 'open' })
  assert.equal(other.length, 0)
  h.close()
})
