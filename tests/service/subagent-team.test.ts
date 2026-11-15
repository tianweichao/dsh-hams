/**
 * bot 用 DSH subagent 起的子代理要出现在项目「团队」里。
 *
 * 子代理不是 HAMS 成员：它是独立会话（header.origin='subagent'、parentSession=父会话）。
 * 这里覆盖两条入口——描述符事件直接登记、团队页轻量扫描补登记——以及去重。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatService, type ChatRuntime } from '../../src/service/chat.ts'
import { AT, IDS, createHarness } from './fixtures.ts'

function runtimeWith(sessions: any[], events: Record<string, any[]>, running: string[] = []): ChatRuntime {
  return {
    available: true,
    async ensure() {
      return { sessionId: 'parent-session' }
    },
    async send() {},
    async read() {
      return { messages: [], running: false }
    },
    async status(sessionId: string) {
      return { running: running.includes(sessionId) }
    },
    async stop() {},
    async presets() {
      return []
    },
    async models() {
      return [{ provider: 'deepseek', model: 'deepseek-chat' }]
    },
    async defaultModel() {
      return { provider: 'deepseek', model: 'deepseek-chat' }
    },
    async listSessions() {
      return sessions
    },
    async readSessionEvents(sessionId: string) {
      return events[sessionId] || []
    },
  }
}

test('s01 描述符事件把子代理登记为项目团队成员；重复登记幂等', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  const runtime = runtimeWith([], {})
  const chat = new ChatService({ db: h.db, runtime })

  // 父会话是这个项目的推进 bot 群会话（真实链路里 open/group 会写这两条索引）。
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:group:session:parent-1', IDS.project)
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:session:parent-1', IDS.coord)

  const first = chat.registerSubagent({ childSessionId: 'child-1', parentSessionId: 'parent-1', label: 'A 股最新行情', prompt: '调研 A 股最新行情，标注来源。' })
  assert.ok(first && first.memberId)
  const again = chat.registerSubagent({ childSessionId: 'child-1', parentSessionId: 'parent-1', label: 'A 股最新行情' })
  assert.equal(again!.memberId, first!.memberId, '同一个子会话只登记一次')
  const version = h.db.prepare('SELECT prompt FROM member_version WHERE member_id=? AND version=1').get(first!.memberId) as any
  assert.equal(version.prompt, '调研 A 股最新行情，标注来源。', '子代理自己的任务提示词要存下来供查看/编辑')

  const team = await chat.team(h.ctx(IDS.owner), { projectId: IDS.project })
  const row = team.members.find((member) => member.memberId === first!.memberId)
  assert.ok(row, '团队里应能看到子代理')
  assert.equal(row!.kind, 'subagent')
  assert.equal(row!.name, 'A 股最新行情')
  assert.match(row!.brief, /^子代理 · /)
  assert.equal(row!.running, false)
})

test('s02 团队页扫描历史会话：重启前跑完的子代理也能补登记，并能显示运行中', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:group:session:parent-2', IDS.project)
  const runtime = runtimeWith(
    [
      { id: 'child-2', parentSession: 'parent-2', origin: 'subagent', createdAt: AT + 1, cwd: '/tmp' },
      { id: 'child-3', parentSession: 'not-hams', origin: 'subagent', createdAt: AT + 2, cwd: '/tmp' },
      { id: 'parent-2', createdAt: AT, cwd: '/tmp' },
    ],
    {
      'child-2': [
        { type: 'subagent/descriptor', data: { label: '美股市场复盘' } },
        { type: 'user/message', time: AT + 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '查美股三大指数并标注来源。' }] } },
      ],
      'child-3': [{ type: 'subagent/descriptor', data: { label: '孤儿会话' } }],
    },
    ['child-2'],
  )
  const chat = new ChatService({ db: h.db, runtime })
  const team = await chat.team(h.ctx(IDS.owner), { projectId: IDS.project })
  const row = team.members.find((member) => member.name === '美股市场复盘')
  assert.ok(row, '扫描会话后应补登记子代理')
  assert.equal(row!.kind, 'subagent')
  assert.equal(row!.running, true, '子代理会话还在跑时团队里显示运行中')
  assert.equal(row!.sessionId, 'child-2')
  assert.ok(!team.members.some((member) => member.name === '孤儿会话'), '父会话不属于 HAMS 的不登记')
  const version = h.db.prepare('SELECT prompt FROM member_version WHERE member_id=? AND version=1').get(row!.memberId) as any
  assert.equal(version.prompt, '查美股三大指数并标注来源。', '补登记时也要从第一条用户消息取任务提示词')
})

test('s03 子代理登记后不会出现在全局成员列表（只属于项目）', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:group:session:parent-3', IDS.project)
  const chat = new ChatService({ db: h.db, runtime: runtimeWith([], {}) })
  const created = chat.registerSubagent({ childSessionId: 'child-4', parentSessionId: 'parent-3', label: '因子核验' })
  assert.ok(created)
  const global = h.service.listMembers(h.ctx(IDS.owner), {})
  assert.ok(!global.some((member: any) => member.id === created!.memberId), '全局智能体列表不应混入子代理')
  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), created!.memberId)
  assert.equal(detail.name, '因子核验')
  assert.ok(detail.allowedActions.includes('publishConfig'), '子代理的职责/提示词也要能编辑')
})

test('s04 团队状态：单聊会话在跑也算运行中，空闲时为 false', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:group:session:parent-4', IDS.project)
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(
    'chat:member:' + IDS.coord,
    JSON.stringify({ sessionId: 'dm-session', memberId: IDS.coord, memberVersion: 0, agentPreset: 'hams-bot', model: null, at: AT }),
  )
  const chat = new ChatService({
    db: h.db,
    runtime: {
      available: true,
      async ensure() { return { sessionId: 'x' } },
      async send() {},
      async read() { return { messages: [], running: false } },
      async stop() {},
      async presets() { return [] },
      async models() { return [] },
      async defaultModel() { return null },
      liveStatus(sessionId: string) { return { live: true, running: sessionId === 'dm-session' } },
    },
  })
  const team = await chat.team(h.ctx(IDS.owner), { projectId: IDS.project })
  const coordinator = team.coordinator!
  assert.equal(coordinator.running, true, '单聊会话里正在跑也算在推进独立对话')
  assert.equal(team.members.find((row) => row.memberId === IDS.coord), undefined)
})

test('s05 早期登记的空提示词子代理：扫描时补一版配置，不重复加版本', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  h.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run('chat:group:session:parent-5', IDS.project)
  const runtime = runtimeWith(
    [{ id: 'child-5', parentSession: 'parent-5', origin: 'subagent', createdAt: AT + 1, cwd: '/tmp' }],
    {
      'child-5': [
        { type: 'subagent/descriptor', data: { label: '早期子代理' } },
        { type: 'user/message', time: AT + 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '补读出来的任务文本。' }] } },
      ],
    },
  )
  const chat = new ChatService({ db: h.db, runtime })
  const created = chat.registerSubagent({ childSessionId: 'child-5', parentSessionId: 'parent-5', label: '早期子代理', prompt: '' })
  assert.ok(created)
  let version = h.db.prepare('SELECT version, prompt FROM member_version WHERE member_id=? ORDER BY version DESC LIMIT 1').get(created!.memberId) as any
  assert.equal(version.prompt, '')

  await chat.team(h.ctx(IDS.owner), { projectId: IDS.project })
  version = h.db.prepare('SELECT version, prompt FROM member_version WHERE member_id=? ORDER BY version DESC LIMIT 1').get(created!.memberId) as any
  assert.equal(version.version, 2)
  assert.equal(version.prompt, '补读出来的任务文本。')

  h.advance(11_000)
  await chat.team(h.ctx(IDS.owner), { projectId: IDS.project })
  const count = h.db.prepare('SELECT COUNT(*) AS c FROM member_version WHERE member_id=?').get(created!.memberId) as any
  assert.equal(Number(count.c), 2, '补过之后不再加版本')
})
