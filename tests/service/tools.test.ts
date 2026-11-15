import test from 'node:test'
import assert from 'node:assert/strict'
import { FORBIDDEN_TOOL_NAMES, TOOL_NAMES, createHamsTools, type ToolDefinition } from '../../src/service/tools.ts'
import { AT, IDS, alertInput, createHarness } from './fixtures.ts'

const SESSION_OWNERS = new Map<string, string>([
  ['tool-session-1', IDS.bot],
  ['tool-session-2', IDS.bot],
  ['tool-session-3', IDS.bot],
  ['tool-session-4', IDS.bot],
  ['tool-session-5', IDS.bot],
])

function makeTools(h: ReturnType<typeof createHarness>, options: Record<string, unknown> = {}): ToolDefinition[] {
  return createHamsTools({
    service: h.service,
    db: h.db,
    resolveSessionOwner: (sessionId) => {
      const memberId = SESSION_OWNERS.get(sessionId)
      return memberId ? { memberId } : null
    },
    ...options,
  } as never)
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((item) => item.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}

test('g01 工具清单：只有窄语义业务工具，没有审批 / 决定 / 关单 / SQL', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  assert.deepEqual(tools.map((item) => item.name), [...TOOL_NAMES])
  for (const forbidden of FORBIDDEN_TOOL_NAMES) {
    assert.equal(tools.some((item) => item.name === forbidden), false, `不应存在 ${forbidden}`)
  }
  for (const item of tools) {
    assert.ok(item.description.length > 10, `${item.name} 缺少说明`)
    assert.equal(item.parameters.type, 'object')
  }
  h.close()
})

test('g02 身份只从会话解析：缺会话拒绝，参数里塞身份字段拒绝', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string

  const noSession = tool(tools, 'hams_get_work_item').execute({ id: workItemId }, { sessionId: '' })
  assert.equal(noSession.ok, false)
  assert.equal(noSession.error?.code, 'HOST_CAPABILITY_MISSING')

  const unknownSession = tool(tools, 'hams_get_work_item').execute({ id: workItemId }, { sessionId: 'nope' })
  assert.equal(unknownSession.ok, false)
  assert.equal(unknownSession.error?.code, 'POLICY_DENIED')

  const claim = tool(tools, 'hams_claim').execute({ id: workItemId, memberId: IDS.bot }, { sessionId: 'sess-x' })
  assert.equal(claim.ok, false)
  assert.equal(claim.error?.code, 'POLICY_DENIED')
  h.close()
})

test('g03 工具侧完整闭环：认领 → 证据 → 提交 → 复查 → 请示关单', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  const exec = { sessionId: 'tool-session-1' }

  const claim = tool(tools, 'hams_claim').execute({ id: workItemId }, exec)
  assert.equal(claim.ok, true)
  const claimed = claim.data as { detail: { runId: string }; objectRevision: number }
  const runId = claimed.detail.runId
  h.service.startRun(h.ctx(IDS.bot, 'tool'), { runId })

  const reading1 = tool(tools, 'hams_append_evidence').execute(
    { id: workItemId, kind: 'reading', ref: 'r1', observedAt: AT },
    exec,
  )
  assert.equal(reading1.ok, true)
  assert.equal(
    tool(tools, 'hams_append_evidence').execute({ id: workItemId, kind: 'reading', ref: 'r2', observedAt: AT }, exec).ok,
    true,
  )
  assert.equal(
    tool(tools, 'hams_append_evidence').execute({ id: workItemId, kind: 'photo', ref: 'p1', observedAt: AT }, exec).ok,
    true,
  )

  const submitted = tool(tools, 'hams_submit_result').execute({ id: workItemId, summary: '处理完成' }, exec)
  assert.equal(submitted.ok, true)
  const checkId = (submitted.data as { detail: { checkId: string } }).detail.checkId

  const evaluated = tool(tools, 'hams_evaluate_check').execute({ checkId }, exec)
  assert.equal(evaluated.ok, true)
  assert.equal((evaluated.data as { detail: { verdict: string } }).detail.verdict, 'passed')

  const closure = tool(tools, 'hams_request_closure').execute({ id: workItemId, reason: '请验收' }, exec)
  assert.equal(closure.ok, true)
  assert.ok((closure.data as { approvalId?: string }).approvalId)
  h.close()
})

test('g04 工具失败返回错误码与下一步，而不是抛异常', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  const exec = { sessionId: 'tool-session-2' }

  assert.equal(tool(tools, 'hams_claim').execute({ id: workItemId }, exec).ok, true)
  // 还没开始运行就提交：给 STATE_INVALID + nextStep，让模型知道先做什么。
  const submitted = tool(tools, 'hams_submit_result').execute({ id: workItemId, summary: '抢跑' }, exec)
  assert.equal(submitted.ok, false)
  assert.equal(submitted.error?.code, 'STATE_INVALID')
  assert.ok((submitted.error?.nextStep ?? '').length > 0)

  const badCategory = tool(tools, 'hams_report_blocker').execute(
    { id: workItemId, category: 'whatever', note: 'x' },
    exec,
  )
  assert.equal(badCategory.ok, false)
  assert.ok((badCategory.error?.nextStep ?? '').length > 0)
  h.close()
})

test('g05 会话只绑定一个工作项：不能借别的会话操作别的工作项', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const first = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const second = h.service.ingestAlert(
    h.ctx('system', 'system'),
    alertInput({ externalEventId: 'evt-other', dedupeKey: 'alert:other' }),
  )
  const exec = { sessionId: 'tool-session-3' }
  assert.equal(tool(tools, 'hams_claim').execute({ id: first.objectId }, exec).ok, true)

  const crossItem = tool(tools, 'hams_append_evidence').execute(
    { id: second.objectId, kind: 'reading', ref: 'x', observedAt: AT },
    exec,
  )
  assert.equal(crossItem.ok, false)
  assert.equal(crossItem.error?.code, 'POLICY_DENIED')
  h.close()
})

test('g06 提议：决定人由服务端解析，证据不能为空', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const exec = { sessionId: 'tool-session-4' }
  assert.equal(tool(tools, 'hams_claim').execute({ id: ingested.objectId }, exec).ok, true)

  const noEvidence = tool(tools, 'hams_propose').execute(
    {
      kind: 'create_task',
      subjectKey: `project:${IDS.project}`,
      dedupeKey: 'recount:1',
      title: 't',
      body: 'b',
      rationale: { evidence: [] },
    },
    exec,
  )
  assert.equal(noEvidence.ok, false)
  assert.equal(noEvidence.error?.code, 'POLICY_DENIED')

  const proposed = tool(tools, 'hams_propose').execute(
    {
      kind: 'create_task',
      subjectKey: `project:${IDS.project}`,
      dedupeKey: 'recount:2',
      title: '补齐离线读数',
      body: '建议现场补采',
      rationale: { evidence: [{ ref: 'alert:offline' }] },
    },
    exec,
  )
  assert.equal(proposed.ok, true)
  const row = h.db.prepare('SELECT decider_id, proposed_by FROM proposal WHERE dedupe_key = ?').get('recount:2') as {
    decider_id: string
    proposed_by: string
  }
  assert.equal(row.decider_id, IDS.owner, '决定人必须是项目负责人，不能由模型指定')
  assert.equal(row.proposed_by, IDS.bot)
  h.close()
})

test('g07 同一 callId 重放：返回首次回执，不产生第二个运行', () => {
  const h = createHarness(test)
  const tools = makeTools(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const exec = { sessionId: 'tool-session-5', callId: 'same-call' }

  const first = tool(tools, 'hams_claim').execute({ id: ingested.objectId }, exec)
  assert.equal(first.ok, true)
  const replay = tool(tools, 'hams_claim').execute({ id: ingested.objectId }, exec)
  assert.equal(replay.ok, true)
  assert.equal(
    (replay.data as { auditId: string }).auditId,
    (first.data as { auditId: string }).auditId,
    '同 callId 必须原样返回首次回执',
  )
  assert.equal(
    Number((h.db.prepare('SELECT COUNT(*) AS c FROM task_run WHERE work_item_id = ?').get(ingested.objectId) as { c: number }).c),
    1,
  )
  h.close()
})

test('g10 群聊工具：成员名单、@ 发言、建临时 bot 都走 chat 端口；没接端口就明确不可用', async () => {
  const h = createHarness(test)
  const members = [{ memberId: IDS.bot, name: '数据巡检', kind: 'member', status: 'active', brief: '' }]
  const calls: string[] = []
  const port = {
    projectOfSession: () => IDS.project,
    groupMembersBySession: () => { calls.push('members'); return members },
    groupSpeakBySession: async (sessionId: string, input: { toMemberId: string; text: string }) => { calls.push(`speak:${input.toMemberId}:${input.text}`); return { ok: true as const, messageId: 'msg-1' } },
    groupSpawnBySession: (sessionId: string, input: { name: string }) => { calls.push(`spawn:${input.name}`); return { memberId: 'tmp-1', name: input.name } },
    rememberBySession: (sessionId: string, input: { title: string; kind: string }) => { calls.push(`remember:${input.kind}:${input.title}`); return { ok: true as const, memoryId: 'mem-1', created: true, syncedTo: input.kind === 'capability' ? IDS.coord : null } },
  }
  const tools = makeTools(h, { chat: port as never })
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:session:sess-group', IDS.coord)
  const exec = { sessionId: 'sess-group' }

  const listed = await tool(tools, 'hams_group_members').execute({}, exec)
  assert.equal(listed.ok, true)
  assert.deepEqual((listed.data as Array<{ memberId: string }>)[0].memberId, IDS.bot)

  const sent = await tool(tools, 'hams_group_send').execute({ toMemberId: IDS.bot, text: '看一下告警' }, exec)
  assert.equal(sent.ok, true)
  assert.ok(calls.includes(`speak:${IDS.bot}:看一下告警`))

  const spawned = tool(tools, 'hams_group_spawn_bot').execute({ name: '临时核验员' }, exec)
  assert.equal(spawned.ok, true)
  assert.ok(calls.some((call) => call.startsWith('spawn:临时核验员')))

  const remembered = await tool(tools, 'hams_remember').execute({ title: '复查窗口', body: '统一 72 小时', kind: 'decision' }, exec)
  assert.equal(remembered.ok, true)
  assert.ok(calls.includes('remember:decision:复查窗口'))

  const bare = makeTools(h)
  const missing = await tool(bare, 'hams_group_members').execute({}, exec)
  assert.equal(missing.ok, false)
  assert.equal(missing.error?.code, 'HOST_CAPABILITY_MISSING')
  h.close()
})
