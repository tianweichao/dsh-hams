/**
 * 对话（单聊/群聊）与宿主运行时纯函数：线程指针、发送、消息提取、模型串解析。
 *
 * 宿主那半边用可注入的 ChatRuntime 假对象测；真实会话要 DSH 运行时，放在隔离实例里验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatService, type ChatRuntime } from '../../src/service/chat.ts'
import { chatMessagesFromEvents, parseModelChoice, resolveAgentOptions, HAMS_BOT_PRESET } from '../../src/host/chat-runtime.ts'
import { createHamsHttpHandler } from '../../src/http/handler.ts'
import { AT, IDS, createHarness } from './fixtures.ts'

function fakeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime & { sent: { sessionId: string; text: string }[]; stopped: string[]; created: number } {
  const sent: { sessionId: string; text: string }[] = []
  const stopped: string[] = []
  let created = 0
  const runtime: ChatRuntime & { sent: typeof sent; stopped: typeof stopped; created: number } = {
    available: true,
    sent,
    stopped,
    get created() {
      return created
    },
    async ensure(input) {
      const sessionId = input.sessionId || `sess-${(created += 1)}`
      return { sessionId }
    },
    async send(sessionId, text) {
      sent.push({ sessionId, text })
    },
    async read() {
      return { messages: [{ id: 'm1', role: 'assistant', text: '收到', at: AT }], running: false }
    },
    async stop(sessionId) {
      stopped.push(sessionId)
    },
    async presets() {
      return [{ id: HAMS_BOT_PRESET }]
    },
    async models() {
      return [{ provider: 'deepseek', model: 'deepseek-chat' }]
    },
    async defaultModel() {
      return { provider: 'deepseek', model: 'deepseek-chat' }
    },
    ...overrides,
  }
  return runtime
}

test('c01 单聊：打开即建线程指针，再次打开复用，发送落到同一会话', async () => {
  const h = createHarness(test)
  const runtime = fakeRuntime()
  const chat = new ChatService({ db: h.db, runtime })
  const owner = h.ctx(IDS.owner)

  const first = await chat.open(owner, { kind: 'member', targetId: IDS.coord })
  assert.equal(first.memberId, IDS.coord)
  assert.equal(first.agentPreset, HAMS_BOT_PRESET, '没配 preset 的 bot 默认走 hams-bot')
  assert.match(first.sessionId, /^sess-/)

  const pointer = h.db.prepare("SELECT value FROM hams_meta WHERE key = 'chat:member:b_coord'").get() as { value: string }
  assert.equal(JSON.parse(pointer.value).sessionId, first.sessionId)
  const reverse = h.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:session:${first.sessionId}`) as { value: string }
  assert.equal(reverse.value, IDS.coord, '工具层要能凭会话 id 认出是哪个 bot')

  const again = await chat.open(owner, { kind: 'member', targetId: IDS.coord })
  assert.equal(again.sessionId, first.sessionId, '配置没变就复用同一个会话')

  await chat.send(owner, { kind: 'member', targetId: IDS.coord, text: '你好' })
  assert.deepEqual(runtime.sent.at(-1), { sessionId: first.sessionId, text: '你好' })

  const read = await chat.read(owner, { kind: 'member', targetId: IDS.coord })
  assert.equal(read.available, true)
  assert.equal(read.messages.length, 1)
  assert.equal(read.thread?.sessionId, first.sessionId)
})

test('c02 配置换了（大改版本）就换新会话；群聊绑定项目推进 bot', async () => {
  const h = createHarness(test)
  const runtime = fakeRuntime()
  const chat = new ChatService({ db: h.db, runtime })
  const owner = h.ctx(IDS.owner)

  const before = await chat.open(owner, { kind: 'member', targetId: IDS.coord })
  h.db
    .prepare(
      "INSERT INTO member_version (id, member_id, version, agent_preset, model, memory_scope_json, prompt_digest, change_class, published_by, published_at) VALUES ('mv2', ?, 1, 'standard', 'deepseek-chat', '{}', 'digest', 'major', ?, ?)",
    )
    .run(IDS.coord, IDS.owner, AT + 1000)
  h.db.prepare('UPDATE member SET current_version = 1 WHERE id = ?').run(IDS.coord)
  const after = await chat.open(owner, { kind: 'member', targetId: IDS.coord })
  assert.notEqual(after.sessionId, before.sessionId, 'preset/模型变化后不能再复用旧会话')
  assert.equal(after.agentPreset, 'standard')
  assert.equal(after.model, 'deepseek-chat')

  const group = await chat.open(owner, { kind: 'project', targetId: IDS.project })
  assert.equal(group.memberId, IDS.coord, '群聊由项目 coordinator 回答')
  assert.equal(group.title, '电池资产持续运营')
})

test('c03 只有人能发起对话；宿主没有 agent 服务时明确拒绝', async () => {
  const h = createHarness(test)
  const chat = new ChatService({ db: h.db, runtime: fakeRuntime() })
  await assert.rejects(chat.open(h.ctx(IDS.bot, 'tool'), { kind: 'member', targetId: IDS.coord }), /只有人/)

  const unavailable = new ChatService({ db: h.db, runtime: fakeRuntime({ available: false, unavailableReason: '宿主没有 agents 服务' }) })
  await assert.rejects(unavailable.open(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord }), /agents/)
  const read = await unavailable.read(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord })
  assert.equal(read.available, false)
  assert.match(String(read.reason), /agents/)
})

test('c04 会话事件 → 聊天消息：只取真人输入与助手正文，注入与替换副本不进 transcript', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', time: 2, data: { id: 'u1', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'user/message', time: 3, data: { id: 'u2', content: [{ type: 'text', text: '注入的目录' }], source: { kind: 'skill-catalog' } }, surfaceOp: 'append' },
    { type: 'assistant/message', time: 4, data: { message: { id: 'a1', content: [{ type: 'text', text: '在。' }, { type: 'reasoning', text: '想一下' }] } }, surfaceOp: 'append' },
    { type: 'turn/end', time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 6, data: { turn: 2 } },
  ]
  const running = chatMessagesFromEvents(events)
  assert.deepEqual(running.messages.map((m) => [m.role, m.text]), [['user', '你好'], ['assistant', '在。']])
  assert.equal(running.running, true, '第 2 轮开着没结束 = 在跑')

  const replaced = chatMessagesFromEvents([
    { type: 'user/message', time: 1, data: { id: 'u1', content: [{ type: 'text', text: '压缩副本' }], source: { kind: 'user' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
    { type: 'turn/end', time: 2, data: { turn: 1 } },
  ])
  assert.equal(replaced.messages.length, 0, 'replace 副本是模型历史，不是人看的聊天记录')
  assert.equal(replaced.running, false)
})

test('c05 模型串解析：先精确匹配完整 id（id 里可以带斜杠），再看 provider 前缀，最后用默认 provider', async () => {
  const llm = {
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'auto', name: 'Auto' },
    ],
    listModels: async (provider: string) =>
      provider === 'deepseek'
        ? [{ provider: 'deepseek', id: 'auto/deepseek-v4.1-flash', name: 'flash' }]
        : [{ provider: 'auto', id: 'deepseek-chat', name: 'chat' }],
  }
  assert.deepEqual(await parseModelChoice('auto/deepseek-v4.1-flash', llm, 'deepseek'), {
    provider: 'deepseek',
    model: 'auto/deepseek-v4.1-flash',
  })
  assert.deepEqual(await parseModelChoice('auto/deepseek-chat', llm, 'deepseek'), { provider: 'auto', model: 'deepseek-chat' })
  assert.deepEqual(await parseModelChoice('unknown-model', llm, 'deepseek'), { provider: 'deepseek', model: 'unknown-model' })
  assert.equal(await parseModelChoice('', llm), undefined)
  assert.equal(await parseModelChoice(null), undefined)
})

test('c06 HTTP：对话命令是异步路由，写命令要幂等键，读命令直接回 data', async () => {
  const h = createHarness(test)
  const chat = new ChatService({ db: h.db, runtime: fakeRuntime() })
  const handler = createHamsHttpHandler({
    service: h.service,
    authenticate: () => ({ ok: true, principalId: IDS.owner }),
    chat,
  })
  const request = (path: string, body: unknown) =>
    handler({ method: 'POST', path: `/hams/api/v1/${path}`, headers: {}, body: JSON.stringify(body) }) as Promise<any>

  const opened = await request('chat/open', { commandId: 'c1', idempotencyKey: 'k1', payload: { kind: 'member', targetId: IDS.coord } })
  assert.equal(opened.status, 200)
  const payload = JSON.parse(opened.body)
  assert.equal(payload.ok, true)
  assert.match(payload.data.sessionId, /^sess-/)

  const sent = await request('chat/send', { commandId: 'c2', idempotencyKey: 'k2', payload: { kind: 'member', targetId: IDS.coord, text: '在吗' } })
  assert.equal(JSON.parse(sent.body).ok, true)

  const messages = await request('chat/messages', { commandId: 'c3', payload: { kind: 'member', targetId: IDS.coord } })
  const read = JSON.parse(messages.body)
  assert.equal(read.ok, true)
  assert.equal(read.data.messages[0].text, '收到')

  const noChat = createHamsHttpHandler({ service: h.service, authenticate: () => ({ ok: true, principalId: IDS.owner }) })
  const unavailable = (await noChat({ method: 'POST', path: '/hams/api/v1/chat/messages', headers: {}, body: JSON.stringify({ commandId: 'c4', payload: { kind: 'member', targetId: IDS.coord } }) })) as any
  assert.equal(JSON.parse(unavailable.body).data.available, false)
})

test('c07 没模型：宿主默认模型兜底；两边都没有就明确拒绝，而不是建一个发不出声的会话', async () => {
  const h = createHarness(test)
  const bare = fakeRuntime()
  const noDefault = { ...bare, defaultModel: async () => null }
  const chat = new ChatService({ db: h.db, runtime: noDefault })
  await assert.rejects(chat.open(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord }), /没有配置模型/)

  const withDefault = {
    ...bare,
    defaultModel: async () => ({ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash' }),
  }
  const ok = new ChatService({ db: h.db, runtime: withDefault })
  const view = await ok.open(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord })
  assert.equal(view.model, 'magpie/opencode-go/deepseek-v4.1-flash')
  const pointer = JSON.parse((h.db.prepare("SELECT value FROM hams_meta WHERE key='chat:member:b_coord'").get() as { value: string }).value)
  assert.equal(pointer.model, 'magpie/opencode-go/deepseek-v4.1-flash', '兜底模型要落进指针，才能和下次比较')
})

test('c08 回合以 error 结束时，聊天读得出原因（不再「发了没反应」）', () => {
  const failed = chatMessagesFromEvents([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', time: 2, data: { id: 'u1', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'error', error: { message: 'agent has no provider/model' } } } },
  ])
  assert.match(String(failed.error), /no provider\/model/)
  const recovered = chatMessagesFromEvents([
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
    { type: 'turn/start', time: 3, data: { turn: 2 } },
    { type: 'turn/end', time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  assert.equal(recovered.error, undefined, '下一轮成功后不再显示上一轮的错误')
})

/** 有状态的群聊假运行时：ensure 按 key 派生稳定会话，send 记下来，read 可回放助手回复。 */
function groupRuntime() {
  const sessions = new Map<string, { messages: any[] }>()
  const sent: { sessionId: string; text: string }[] = []
  const runtime = {
    available: true,
    sent,
    sessions,
    async ensure(input: any) {
      const sessionId = input.sessionId || `sess:${input.key}`
      if (!sessions.has(sessionId)) sessions.set(sessionId, { messages: [] })
      return { sessionId }
    },
    async send(sessionId: string, text: string) {
      sent.push({ sessionId, text })
    },
    async read(sessionId: string) {
      return { messages: sessions.get(sessionId)?.messages ?? [], running: false }
    },
    async status() {
      return { running: false }
    },
    async stop() {},
    async presets() {
      return []
    },
    async models() {
      return []
    },
    async defaultModel() {
      return { provider: 'deepseek', model: 'deepseek-chat' }
    },
    reply(sessionId: string, text: string, seq = 10) {
      sessions.get(sessionId)!.messages.push({ id: `a-${seq}`, role: 'assistant', text, at: Date.now(), seq })
    },
  }
  return runtime
}

test('c09 团队：手动加/移除常驻 bot；推进 bot 不能移除；非管理员不能改', async () => {
  const h = createHarness(test)
  const chat = new ChatService({ db: h.db, runtime: groupRuntime() as never })
  const owner = h.ctx(IDS.owner)
  const team0 = await chat.team(owner, { projectId: IDS.project })
  assert.equal(team0.coordinator?.memberId, IDS.coord)
  assert.deepEqual(team0.members, [])

  chat.addParticipant(owner, { projectId: IDS.project, memberId: IDS.bot })
  const team1 = await chat.team(owner, { projectId: IDS.project })
  assert.deepEqual(team1.members.map((row) => [row.memberId, row.kind]), [[IDS.bot, 'member']])

  chat.addParticipant(owner, { projectId: IDS.project, memberId: IDS.bot }) // 幂等
  assert.equal((await chat.team(owner, { projectId: IDS.project })).members.length, 1)

  chat.removeParticipant(owner, { projectId: IDS.project, memberId: IDS.bot })
  assert.deepEqual((await chat.team(owner, { projectId: IDS.project })).members, [])
  assert.throws(() => chat.removeParticipant(owner, { projectId: IDS.project, memberId: IDS.coord }), /推进 bot/)
  assert.throws(() => chat.addParticipant(h.ctx(IDS.intern), { projectId: IDS.project, memberId: IDS.bot }), /work_item|project\.manage|能力|权限/)
})

test('c10 群聊：人类发言进记录并交给推进 bot；@ 成员后回复合并进记录且不重复', async () => {
  const h = createHarness(test)
  const runtime = groupRuntime()
  const chat = new ChatService({ db: h.db, runtime: runtime as never })
  const owner = h.ctx(IDS.owner)
  chat.addParticipant(owner, { projectId: IDS.project, memberId: IDS.bot })

  await chat.groupSend(owner, { projectId: IDS.project, text: '这周把闭环率拉起来' })
  const coordinatorPtr = JSON.parse((h.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:project:${IDS.project}`) as any).value)
  assert.equal(runtime.sent.length, 1)
  assert.match(runtime.sent[0].text, /这周把闭环率拉起来/)
  assert.match(runtime.sent[0].text, /团队成员/)

  // 推进 bot @ 数据巡检
  const spoke = await chat.groupSpeakBySession(coordinatorPtr.sessionId, { toMemberId: IDS.bot, text: '你去看一下这周的告警' })
  assert.equal(spoke.ok, true)
  const memberSession = `sess:chat:group:${IDS.project}:${IDS.bot}`
  assert.equal(runtime.sent.at(-1)!.sessionId, memberSession)
  assert.match(runtime.sent.at(-1)!.text, /@你/)

  // 被 @ 的 bot 真的回了一句 → 合并进群聊记录
  runtime.reply(memberSession, '收到，明天上午给结论', 12)
  const view = await chat.groupRead(owner, { projectId: IDS.project })
  const authors = view.messages.map((m) => `${m.authorKind}:${m.authorName}:${m.kind}`)
  assert.ok(authors.includes(`bot:${'数据巡检'}`, ) || view.messages.some((m) => m.authorId === IDS.bot && m.text.includes('明天上午给结论')))
  const again = await chat.groupRead(owner, { projectId: IDS.project })
  assert.equal(again.messages.length, view.messages.length, '按 seq 合并，重复读不重复追加')
})

test('c11 临时 bot：推进 bot 自己创建，只属于本项目；移除即退休', async () => {
  const h = createHarness(test)
  const runtime = groupRuntime()
  const chat = new ChatService({ db: h.db, runtime: runtime as never })
  const owner = h.ctx(IDS.owner)
  await chat.groupSend(owner, { projectId: IDS.project, text: '大家好' })
  const coordinatorPtr = JSON.parse((h.db.prepare("SELECT value FROM hams_meta WHERE key = ?").get(`chat:project:${IDS.project}`) as any).value)

  const spawned = chat.groupSpawnBySession(coordinatorPtr.sessionId, { name: '临时研究员', brief: '只查这一周的因子' })
  const member = h.db.prepare('SELECT kind, name, scope_project_id, status FROM member WHERE id = ?').get(spawned.memberId) as any
  assert.deepEqual({ ...member }, { kind: 'bot', name: '临时研究员', scope_project_id: IDS.project, status: 'active' })
  const team = await chat.team(owner, { projectId: IDS.project })
  assert.ok(team.members.some((row) => row.memberId === spawned.memberId && row.kind === 'temp'))
  const members = chat.groupMembersBySession(coordinatorPtr.sessionId)
  assert.ok(members.some((row) => row.memberId === spawned.memberId))

  // 非推进 bot 不能建
  const other = chat.groupMembersBySession(coordinatorPtr.sessionId)
  void other
  h.db.prepare("INSERT INTO member (id, kind, name, role, status, current_version, owner_human_id, created_at, updated_at) VALUES ('b_other','bot','别的 bot','executor','active',0,?,1,1)").run(IDS.owner)
  h.db.prepare("INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at) VALUES (?, 'b_other','member','', ?, 1)").run(IDS.project, IDS.owner)
  h.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES ('chat:group:session:sess-other', ?)").run(IDS.project)
  h.db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES ('chat:session:sess-other', 'b_other')").run()
  assert.throws(() => chat.groupSpawnBySession('sess-other', { name: '偷偷建的' }), /推进 bot/)

  chat.removeParticipant(owner, { projectId: IDS.project, memberId: spawned.memberId })
  assert.equal((h.db.prepare('SELECT status FROM member WHERE id = ?').get(spawned.memberId) as any).status, 'retired')
})

test('c12 临时 bot 只属于项目群：全局成员列表不显示，按项目查才带出来', async () => {
  const h = createHarness(test)
  const chat = new ChatService({ db: h.db, runtime: groupRuntime() as never })
  const spawned = chat.spawnTempBot(h.ctx(IDS.owner), { projectId: IDS.project, name: '群内临时工', brief: '' })
  const all = h.service.listMembers(h.ctx(IDS.owner))
  assert.equal(all.some((row) => row.id === spawned.memberId), false, '全局智能体列表不该出现临时 bot')
  const scoped = h.service.listMembers(h.ctx(IDS.owner), { projectId: IDS.project })
  assert.equal(scoped.some((row) => row.id === spawned.memberId), true, '按项目查才带出临时 bot')
})

test('c13 bot 没配模型时用宿主默认模型兜底；两边都没有返回 undefined', async () => {
  const llm = {
    listProviders: () => [{ id: 'auto' }, { id: 'deepseek' }],
    listModels: async (provider: string) => (provider === 'auto' ? [{ id: 'deepseek-v4.1-flash', provider: 'auto', name: 'flash' }] : [{ id: 'deepseek-chat', provider: 'deepseek', name: 'chat' }]),
  }
  // bot 自己配了模型：按配置来
  assert.deepEqual(await resolveAgentOptions('deepseek-chat', llm as never, { provider: 'auto', model: 'deepseek-v4.1-flash' }), { provider: 'deepseek', model: 'deepseek-chat' })
  // 没配：用宿主当前选择（provider + model + reasoningEffort 都带上）
  assert.deepEqual(await resolveAgentOptions(null, llm as never, { provider: 'auto', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }), { provider: 'auto', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
  assert.deepEqual(await resolveAgentOptions('', llm as never, { provider: 'auto', model: 'deepseek-v4.1-flash' }), { provider: 'auto', model: 'deepseek-v4.1-flash' })
  // 两边都没有：明确返回 undefined，由调用方给出可读错误
  assert.equal(await resolveAgentOptions(null, llm as never, undefined), undefined)
  assert.equal(await resolveAgentOptions(null, llm as never, { provider: '', model: '' }), undefined)
})

test('c14 群聊：人类 @ 某个 bot 就直接交给它；没 @ 才由推进 bot 接指令', async (t) => {
  const h = createHarness(t)
  const runtime = groupRuntime()
  const chat = new ChatService({ db: h.db, runtime: runtime as never })
  const owner = h.ctx(IDS.owner)

  // @ 一个还没进群的全局 bot：视为明确点名，直接拉进群并路由给它。
  const routed = await chat.groupSend(owner, { projectId: IDS.project, text: '@复查助手 看一下这周的告警' })
  assert.deepEqual(routed.mentions, [IDS.bot])
  assert.equal(routed.sessionId, `sess:chat:group:${IDS.project}:${IDS.bot}`)
  assert.equal(runtime.sent.length, 1)
  assert.match(runtime.sent[0].text, /@你/)
  assert.match(runtime.sent[0].text, /看一下这周的告警/)
  assert.equal(
    runtime.sent.some((row) => row.sessionId === `sess:chat:project:${IDS.project}`),
    false,
    '点了名就不要再惊动推进 bot',
  )
  const participant = h.db
    .prepare('SELECT kind FROM project_participant WHERE project_id = ? AND member_id = ? AND removed_at IS NULL')
    .get(IDS.project, IDS.bot) as { kind: string } | undefined
  assert.equal(participant?.kind, 'member')

  const view = await chat.groupRead(owner, { projectId: IDS.project })
  const human = view.messages.find((message) => message.authorKind === 'human')
  assert.equal(human?.kind, 'mention')
  assert.equal(human?.toMemberId, IDS.bot)

  // 没 @ 或 @ 了不存在的人：仍然只有推进 bot 接。
  const plain = await chat.groupSend(owner, { projectId: IDS.project, text: '这周把闭环率拉起来' })
  assert.deepEqual(plain.mentions, [])
  assert.equal(plain.sessionId, `sess:chat:project:${IDS.project}`)
  const unknown = await chat.groupSend(owner, { projectId: IDS.project, text: '@不存在的 bot 看看这个' })
  assert.deepEqual(unknown.mentions, [])
  assert.equal(unknown.sessionId, `sess:chat:project:${IDS.project}`)
})

test('c15 推进 bot 派活：群聊正文必须写出 @成员名，不能只藏在 toMemberId 里', async (t) => {
  const h = createHarness(t)
  const runtime = groupRuntime()
  const chat = new ChatService({ db: h.db, runtime: runtime as never })
  const owner = h.ctx(IDS.owner)
  chat.addParticipant(owner, { projectId: IDS.project, memberId: IDS.bot })
  await chat.groupSend(owner, { projectId: IDS.project, text: '安排一下这周的复查' })
  const coordinator = JSON.parse(
    (h.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`chat:project:${IDS.project}`) as any).value,
  )

  await chat.groupSpeakBySession(coordinator.sessionId, { toMemberId: IDS.bot, text: '你去看一下这周的告警' })
  const view = await chat.groupRead(owner, { projectId: IDS.project })
  const message = view.messages.find(
    (row) => row.authorKind === 'bot' && row.kind === 'mention' && row.toMemberId === IDS.bot,
  )
  assert.ok(message, '群里应有一条 @ 复查助手的派活消息')
  assert.ok(message!.text.startsWith('@复查助手 '), `派活正文要以 @名字 开头：${message!.text}`)

  // 工具 hams_assign_task 指派后也会补一条可见的 @，但不唤醒被指派人。
  const note = chat.groupNoteAssignmentBySession(coordinator.sessionId, { memberId: IDS.bot, text: '请接手工作项 w1' })
  assert.ok(note && note.ok)
  const after = await chat.groupRead(owner, { projectId: IDS.project })
  assert.ok(after.messages.some((row) => row.kind === 'mention' && row.text === '@复查助手 请接手工作项 w1'))
})

test('c16 群聊自动发现记忆：人的决策入项目记忆，bot 的能力经验同步给 bot 自己', async (t) => {
  const h = createHarness(t)
  const runtime = groupRuntime()
  const chat = new ChatService({ db: h.db, runtime: runtime as never })
  const owner = h.ctx(IDS.owner)

  await chat.groupSend(owner, { projectId: IDS.project, text: '决定了：以后所有复查都用 72 小时窗口。' })
  const decision = h.db.prepare("SELECT kind, origin, source_ref FROM project_memory WHERE project_id = ? AND kind = 'decision'").get(IDS.project) as any
  assert.deepEqual({ ...decision }, { kind: 'decision', origin: 'auto', source_ref: decision.source_ref })
  assert.match(String(decision.source_ref), /^message:/)

  const view = await chat.groupRead(owner, { projectId: IDS.project })
  assert.ok(
    view.messages.some((row) => row.authorName === '记忆' && row.kind === 'system' && row.text.includes('自动收集')),
    '自动记住后要在群里留一条系统记录',
  )

  const coordinator = JSON.parse(
    (h.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`chat:project:${IDS.project}`) as any).value,
  )
  runtime.reply(coordinator.sessionId, '我擅长先对账再下结论，步骤是先核台账再核现场照片。', 10)
  await chat.groupRead(owner, { projectId: IDS.project })

  const capability = h.db.prepare("SELECT kind, member_id, title FROM project_memory WHERE project_id = ? AND kind = 'capability'").get(IDS.project) as any
  assert.equal(capability?.member_id, IDS.coord)
  assert.match(String(capability?.title), /对账/)
  const synced = h.db.prepare('SELECT title, body FROM bot_memory WHERE member_id = ?').all(IDS.coord) as any[]
  assert.equal(synced.length, 1)
  assert.match(synced[0].body, /先核台账/)

  const before = (h.db.prepare('SELECT COUNT(*) AS c FROM project_memory WHERE project_id = ?').get(IDS.project) as any).c
  await chat.groupRead(owner, { projectId: IDS.project })
  const after = (h.db.prepare('SELECT COUNT(*) AS c FROM project_memory WHERE project_id = ?').get(IDS.project) as any).c
  assert.equal(after, before, '重复轮询不能重复收集')
})
