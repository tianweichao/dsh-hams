import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { HamsSessionAdapter, buildRunFacts, hostToolContext, type HostAgentHandle } from '../../src/host/session-adapter.ts'
import { createHarness, IDS } from './fixtures.ts'

function setup(t: any) {
  const h = createHarness(t)
  const home = path.join(h.root, 'dsh-home')
  const cwd = path.join(h.root, 'cwd')
  mkdirSync(home); mkdirSync(cwd)
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before })
  const calls: { kind: string; id: string; value?: any }[] = []
  const composed: any[] = []
  const live = new Map<string, HostAgentHandle>()
  const stored = new Set<string>()
  let next = 0
  const make = async (id: string, kind: 'create'|'resume', options: any) => {
    assert.ok(process.env.DSH_HOME!.startsWith(h.root))
    assert.ok(options.meta?.cwd === undefined || options.meta.cwd.startsWith(h.root))
    assert.ok(!live.has(id), 'active write handle collision')
    if (kind === 'create') { assert.ok(!stored.has(id)); stored.add(id) } else assert.ok(stored.has(id))
    calls.push({ kind, id, value: options })
    const handle: HostAgentHandle = {
      agent: { session: { id }, status: 'idle', followup(message) { calls.push({ kind: 'followup', id, value: message }) }, cancel(cause, options) { calls.push({ kind: 'cancel', id, value: { cause, options } }) } },
      async dispose() { calls.push({ kind: 'dispose', id }); live.delete(id) },
    }
    live.set(id, handle)
    return handle
  }
  const adapter = new HamsSessionAdapter({ db: h.db, service: h.service, dataDir: path.join(home, 'hams'), now: () => h.clock.now,
    agents: { create: o => make(o.sessionId, 'create', o), resume: o => make(o.resumeSessionId, 'resume', o) },
    createUserMessage: value => value, compose: async config => { composed.push(config); return { agentOptions: { model: config.model }, setup: config.agentPreset } }, sessionId: () => `session-test-${++next}` })
  t.after(async () => { await adapter.dispose(); h.close() })
  // Publish bot config for session tests
  h.service.publishMemberConfig(h.ctx(IDS.owner), { memberId: IDS.bot, changeClass: 'major', agentPreset: 'hams-bot', model: 'deepseek-chat', memoryScope: {} })
  const receipt = h.service.createWorkItem(h.ctx(IDS.owner), { domain: '安全', category: '巡检', title: '真实会话', projectId: IDS.project, templateVersionId: IDS.templateVersion, ownerHumanId: IDS.owner })
  return { h, adapter, calls, composed, live, stored, id: receipt.objectId! }
}

test('real create before binding, one handle, five facts injected once per queued run', async t => {
  const { h, adapter, calls, id } = setup(t)
  const claim = await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const runId = claim.detail!.runId as string
  const [a,b] = await Promise.all([adapter.startRun(runId), adapter.startRun(runId)])
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(calls.filter(c => c.kind === 'create').length, 1)
  assert.equal(calls.filter(c => c.kind === 'followup').length, 1)
  const first = calls.find(c => c.kind === 'create')!
  assert.equal(first.value.meta.agentPreset, 'hams-bot')
  assert.ok(first.value.meta.cwd.includes('/bots/'))
  const message = calls.find(c => c.kind === 'followup')!.value.content[0].text
  for (const key of ['stateAndEpoch','evidenceAndHashes','taskAndCriteria','approvalsAndBlockers','budgetAndCapabilities']) assert.ok(message.includes(key))
  assert.ok(message.includes(runId))
  const facts = buildRunFacts(h.db, runId, h.clock.now)
  assert.ok((facts.budgetAndCapabilities as any).permissions.length)
})

test('dispose writer then resume same host session; cancel uses user/keepInbox receipt', async t => {
  const { h, adapter, calls, id } = setup(t)
  await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const thread = h.service.getWorkItem(h.ctx(IDS.owner), id).thread!
  await adapter.release(thread.session_id)
  await Promise.all([adapter.cancel(thread.session_id), adapter.cancel(thread.session_id)])
  assert.equal(calls.filter(c => c.kind === 'resume').length, 1)
  const cancel = calls.find(c => c.kind === 'cancel')!
  assert.deepEqual(cancel.value, { cause: { kind: 'user' }, options: { keepInbox: true } })
  assert.ok(calls.findIndex(c => c.kind === 'dispose') < calls.findIndex(c => c.kind === 'resume'))
})

test('manual rotation creates a genuine host session and preserves old thread/run history', async t => {
  const { h, adapter, calls, id } = setup(t)
  const claim = await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const old = h.service.getWorkItem(h.ctx(IDS.owner), id).thread!
  await adapter.rotateThread(h.ctx(IDS.owner), { workItemId: id, reason: '人工换代' })
  const detail = h.service.getWorkItem(h.ctx(IDS.owner), id)
  assert.equal(detail.threads.length, 2)
  assert.equal(detail.threads[0].session_id, old.session_id)
  assert.equal(detail.threads[0].status, 'closed')
  assert.notEqual(detail.thread!.session_id, old.session_id)
  assert.equal(detail.thread!.generation, 2)
  assert.equal(calls.filter(c => c.kind === 'create').length, 2)
  const run = h.db.prepare('SELECT thread_id FROM task_run WHERE id=?').get(claim.detail!.runId as string) as any
  assert.equal(run.thread_id, detail.thread!.id)
})

test('major configuration starts next run on a new host session; minor retains pinned config', async t => {
  const { h, adapter, calls, id } = setup(t)
  const claim = await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  h.db.prepare(`INSERT INTO member_version (id,member_id,version,agent_preset,model,prompt_digest,change_class,published_by,published_at) VALUES ('mv2',?,2,'hams-bot-v2','new-model','new','major',?,?)`).run(IDS.bot, IDS.owner, h.clock.now)
  h.db.prepare('UPDATE member SET current_version=2 WHERE id=?').run(IDS.bot)
  await adapter.startRun(claim.detail!.runId as string)
  const detail = h.service.getWorkItem(h.ctx(IDS.owner), id)
  assert.equal(detail.thread!.generation, 2)
  assert.equal(detail.thread!.member_version, 2)
  assert.equal(calls.filter(c => c.kind === 'create')[1].value.setup, 'hams-bot-v2')
  assert.equal(detail.threads[0].status, 'closed')
})

test('work-item sessions carry the member prompt into compose', async t => {
  const { h, adapter, composed, id } = setup(t)
  h.service.publishMemberConfig(h.ctx(IDS.owner), { memberId: IDS.bot, changeClass: 'major', model: 'deepseek-chat', prompt: '只做告警复查，先看证据。' })
  await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const last = composed.at(-1)!
  assert.equal(last.memberId, IDS.bot)
  assert.equal(last.version, 2)
  assert.equal(last.prompt, '只做告警复查，先看证据。')
})

test('tool context trusts only SDK agent session and preserves callId', () => {
  assert.deepEqual(hostToolContext({ sessionId: 'forged', callId: 'c1' }), { sessionId: '', callId: 'c1' })
  assert.deepEqual(hostToolContext({ sessionId: 'forged', agent: { session: { id: 'real' } }, callId: 'c2' }), { sessionId: 'real', callId: 'c2' })
})

test('human without management cannot create a session or inject instruction', async t => {
  const { h, adapter, calls, id } = setup(t)
  await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const before = calls.length
  await assert.rejects(adapter.rotateThread(h.ctx(IDS.intern), { workItemId: id }), /权限|能力/)
  await assert.rejects(adapter.instruct(h.ctx(IDS.intern), { workItemId: id, text: 'go' }), /权限|能力/)
  assert.equal(calls.length, before)
})

test('host delivery failure is unknown and never blindly replayed', async t => {
  const { h, adapter, live, calls, id } = setup(t)
  const claim = await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const handle = [...live.values()][0]
  handle.agent.followup = () => { throw new Error('admission interrupted') }
  await assert.rejects(adapter.startRun(claim.detail!.runId as string), /admission interrupted/)
  const run = h.db.prepare('SELECT status FROM task_run WHERE id=?').get(claim.detail!.runId as string) as any
  assert.equal(run.status, 'unknown')
  await assert.rejects(adapter.startRun(claim.detail!.runId as string), /queued/)
  assert.equal(calls.filter(c => c.kind === 'create').length, 1)
})

test('assignment: 人指派 ready 工作项给 bot，派发器替它认领并投递这一轮', async t => {
  const { h, adapter, calls, id } = setup(t)
  const assigned = h.service.assignWorkItem(h.ctx(IDS.owner), { workItemId: id, memberId: IDS.bot })
  assert.equal(assigned.status, 'applied')
  assert.equal((assigned.detail as { memberId: string }).memberId, IDS.bot)
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), id).assignee_id, IDS.bot)
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), id).status, 'ready', '指派不改状态，开跑由派发器做')

  const report = await adapter.dispatchAssignments()
  assert.equal(report.started, 1, JSON.stringify(report.errors))
  const item = h.service.getWorkItem(h.ctx(IDS.owner), id)
  assert.equal(item.status, 'active')
  assert.equal(item.assignee_id, IDS.bot)
  assert.ok(calls.some((call) => call.kind === 'followup'), '被指派的 bot 收到了一轮事实')
})

test('assignment: 只有项目推进 bot 或具备工单管理权限的人能指派', async t => {
  const { h, id } = setup(t)
  // b_coord 是 p1 的推进 bot
  const byCoord = h.service.assignWorkItem(h.ctx(IDS.coord, 'tool'), { workItemId: id, memberId: IDS.bot })
  assert.equal(byCoord.status, 'applied')
  // b_check 不是协调者
  assert.throws(() => h.service.assignWorkItem(h.ctx(IDS.bot, 'tool'), { workItemId: id, memberId: IDS.coord }), /推进 bot|管理权限/)
  // 人没有 manage 能力也不行
  assert.throws(() => h.service.assignWorkItem(h.ctx(IDS.intern), { workItemId: id, memberId: IDS.bot }), /work_item\.manage|能力|权限/)
})

test('reportBlocker 结束本轮：run 收尾、租约释放，不会一直显示运行中', async t => {
  const { h, adapter, id } = setup(t)
  const claim = await adapter.claim(h.ctx(IDS.bot, 'tool'), { workItemId: id })
  const runId = claim.detail!.runId as string
  await adapter.startRun(runId)
  h.service.reportBlocker(h.ctx(IDS.owner), { workItemId: id, category: 'permission', note: '本运行没有执行能力' })
  const run = h.db.prepare('SELECT status, error_kind FROM task_run WHERE id = ?').get(runId) as { status: string; error_kind: string }
  assert.equal(run.status, 'failed')
  assert.equal(run.error_kind, 'blocked:permission')
  const lease = h.db.prepare('SELECT COUNT(*) AS count FROM lease WHERE run_id = ?').get(runId) as { count: number }
  assert.equal(lease.count, 0, '报阻塞要释放租约')
  assert.equal(h.service.getWorkItem(h.ctx(IDS.owner), id).status, 'blocked')
})
