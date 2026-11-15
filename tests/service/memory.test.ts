/**
 * 项目记忆：规则提取、写入去重、能力类同步 bot、上下文注入。
 *
 * 群聊自动收集的集成用例在 chat.test.ts（c16）；这里测纯函数和落库边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdFactory } from '../../src/domain/ids.ts'
import {
  createMemory,
  extractMemoryCandidates,
  listMemberMemories,
  listProjectMemories,
  memberMemoryBlock,
  projectMemoryBlock,
  updateMemory,
} from '../../src/service/memory.ts'
import { createHamsHttpHandler } from '../../src/http/handler.ts'
import { AT, IDS, createHarness } from './fixtures.ts'

test('m01 规则提取：决策/偏好/教训/事实各归其类，问句与寒暄跳过，单条最多 2 个', () => {
  const human = { authorKind: 'human' as const, authorId: IDS.owner, authorName: '王' }
  const one = (text: string) => extractMemoryCandidates(text, human)
  assert.equal(one('决定了：以后所有复查都用 72 小时窗口。')[0]?.kind, 'decision')
  assert.equal(one('我偏好在上午处理审批。')[0]?.kind, 'preference')
  assert.equal(one('注意：告警超过 24 小时未处理会被外部系统关闭。')[0]?.kind, 'lesson')
  assert.equal(one('口径：闭环率=已完成/总数，按周统计。')[0]?.kind, 'fact')
  assert.deepEqual(one('收到。'), [], '寒暄不记')
  assert.deepEqual(one('这周闭环率是多少？'), [], '问句不记')
  assert.deepEqual(one('决定了：口径以后按周统计。决定了：复查统一 72 小时。决定了：以后都用新模板。').map((row) => row.kind), ['decision', 'decision'], '单条最多 2 个')
})

test('m02 能力类只从 bot 的话里提取，并带上归属 bot', () => {
  const bot = { authorKind: 'bot' as const, authorId: IDS.coord, authorName: '运营协调' }
  const candidates = extractMemoryCandidates('我擅长先对账再下结论，步骤是先核台账再核现场照片。', bot)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'capability')
  assert.equal(candidates[0].memberId, IDS.coord)
  const fromHuman = extractMemoryCandidates('我擅长先对账再下结论，步骤是先核台账再核现场照片。', { authorKind: 'human', authorId: IDS.owner, authorName: '王' })
  assert.equal(fromHuman.length, 0, '人说的话不能自动变成 bot 能力')
})

test('m03 写入：同项目去重；能力类同步 bot，改正文时快照跟着改', (t) => {
  const h = createHarness(t)
  try {
    const ids = createIdFactory(() => h.clock.now)
    const decision = createMemory(h.db, ids, AT, IDS.owner, {
      projectId: IDS.project, kind: 'decision', title: '复查窗口', body: '以后统一用 72 小时窗口',
    })
    assert.equal(decision.created, true)
    assert.equal(decision.syncedTo, null)

    const duplicate = createMemory(h.db, ids, AT + 1, IDS.owner, {
      projectId: IDS.project, kind: 'decision', title: '复查窗口', body: '以后统一用 72 小时窗口',
    })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.memory.id, decision.memory.id)

    const capability = createMemory(h.db, ids, AT + 2, IDS.coord, {
      projectId: IDS.project, kind: 'capability', title: '先对账再下结论', body: '先核台账，再核现场照片',
      memberId: IDS.coord,
    })
    assert.equal(capability.created, true)
    assert.equal(capability.syncedTo, IDS.coord)
    assert.equal(listMemberMemories(h.db, IDS.coord).length, 1)

    updateMemory(h.db, AT + 3, { memoryId: capability.memory.id, body: '先核台账，再核现场照片，最后写结论' })
    assert.match(listMemberMemories(h.db, IDS.coord)[0].body, /最后写结论/)

    const active = listProjectMemories(h.db, { projectId: IDS.project, status: 'active' })
    assert.equal(active.length, 2)
    updateMemory(h.db, AT + 4, { memoryId: decision.memory.id, status: 'archived' })
    assert.equal(listProjectMemories(h.db, { projectId: IDS.project, status: 'active' }).length, 1)
    assert.equal(listProjectMemories(h.db, { projectId: IDS.project, status: 'archived' }).length, 1)
  } finally {
    h.close()
  }
})

test('m04 上下文注入：项目记忆与 bot 记忆都能拼成可读文本', (t) => {
  const h = createHarness(t)
  try {
    const ids = createIdFactory(() => h.clock.now)
    createMemory(h.db, ids, AT, IDS.owner, {
      projectId: IDS.project, kind: 'decision', title: '复查窗口', body: '以后统一用 72 小时窗口',
    })
    createMemory(h.db, ids, AT + 1, IDS.coord, {
      projectId: IDS.project, kind: 'capability', title: '先对账再下结论', body: '先核台账', memberId: IDS.coord,
    })
    const projectBlock = projectMemoryBlock(h.db, IDS.project)
    assert.match(projectBlock, /【项目记忆 · 2 条】/)
    assert.match(projectBlock, /\[决策\] 复查窗口/)
    const botBlock = memberMemoryBlock(h.db, IDS.coord)
    assert.match(botBlock, /【bot 记忆（从项目同步）】/)
    assert.match(botBlock, /先对账再下结论/)
    assert.equal(memberMemoryBlock(h.db, IDS.bot), '', '没同步过的 bot 不注入记忆')
  } finally {
    h.close()
  }
})

test('m05 服务层：记忆写入要项目管理员；项目详情带有效条数', (t) => {
  const h = createHarness(t)
  try {
    const created = h.service.createProjectMemory(h.ctx(IDS.owner, 'ui', 'mem-1'), {
      projectId: IDS.project, kind: 'lesson', title: '关单前先核证据', body: '证据缺失时先阻塞，不要硬关。',
    })
    assert.equal(created.ok, true)
    assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner), IDS.project).memory_count, 1)
    assert.equal(h.service.listProjectMemories(h.ctx(IDS.owner), { projectId: IDS.project })[0].title, '关单前先核证据')
    assert.throws(
      () => h.service.createProjectMemory(h.ctx(IDS.intern), { projectId: IDS.project, kind: 'fact', title: 'x', body: 'y' }),
      /project\.manage|能力|权限/,
    )
    const updated = h.service.updateProjectMemory(h.ctx(IDS.owner, 'ui', 'mem-2'), {
      memoryId: String(created.objectId), status: 'archived',
    })
    assert.equal(updated.ok, true)
    assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner), IDS.project).memory_count, 0)
  } finally {
    h.close()
  }
})

test('m06 HTTP：记忆列表/新建/归档走标准信封', (t) => {
  const h = createHarness(t)
  try {
    const handler = createHamsHttpHandler({ service: h.service, authenticate: () => ({ ok: true, principalId: IDS.owner }) })
    const call = (path: string, body: Record<string, unknown>) =>
      JSON.parse(handler({ method: 'POST', path: `/hams/api/v1/${path}`, headers: {}, body: JSON.stringify({ commandId: 'ui', ...body }) }).body)
    const created = call('project/memory/create', {
      idempotencyKey: 'memory-http-1',
      objectId: IDS.project,
      payload: { projectId: IDS.project, kind: 'decision', title: 'HTTP 记忆', body: '以后按这个来' },
    })
    assert.equal(created.ok, true)
    const listed = call('project/memory/list', { payload: { projectId: IDS.project } })
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0].title, 'HTTP 记忆')
    const archived = call('project/memory/update', {
      idempotencyKey: 'memory-http-2',
      objectId: listed.data[0].id,
      payload: { memoryId: listed.data[0].id, status: 'archived' },
    })
    assert.equal(archived.ok, true)
    const active = call('project/memory/list', { payload: { projectId: IDS.project, status: 'active' } })
    assert.equal(active.data.length, 0)
  } finally {
    h.close()
  }
})

