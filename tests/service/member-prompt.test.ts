/**
 * bot 提示词：跟 member_version 冻结、改它必须大改、临时 bot 也能查到并改。
 *
 * 2026-11-15 口径：运行过程中创建的 bot 要能改提示词；工具仍继承 hams-bot preset。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatService, type ChatRuntime } from '../../src/service/chat.ts'
import { AT, IDS, createHarness } from './fixtures.ts'

function fakeRuntime(): ChatRuntime & { opens: unknown[] } {
  const opens: unknown[] = []
  return {
    available: true,
    opens,
    async ensure(input) {
      opens.push(input)
      return { sessionId: `sess-${opens.length}` }
    },
    async send() {},
    async read() {
      return { messages: [], running: false }
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
  }
}

test('p01 提示词随版本冻结：小改改提示词被拒，大改后新旧提示词都在版本里', (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  h.service.publishMemberConfig(h.ctx(IDS.owner), {
    memberId: IDS.bot,
    changeClass: 'major',
    model: 'deepseek-chat',
    prompt: '只做告警复查，先看证据。',
  })
  const before = h.db.prepare('SELECT prompt, prompt_digest FROM member_version WHERE member_id=? AND version=1').get(IDS.bot) as any
  assert.equal(before.prompt, '只做告警复查，先看证据。')

  assert.throws(
    () => h.service.publishMemberConfig(h.ctx(IDS.owner), { memberId: IDS.bot, changeClass: 'minor', prompt: '换个说法' }),
    /大改/,
    '提示词变化不能走小改',
  )
  h.service.publishMemberConfig(h.ctx(IDS.owner), { memberId: IDS.bot, changeClass: 'major', prompt: '换个说法：先给结论。' })
  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), IDS.bot)
  assert.equal(detail.current_version, 2)
  assert.equal((detail.bot_versions.find((row: any) => row.version === 2) as any).prompt, '换个说法：先给结论。')
  assert.equal((detail.bot_versions.find((row: any) => row.version === 1) as any).prompt, '只做告警复查，先看证据。')
  const after = h.db.prepare('SELECT prompt_digest FROM member_version WHERE member_id=? AND version=2').get(IDS.bot) as any
  assert.notEqual(after.prompt_digest, before.prompt_digest, '提示词要计入配置摘要')
})

test('p02 新建 bot 不写提示词时用职责兜底；显式提示词优先', (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  const omitted = h.service.createMember(h.ctx(IDS.owner), {
    kind: 'bot',
    name: '兜底提示词 bot',
    domain: '安全',
    responsibility: '核对工单字段',
    ownerHumanId: IDS.owner,
    model: 'deepseek-chat',
  })
  const row = h.db.prepare('SELECT prompt FROM member_version WHERE member_id=? AND version=1').get(omitted.objectId as string) as any
  assert.equal(row.prompt, '核对工单字段')

  const explicit = h.service.createMember(h.ctx(IDS.owner), {
    kind: 'bot',
    name: '显式提示词 bot',
    domain: '安全',
    responsibility: '核对工单字段',
    prompt: '你是复核员，只挑错不重写。',
    ownerHumanId: IDS.owner,
    model: 'deepseek-chat',
  })
  const row2 = h.db.prepare('SELECT prompt FROM member_version WHERE member_id=? AND version=1').get(explicit.objectId as string) as any
  assert.equal(row2.prompt, '你是复核员，只挑错不重写。')
})

test('p03 运行中创建的临时 bot：不在全局列表，但能按项目查到、能改提示词', (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  const chat = new ChatService({ db: h.db, runtime: fakeRuntime() })
  const created = chat.spawnTempBot(h.ctx(IDS.owner), { projectId: IDS.project, name: '因子核验员', brief: '只查这一周的因子' })

  const global = h.service.listMembers(h.ctx(IDS.owner), {})
  assert.ok(!global.some((row: any) => row.id === created.memberId), '临时 bot 默认不进全局智能体列表')

  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), created.memberId)
  assert.equal(detail.name, '因子核验员')
  assert.ok(detail.allowedActions.includes('publishConfig'), '临时 bot 也要能发布配置')
  assert.equal((detail.bot_versions.find((row: any) => row.version === 1) as any).prompt, '只查这一周的因子', '创建时的 brief 作为初版提示词')

  h.service.publishMemberConfig(h.ctx(IDS.owner), {
    memberId: created.memberId,
    changeClass: 'major',
    prompt: '只查这一周的因子；发现缺数先报阻塞。',
  })
  const after = h.service.getMemberDetail(h.ctx(IDS.owner), created.memberId)
  assert.equal(after.current_version, 2)
  assert.equal((after.bot_versions.find((row: any) => row.version === 2) as any).prompt, '只查这一周的因子；发现缺数先报阻塞。')
})

test('p04 单聊把提示词交给运行时；配了别的宿主 preset 时写进上下文', async (t) => {
  const h = createHarness(t)
  t.after(() => h.close())
  const runtime = fakeRuntime()
  const chat = new ChatService({ db: h.db, runtime })

  h.service.publishMemberConfig(h.ctx(IDS.owner), {
    memberId: IDS.coord,
    changeClass: 'major',
    model: 'deepseek-chat',
    prompt: '你是运营协调，先拆目标再派活。',
  })
  await chat.open(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord })
  const first = runtime.opens.at(-1) as any
  assert.equal(first.prompt, '你是运营协调，先拆目标再派活。')
  assert.equal(first.memberVersion, 1)
  assert.ok(!String(first.context).includes('你是运营协调'), '默认 hams-bot 由 persona 承载，不在上下文重复')

  h.service.publishMemberConfig(h.ctx(IDS.owner), {
    memberId: IDS.coord,
    changeClass: 'major',
    agentPreset: 'standard',
    prompt: '换宿主 preset 后也要看到这句。',
  })
  await chat.open(h.ctx(IDS.owner), { kind: 'member', targetId: IDS.coord })
  const second = runtime.opens.at(-1) as any
  assert.equal(second.agentPreset, 'standard')
  assert.match(String(second.context), /换宿主 preset 后也要看到这句。/)
})
