import test from 'node:test'
import assert from 'node:assert/strict'
import { createHamsHttpHandler, type HttpRequest, type HttpResponse } from '../../src/http/handler.ts'
import { HAMS_ERROR_CODES } from '../../src/domain/errors.ts'
import { NEXT_STEP } from '../../src/service/contracts.ts'
import { AT, DAY, IDS, alertInput, createHarness, driveToReview, type Harness } from './fixtures.ts'

const TOKENS: Record<string, string> = {
  'Bearer owner': IDS.owner,
  'Bearer approver': IDS.approver,
  'Bearer other': IDS.otherApprover,
  'Bearer bot': IDS.bot,
}

function makeHandler(h: Harness) {
  return createHamsHttpHandler({
    service: h.service,
    correlationId: () => `test-${Math.random().toString(36).slice(2, 8)}`,
    authenticate(request: HttpRequest) {
      const token = request.headers.authorization
      const principalId = token ? TOKENS[token] : undefined
      if (!principalId) return { ok: false, reason: 'UNAUTHORIZED' as const, message: '缺少或无效的令牌' }
      return { ok: true, principalId, authSubject: principalId }
    },
  })
}

function call(
  handler: (request: HttpRequest) => HttpResponse,
  path: string,
  body: unknown,
  auth = 'Bearer owner',
  method = 'POST',
): { status: number; body: any; headers: Record<string, string> } {
  const response = handler({
    method,
    path,
    headers: { authorization: auth, host: '127.0.0.1:61768' },
    body: body === undefined ? '' : JSON.stringify(body),
  })
  return { status: response.status, body: JSON.parse(response.body), headers: response.headers }
}

function write(commandId: string, payload: unknown, key: string, objectId?: string, extra: Record<string, unknown> = {}) {
  return { commandId, idempotencyKey: key, objectId, payload, ...extra }
}

test('h01 传输层：方法 / 路径 / 体积 / JSON 的错误用状态码，业务错误用回执', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)

  assert.equal(call(handler, '/hams/api/v1/session/whoami', undefined, 'Bearer owner', 'GET').status, 405)
  assert.equal(call(handler, '/hams/api/v1/nope/whatever', {}).status, 404)
  assert.equal(call(handler, '/other/path', {}).status, 404)
  assert.equal(call(handler, '/hams/api/v1/session/whoami', {}, 'Bearer owner').status, 200)

  const badJson = handler({
    method: 'POST',
    path: '/hams/api/v1/session/whoami',
    headers: { authorization: 'Bearer owner' },
    body: 'not json',
  })
  assert.equal(badJson.status, 400)

  const tooBig = handler({
    method: 'POST',
    path: '/hams/api/v1/session/whoami',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ commandId: 'x', pad: 'y'.repeat(300 * 1024) }),
  })
  assert.equal(tooBig.status, 413)

  const unauthorized = call(handler, '/hams/api/v1/session/whoami', {}, '')
  assert.equal(unauthorized.status, 401, '缺少会话/令牌属于「未认证」，用 401 区别于 403')
  assert.equal(unauthorized.body.ok, false)
  assert.equal(unauthorized.body.error.code, 'POLICY_DENIED')
  assert.ok(unauthorized.body.error.nextStep)
  h.close()
})

test('h02 通道隔离：bot 令牌不能调用 UI 接口', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const response = call(handler, '/hams/api/v1/session/whoami', { commandId: 'c1' }, 'Bearer bot')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.error.code, 'POLICY_DENIED')
  h.close()
})

test('h03 whoami 返回岗位与能力；响应是 JSON 且不回传堆栈', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const response = call(handler, '/hams/api/v1/session/whoami', { commandId: 'c1' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.data.principal.memberId, IDS.owner)
  assert.ok(response.body.data.capabilities.includes('work_item.accept'))
  assert.match(response.headers['content-type'], /application\/json/)
  assert.doesNotMatch(JSON.stringify(response.body), /file:\/\/|at async|node:internal/)
  h.close()
})

test('h04 读接口：列表、详情含 allowedActions、健康检查', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string

  const list = call(handler, '/hams/api/v1/workItem/list', { commandId: 'c1' })
  assert.equal(list.body.ok, true)
  assert.equal(list.body.data.length, 1)

  const detail = call(handler, '/hams/api/v1/workItem/get', { commandId: 'c2', objectId: workItemId })
  assert.equal(detail.body.data.id, workItemId)
  assert.ok(detail.body.data.allowedActions.includes('accept'))

  const health = call(handler, '/hams/api/v1/ops/health', { commandId: 'c3' })
  assert.equal(health.body.data.counts.workItems, 1)
  assert.equal(health.body.data.counts.openWorkItems, 1)
  assert.equal(health.body.data.schemaVersion, 9)
  h.close()
})

test('h05 人接单：写命令必须带幂等键，同键同载荷返回首次回执', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string

  const missingKey = call(handler, '/hams/api/v1/workItem/accept', { commandId: 'c1', objectId: workItemId, payload: {} })
  assert.equal(missingKey.body.ok, false)
  assert.match(missingKey.body.error.message, /idempotencyKey/)

  const first = call(handler, '/hams/api/v1/workItem/accept', write('c2', {}, 'idem-accept-1', workItemId))
  assert.equal(first.body.ok, true)
  assert.equal(first.body.status, 'applied')
  const auditsAfterFirst = h.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'work_item/accept'").get() as { c: number }

  const replay = call(handler, '/hams/api/v1/workItem/accept', write('c2', {}, 'idem-accept-1', workItemId))
  assert.deepEqual(replay.body, first.body, '同键同载荷必须原样返回首次回执')
  const auditsAfterReplay = h.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'work_item/accept'").get() as { c: number }
  assert.equal(auditsAfterReplay.c, auditsAfterFirst.c, '重放不能产生新的审计')

  const mismatch = call(handler, '/hams/api/v1/workItem/accept', write('c2', { note: '换个说法' }, 'idem-accept-1', workItemId))
  assert.equal(mismatch.body.ok, false)
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH')
  assert.ok(mismatch.body.error.nextStep.length > 0)
  h.close()
})

test('h06 业务失败返回 200 + 错误码 + nextStep，而不是抛 500', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  call(handler, '/hams/api/v1/workItem/accept', write('c1', {}, 'k1', workItemId))

  const again = call(handler, '/hams/api/v1/workItem/accept', write('c2', {}, 'k2', workItemId))
  assert.equal(again.status, 200)
  assert.equal(again.body.ok, false)
  assert.equal(again.body.error.code, 'STATE_INVALID')
  assert.ok(again.body.error.nextStep.length > 0)

  const noObject = call(handler, '/hams/api/v1/workItem/pause', write('c3', {}, 'k3'))
  assert.equal(noObject.body.ok, false)
  assert.equal(noObject.body.error.code, 'STATE_INVALID')
  h.close()
})

test('h07 修订号前置校验：过期客户端拿到 VERSION_CONFLICT', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  const revision = h.service.getWorkItem(h.ctx(IDS.owner), workItemId).revision

  const stale = call(
    handler,
    '/hams/api/v1/workItem/accept',
    write('c1', {}, 'k1', workItemId, { expectedRevision: revision - 1 }),
  )
  assert.equal(stale.body.ok, false)
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT')

  const fresh = call(
    handler,
    '/hams/api/v1/workItem/accept',
    write('c2', {}, 'k2', workItemId, { expectedRevision: revision }),
  )
  assert.equal(fresh.body.ok, true)
  h.close()
})

test('h08 审批决定走 UI 通道：指定人可批，非指定人 NOT_APPROVER', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const { approvalId } = driveToReview(h)

  const other = call(
    handler,
    '/hams/api/v1/approval/decide',
    write('c1', { decision: 'approve' }, 'k1', approvalId),
    'Bearer other',
  )
  assert.equal(other.body.ok, false)
  assert.equal(other.body.error.code, 'NOT_APPROVER')

  const owner = call(
    handler,
    '/hams/api/v1/approval/decide',
    write('c2', { decision: 'approve' }, 'k2', approvalId),
  )
  assert.equal(owner.body.ok, true)
  assert.equal(owner.body.detail.workItemStatus, 'completed')
  h.close()
})

test('h09 读取类：check/list 与 approval/list', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const { workItemId, approvalId } = driveToReview(h)

  const checks = call(handler, '/hams/api/v1/check/list', { commandId: 'c1', payload: { workItemId } })
  assert.equal(checks.body.ok, true)
  assert.ok(checks.body.data.length >= 1)

  const approvals = call(handler, '/hams/api/v1/approval/list', { commandId: 'c2', payload: { status: 'pending' } })
  assert.equal(approvals.body.ok, true)
  assert.equal(approvals.body.data[0].id, approvalId)
  h.close()
})

test('h10 生命周期命令走 HTTP：暂停 / 恢复 / 取消', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const ingested = h.service.ingestAlert(h.ctx('system', 'system'), alertInput())
  const workItemId = ingested.objectId as string
  call(handler, '/hams/api/v1/workItem/accept', write('c1', {}, 'k1', workItemId))

  const paused = call(handler, '/hams/api/v1/workItem/pause', write('c2', { reason: '断电' }, 'k2', workItemId))
  assert.equal(paused.body.ok, true)
  assert.equal(paused.body.detail.status, 'paused')

  const resumed = call(handler, '/hams/api/v1/workItem/resume', write('c3', {}, 'k3', workItemId))
  assert.equal(resumed.body.ok, true)
  assert.equal(resumed.body.detail.status, 'active')

  const cancelled = call(handler, '/hams/api/v1/workItem/cancel', write('c4', { reason: '报废' }, 'k4', workItemId))
  assert.equal(cancelled.body.ok, true)
  assert.equal(cancelled.body.detail.status, 'cancelled')
  h.close()
})

test('h11 每个错误码都有界面文案，且回执里的 nextStep 不会为空', () => {
  for (const code of HAMS_ERROR_CODES) {
    assert.equal(typeof NEXT_STEP[code], 'string', `${code} 缺少文案`)
    assert.ok(NEXT_STEP[code].length > 0, `${code} 的文案为空`)
  }
  assert.equal(HAMS_ERROR_CODES.length, 15)
})

test('h12 读模型走 HTTP：overview/get、changes/since、proposal/list', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const { approvalId } = driveToReview(h)
  h.service.propose(h.ctx(IDS.bot, 'tool'), {
    kind: 'create_task',
    subjectKey: `project:${IDS.project}`,
    dedupeKey: 'http-proposal-1',
    deciderId: IDS.owner,
    title: '补读数',
    body: '离线',
    rationale: { evidence: [{ ref: 'alert:offline' }] },
  })

  const overview = call(handler, '/hams/api/v1/overview/get', { commandId: 'c1' })
  assert.equal(overview.body.ok, true)
  assert.equal(overview.body.data.approvals[0].id, approvalId)
  assert.equal(overview.body.data.proposals.length, 1)
  assert.ok(overview.body.data.latestChangeSeq > 0)

  const changes = call(handler, '/hams/api/v1/changes/since', { commandId: 'c2', payload: { cursor: 0, limit: 5 } })
  assert.equal(changes.body.ok, true)
  assert.ok(changes.body.data.items.length > 0)
  assert.ok(changes.body.data.nextCursor > 0)

  const proposals = call(handler, '/hams/api/v1/proposal/list', {
    commandId: 'c3',
    payload: { deciderId: IDS.owner, status: 'open' },
  })
  assert.equal(proposals.body.data.length, 1)
  h.close()
})

test('h13 人工建单走 HTTP：默认负责人是自己，参数缺失给 STATE_INVALID', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)
  const created = call(
    handler,
    '/hams/api/v1/workItem/create',
    write('c1', { domain: '安全', category: '安全响应', title: '界面补录' }, 'k-create-1'),
  )
  assert.equal(created.body.ok, true)
  const detail = call(handler, '/hams/api/v1/workItem/get', { commandId: 'c2', objectId: created.body.objectId })
  assert.equal(detail.body.data.owner_human_id, IDS.owner)

  const missing = call(
    handler,
    '/hams/api/v1/workItem/create',
    write('c3', { domain: '安全', category: '安全响应' }, 'k-create-2'),
  )
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error.code, 'STATE_INVALID')
  assert.ok(missing.body.error.nextStep.length > 0)
  h.close()
})

// ───────────────────────── M6：项目 / 成员 / 知识走 HTTP ─────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sandboxPath } from '../store/helpers.ts'

test('h14 项目三屏走 HTTP：列表、详情、建项目、记读数', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)

  const list = call(handler, '/hams/api/v1/project/list', { commandId: 'c1', payload: {} })
  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].owner_name, '王（负责人）')

  const detail = call(handler, '/hams/api/v1/project/get', { commandId: 'c2', objectId: IDS.project })
  assert.equal(detail.body.data.metrics.length, 2)
  assert.ok(detail.body.data.allowedActions.includes('createWorkItem'))

  const created = call(
    handler,
    '/hams/api/v1/project/create',
    write('c3', {
      name: 'HTTP 建的备件项目',
      type: 'one_off',
      goalText: '周转天数 ≤ 7',
      metrics: [{ name: '周转天数', direction: 'lower', targetValue: 7, unit: '天', windowKind: 'week' }],
    }, 'http-project-1'),
  )
  assert.equal(created.body.ok, true)
  assert.equal(created.body.status, 'applied')
  const projectId = created.body.objectId

  const after = call(handler, '/hams/api/v1/project/get', { commandId: 'c4', objectId: projectId })
  const metricId = after.body.data.metrics[0].id
  const observed = call(
    handler,
    '/hams/api/v1/project/recordMetric',
    write('c5', { projectId, metricId, value: 6.5, sourceRef: '手动' }, 'http-metric-1'),
  )
  assert.equal(observed.body.ok, true)
  assert.equal(observed.body.detail.metricId, metricId)

  const denied = call(
    handler,
    '/hams/api/v1/project/create',
    write('c6', { name: '只读主体建的项目', type: 'one_off', goalText: 'x' }, 'http-project-2'),
    'Bearer approver',
  )
  assert.equal(denied.body.ok, false)
  assert.equal(denied.body.error.code, 'POLICY_DENIED')
  h.close()
})

test('h15 成员与知识走 HTTP：建 bot、同步技能与表、写文档、导入目录', () => {
  const h = createHarness(test)
  const handler = makeHandler(h)

  const members = call(handler, '/hams/api/v1/member/list', { commandId: 'c1', payload: {} })
  assert.equal(members.body.ok, true)
  assert.equal(members.body.data.length, 6)
  const positions = call(handler, '/hams/api/v1/position/list', { commandId: 'c2' })
  assert.ok(positions.body.data.some((position: { id: string }) => position.id === 'pos_owner'))

  const bot = call(
    handler,
    '/hams/api/v1/member/create',
    write('c3', {
      kind: 'bot',
      name: 'HTTP 建的 bot',
      capabilities: ['work_item.claim', 'evidence.append'],
    }, 'http-member-1'),
  )
  assert.equal(bot.body.ok, true)
  const botId = bot.body.objectId
  const botDetail = call(handler, '/hams/api/v1/member/get', { commandId: 'c4', objectId: botId })
  assert.equal(botDetail.body.data.kind, 'bot')
  assert.deepEqual(botDetail.body.data.capabilities.sort(), ['evidence.append', 'work_item.claim'])
  assert.equal(botDetail.body.data.allowedActions.length, 3)

  // 真实技能目录：写一份 SKILL.md，再让 HTTP 同步。
  const skillDir = sandboxPath(h.root, 'skills', 'http-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: http-skill\ndescription: HTTP 同步的技能\n---\n\n# 正文\n', 'utf8')
  const synced = call(handler, '/hams/api/v1/knowledge/sync', write('c5', {}, 'http-sync-1'))
  assert.equal(synced.body.ok, true)
  assert.equal(synced.body.detail.report.skills.created, 1)
  assert.equal(synced.body.detail.report.tables.created, 12)

  const knowledge = call(handler, '/hams/api/v1/knowledge/list', { commandId: 'c6', payload: {} })
  assert.equal(knowledge.body.data.counts.skills, 1)
  assert.equal(knowledge.body.data.counts.tables, 12)

  const doc = call(
    handler,
    '/hams/api/v1/knowledge/createDoc',
    write('c7', { title: 'HTTP 写的文档', body: '正文内容' }, 'http-doc-1'),
  )
  assert.equal(doc.body.ok, true)
  const docDetail = call(handler, '/hams/api/v1/knowledge/get', {
    commandId: 'c8',
    payload: { kind: 'doc', id: doc.body.objectId },
  })
  assert.equal(docDetail.body.data.kind, 'doc')
  assert.match(docDetail.body.data.content, /正文内容/)

  const source = sandboxPath(h.root, 'notes')
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'p.md'), '# 导入的笔记\n\n正文\n', 'utf8')
  const imported = call(
    handler,
    '/hams/api/v1/knowledge/importDocs',
    write('c9', { dir: source }, 'http-import-1'),
  )
  assert.equal(imported.body.ok, true)
  assert.equal(imported.body.detail.report.imported, 1)

  const denied = call(
    handler,
    '/hams/api/v1/member/create',
    write('c10', { kind: 'human', name: '越权', positionId: 'pos_approver' }, 'http-member-2'),
    'Bearer approver',
  )
  assert.equal(denied.body.ok, false)
  assert.equal(denied.body.error.code, 'POLICY_DENIED')
  h.close()
})
