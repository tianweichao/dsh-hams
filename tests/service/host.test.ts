import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bootstrapStore } from '../../src/store/bootstrap.ts'
import { ensureLocalOperator } from '../../src/host/dsh-adapter.ts'
import { API_PREFIX, ROUTE_PATHS } from '../../src/http/handler.ts'
import {
  applyHams,
  checkHostSession,
  isAllowedOrigin,
  readRequestBody,
  registerHams,
  toHeaderRecord,
  toHostParameters,
  type HostConnection,
  type HostContext,
  type HostPeerAdmission,
} from '../../src/host/dsh-adapter.ts'
import { AT, IDS, seedTestData } from './fixtures.ts'
import { createSandbox, sandboxPath } from '../store/helpers.ts'

function prepareDataDir(root: string): string {
  const dataDir = sandboxPath(root, 'hams')
  const runtime = bootstrapStore({ dataDir, now: () => AT })
  seedTestData(runtime.db)
  runtime.close()
  return dataDir
}

function fakeCtx(options: { connection?: HostConnection } = {}): {
  ctx: HostContext
  routes: Map<string, { kind: string; path: string; handler: (req: any, res: any) => unknown }>
  tools: any[]
  removed: string[]
} {
  const routes = new Map<string, { kind: string; path: string; handler: (req: any, res: any) => unknown }>()
  const tools: any[] = []
  const removed: string[] = []
  const ctx: HostContext = {
    webServer: {
      register(spec) {
        routes.set(spec.path, spec as never)
        return () => {
          routes.delete(spec.path)
          removed.push(`route:${spec.path}`)
        }
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => removed.push(`tool:${(tool as { name?: string }).name}`)
      },
    },
    logger: { info() {} },
    // 与 Cordis 一致：服务只能通过 get() 读，属性访问会抛 without inject。
    get(name: string) {
      return name === 'connection' ? options.connection : undefined
    },
  }
  return { ctx, routes, tools, removed }
}

/** 假宿主 connection：把 admit 的入参记下来，按给定的判定返回。 */
function fakeConnection(
  outcome: HostPeerAdmission | (() => HostPeerAdmission),
  seen: Record<string, string | undefined>[] = [],
): HostConnection {
  return {
    admit(request) {
      seen.push(request.headers)
      return typeof outcome === 'function' ? outcome() : outcome
    },
  }
}

function fakeRequest(body: string | undefined, headers: Record<string, string> = {}): any {
  return {
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  }
}

function fakeResponse(): any {
  const response: any = { status: 0, headers: {}, body: '' }
  response.writeHead = (status: number, headers: Record<string, string>) => {
    response.status = status
    response.headers = headers
  }
  response.end = (body: string) => {
    response.body = body
  }
  return response
}

async function invoke(
  route: { handler: (req: any, res: any) => unknown },
  body: unknown,
  headers: Record<string, string> = { origin: 'http://127.0.0.1:61768' },
): Promise<{ status: number; body: any }> {
  const res = fakeResponse()
  await route.handler(fakeRequest(body === undefined ? '' : JSON.stringify(body), headers), res)
  return { status: res.status, body: JSON.parse(res.body) }
}

const CONFIG = {
  localPrincipalId: IDS.owner,
  defaultBotMemberId: IDS.bot,
  tickEnabled: false,
  toolsEnabled: true,
} as const

test('p01 注册全部精确路由与 15 个工具，路径/名字与契约一致', () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const { ctx, routes, tools } = fakeCtx()
  const registered = registerHams(ctx, { ...CONFIG, dataDir })
  try {
    assert.equal(registered.mode, 'writer')
    assert.equal(routes.size, ROUTE_PATHS.length)
    assert.deepEqual(registered.routes, ROUTE_PATHS.map((path) => `${API_PREFIX}${path}`))
    for (const [path, spec] of routes) {
      assert.equal(spec.kind, 'exact', `${path} 必须是精确匹配`)
      assert.ok(path.startsWith('/hams/api/v1/'))
    }
    assert.equal(tools.length, 15)
    assert.deepEqual(registered.toolNames.sort(), tools.map((tool) => tool.name).sort())
    assert.ok(!tools.some((tool) => tool.name.includes('decide') || tool.name.includes('close')))
  } finally {
    registered.dispose()
  }
})

test('p02 路由经宿主 req/res 读写：whoami 返回主体与能力，Origin 非同源被拦', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const { ctx, routes } = fakeCtx()
  const registered = registerHams(ctx, { ...CONFIG, dataDir })
  try {
    const whoami = routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.data.principal.memberId, IDS.owner)

    const evil = await invoke(whoami, { commandId: 'c2' }, { origin: 'http://evil.example.com' })
    assert.equal(evil.status, 403)
    assert.equal(evil.body.ok, false)
  } finally {
    registered.dispose()
  }
})

test('p02b 宿主会话：无 cookie 401 / 已认证 Peer 200 / Host 不可信 403', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const headers = (extra: Record<string, string> = {}) => ({
    origin: 'http://127.0.0.1:61768',
    host: '127.0.0.1:61768',
    ...extra,
  })

  // ① 没换过宿主令牌：没有 cookie，宿主判 401 → HAMS 401，且告诉界面怎么重开
  const seen: Record<string, string | undefined>[] = []
  const anonymous = fakeCtx({ connection: fakeConnection({ rejection: 401 }, seen) })
  const first = registerHams(anonymous.ctx, { ...CONFIG, dataDir })
  try {
    assert.equal(first.sessionState, 'host', '宿主提供 connection 就必须走会话校验')
    const whoami = anonymous.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' }, headers({ cookie: 'dsh-auth-abc=v1.x.y' }))
    assert.equal(response.status, 401)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'POLICY_DENIED')
    assert.match(response.body.error.nextStep, /\?token=/)
    assert.equal(response.body.data, undefined, '未认证请求不能碰到业务数据')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].cookie, 'dsh-auth-abc=v1.x.y', 'cookie 头要原样交给宿主判定')
  } finally {
    first.dispose()
  }

  // ② 已认证的浏览器 Peer：放行并正常返回主体
  const authed = fakeCtx({ connection: fakeConnection({ peer: { principal: { kind: 'owner' } } }) })
  const second = registerHams(authed.ctx, { ...CONFIG, dataDir })
  try {
    const whoami = authed.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c2' }, headers({ cookie: 'dsh-auth-abc=v1.x.y' }))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.principal.memberId, IDS.owner)
  } finally {
    second.dispose()
  }

  // ③ Host/Origin 不可信（宿主判 403）：重开也没用，nextStep 不指向 token
  const denied = fakeCtx({ connection: fakeConnection({ rejection: 403 }) })
  const third = registerHams(denied.ctx, { ...CONFIG, dataDir })
  try {
    const whoami = denied.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c3' }, headers({ cookie: 'dsh-auth-abc=v1.x.y' }))
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'POLICY_DENIED')
    assert.doesNotMatch(response.body.error.nextStep, /\?token=/)
  } finally {
    third.dispose()
  }
})

test('p02c 宿主只给 requestRejection 也能用；admit 抛异常按 403 处理', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)

  const onlyRejection = fakeCtx({
    connection: { requestRejection: () => 401 },
  })
  const first = registerHams(onlyRejection.ctx, { ...CONFIG, dataDir })
  try {
    const whoami = onlyRejection.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' })
    assert.equal(response.status, 401)
  } finally {
    first.dispose()
  }

  const broken = fakeCtx({
    connection: {
      admit() {
        throw new Error('connection disposed')
      },
    },
  })
  const second = registerHams(broken.ctx, { ...CONFIG, dataDir })
  try {
    const whoami = broken.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c2' })
    assert.equal(response.status, 403, '宿主判定失败时宁可拒，也不放行写请求')
    assert.match(response.body.error.message, /connection disposed/)
  } finally {
    second.dispose()
  }
})

test('p02d hostSession=off 只验 Origin；hostSession=require 无 connection 时一律 403', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)

  const off = fakeCtx({ connection: fakeConnection({ rejection: 401 }) })
  const first = registerHams(off.ctx, { ...CONFIG, dataDir, hostSession: 'off' })
  try {
    assert.equal(first.sessionState, 'off')
    const whoami = off.routes.get(`${API_PREFIX}session/whoami`)!
    assert.equal((await invoke(whoami, { commandId: 'c1' })).status, 200)
    // Origin 白名单仍然是硬约束：off 不等于「什么都放」
    const evil = await invoke(whoami, { commandId: 'c2' }, { origin: 'http://evil.example.com' })
    assert.equal(evil.status, 403)
  } finally {
    first.dispose()
  }

  const strict = fakeCtx()
  const second = registerHams(strict.ctx, { ...CONFIG, dataDir, hostSession: 'require' })
  try {
    assert.equal(second.sessionState, 'origin-only')
    const whoami = strict.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c3' })
    assert.equal(response.status, 403)
    assert.match(response.body.error.message, /connection/)
  } finally {
    second.dispose()
  }
})

test('p02e 通道隔离仍在：宿主会话通过、但主体是 bot 时不能走界面接口', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const ctx = fakeCtx({ connection: fakeConnection({ peer: { principal: { kind: 'owner' } } }) })
  const registered = registerHams(ctx.ctx, { ...CONFIG, dataDir, localPrincipalId: IDS.bot })
  try {
    const whoami = ctx.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, 'POLICY_DENIED')
    assert.match(response.body.error.message, /工具通道/)
  } finally {
    registered.dispose()
  }
})

test('p02f checkHostSession：owner 通过，其他主体拒绝，无 connection 时按模式决定', () => {
  const headers = { host: '127.0.0.1:61768' }
  assert.deepEqual(checkHostSession(fakeConnection({ peer: { principal: { kind: 'owner' } } }), headers), { ok: true })
  const foreign = checkHostSession(fakeConnection({ peer: { principal: { kind: 'bot' } } }), headers)
  assert.equal(foreign.ok, false)
  assert.equal(foreign.reason, 'FORBIDDEN')
  assert.equal(checkHostSession(undefined, headers, 'auto').ok, true)
  assert.equal(checkHostSession(undefined, headers, 'require').ok, false)
  assert.equal(checkHostSession(undefined, headers, 'off').ok, true)
})

test('p03 写路由：接单成功；工具 claim 通过宿主工具对象也能跑', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const { ctx, routes, tools } = fakeCtx()
  const registered = registerHams(ctx, { ...CONFIG, dataDir })
  try {
    // 先经服务层造一条 ready 单（连接器通道不在本测试范围）
    const ingested = registered.service.ingestAlert(
      { principalId: 'system', channel: 'system', correlationId: 'seed' },
      {
        connector: 'bms',
        externalEventId: 'evt-host-1',
        eventType: 'overdischarge',
        occurredAt: AT,
        payloadRef: 'evidence/inbox/evt-host-1.json',
        asset: { externalSystem: 'bms', externalId: 'BT-90001', displayName: '电池 BT-90001' },
        workItem: {
          domain: '安全',
          category: '安全响应',
          title: 'BT-90001 过放告警',
          projectId: IDS.project,
          ownerHumanId: IDS.owner,
          templateVersionId: IDS.templateVersion,
          dedupeKey: 'alert:BT-90001:overdischarge',
        },
      },
    )
    const workItemId = ingested.objectId as string

    const acceptRoute = routes.get(`${API_PREFIX}workItem/accept`)!
    const accepted = await invoke(acceptRoute, {
      commandId: 'c3',
      idempotencyKey: 'host-accept-1',
      objectId: workItemId,
      payload: {},
    })
    assert.equal(accepted.body.ok, true)

    const claimTool = tools.find((tool) => tool.name === 'hams_claim')!
    assert.deepEqual(claimTool.parameters.required, ['id'], 'required 必须在对象层，属性节点不允许标 required')
    assert.deepEqual(claimTool.output.schema.required, ['ok', 'render'])
    const result = await claimTool.execute({ id: workItemId }, { agent: { session: { id: 'host-session-1' } } })
    assert.equal(result.ok, false, '工作项已 active，不能再 claim')
    assert.match(result.render, /STATE_INVALID/)
    assert.match(result.render, /下一步：/)
  } finally {
    registered.dispose()
  }
})

test('p04 重启：dispose 释放写锁，下一次注册重新成为写者', () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const first = fakeCtx()
  const registered = registerHams(first.ctx, { ...CONFIG, dataDir })
  registered.dispose()

  const second = fakeCtx()
  const again = registerHams(second.ctx, { ...CONFIG, dataDir })
  try {
    assert.equal(again.mode, 'writer')
    assert.ok(again.report?.runtimeEpoch)
  } finally {
    again.dispose()
  }
})

test('p05 第二实例降级只读：写命令被拒并说明原因，读命令可用', async () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const first = fakeCtx()
  const writer = registerHams(first.ctx, { ...CONFIG, dataDir })
  const second = fakeCtx()
  const reader = registerHams(second.ctx, { ...CONFIG, dataDir })
  try {
    assert.equal(writer.mode, 'writer')
    assert.equal(reader.mode, 'reader')

    const listRoute = second.routes.get(`${API_PREFIX}workItem/list`)!
    const listed = await invoke(listRoute, { commandId: 'r1' })
    assert.equal(listed.body.ok, true)

    const acceptRoute = second.routes.get(`${API_PREFIX}workItem/accept`)!
    const rejected = await invoke(acceptRoute, {
      commandId: 'r2',
      idempotencyKey: 'readonly-1',
      objectId: 'whatever',
      payload: {},
    })
    assert.equal(rejected.body.ok, false)
    assert.equal(rejected.body.error.code, 'HOST_CAPABILITY_MISSING')
    assert.match(rejected.body.error.message, /写锁/)
  } finally {
    reader.dispose()
    writer.dispose()
  }
})

test('p06 适配器的小工具：Origin 判定、头归一化、请求体读取、参数 DSL', async () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:61768'), true)
  assert.equal(isAllowedOrigin('http://localhost:3000'), true)
  assert.equal(isAllowedOrigin('https://example.com'), false)
  assert.deepEqual(toHeaderRecord({ Origin: 'x', 'X-Test': ['a', 'b'] }), { origin: 'x', 'x-test': 'a,b' })

  assert.equal(await readRequestBody({ body: 'abc' }), 'abc')
  const streamed = fakeRequest('hello')
  assert.equal(await readRequestBody(streamed), 'hello')

  const parameters = toHostParameters({
    type: 'object',
    properties: { id: { type: 'string' }, limit: { type: 'number' } },
    required: ['id'],
  })
  assert.deepEqual(parameters, {
    type: 'object',
    properties: { id: { type: 'string' }, limit: { type: 'number' } },
    required: ['id'],
    additionalProperties: false,
  })
})

test('p07 applyHams 在有 ctx.effect 时托管生命周期', () => {
  const root = createSandbox(test)
  const dataDir = prepareDataDir(root)
  const { ctx, routes } = fakeCtx()
  let cleanup: (() => void) | null = null
  const withEffect: HostContext = {
    ...ctx,
    effect(fn) {
      cleanup = fn() as () => void
      return undefined
    },
  }
  const registered = applyHams(withEffect, { ...CONFIG, dataDir })
  assert.ok(registered)
  assert.equal(routes.size, ROUTE_PATHS.length)
  assert.ok(cleanup)
  cleanup!()
  assert.equal(routes.size, 0)
})

test('p08 首次使用：自动建本机操作者（只建一次），面板不再 403', async () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'hams')

  const first = fakeCtx()
  const registered = registerHams(first.ctx, { dataDir, tickEnabled: false, toolsEnabled: false })
  try {
    assert.equal(registered.mode, 'writer')
    const operator = registered.db
      .prepare("SELECT member_id, display_name FROM hams_user WHERE auth_source = 'local_host'")
      .get() as { member_id: string; display_name: string }
    assert.equal(operator.member_id, 'h-owner')
    assert.equal(operator.display_name, '本机操作者')

    const whoami = first.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' })
    assert.equal(response.status, 200)
    assert.equal(response.body.data.principal.memberId, 'h-owner')
    assert.ok(response.body.data.capabilities.includes('approval.decide'))

    const again = ensureLocalOperator(registered.db)
    assert.equal(again, 'h-owner')
    assert.equal(
      Number((registered.db.prepare("SELECT COUNT(*) AS c FROM member WHERE kind = 'human'").get() as { c: number }).c),
      1,
      '第二次启动不能重复建人',
    )
  } finally {
    registered.dispose()
  }

  const second = fakeCtx()
  const reopened = registerHams(second.ctx, { dataDir, tickEnabled: false, toolsEnabled: false })
  try {
    assert.equal(
      Number((reopened.db.prepare("SELECT COUNT(*) AS c FROM hams_user WHERE auth_source = 'local_host'").get() as { c: number }).c),
      1,
    )
  } finally {
    reopened.dispose()
  }
})

test('p09 空库首次启动就带一个已发布模板；重启不重复造（M5 建单→关单闭环的默认判据）', async () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'hams')

  const first = fakeCtx()
  const registered = registerHams(first.ctx, { tickEnabled: false, toolsEnabled: false, dataDir })
  try {
    const route = first.routes.get(`${API_PREFIX}template/list`)!
    const listed = await invoke(route, { commandId: 't1' })
    assert.equal(listed.status, 200)
    assert.equal(listed.body.data.length, 1, '空库要有 1 个起步模板，否则人工建的单永远关不掉')
    const template = listed.body.data[0]
    assert.equal(template.key, 'research_delivery')
    assert.equal(template.name, '研究与交付推进')
    assert.equal(template.domain, '研究')
    assert.equal(template.version, 1)
    assert.equal(template.version_status, 'published')
    assert.ok(template.published_version_id, '必须已发布，建单才能绑')
  } finally {
    registered.dispose()
  }

  const second = fakeCtx()
  const reopened = registerHams(second.ctx, { tickEnabled: false, toolsEnabled: false, dataDir })
  try {
    const listed = await invoke(second.routes.get(`${API_PREFIX}template/list`)!, { commandId: 't2' })
    assert.equal(listed.body.data.length, 1, '第二次启动不能再造一个')
    assert.equal(
      Number((reopened.db.prepare('SELECT COUNT(*) AS c FROM work_template_version').get() as { c: number }).c),
      1,
    )
  } finally {
    reopened.dispose()
  }
})

test('p10 M5 全流程走 HTTP：建单(带模板) → 接单 → 补证据 → 申请关单 → 审批 → 关单', async () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'hams')
  const ctxs = fakeCtx()
  const registered = registerHams(ctxs.ctx, { tickEnabled: false, toolsEnabled: false, dataDir })
  const call = async (command: string, body: Record<string, unknown> = {}) => {
    const response = await invoke(ctxs.routes.get(`${API_PREFIX}${command}`)!, {
      commandId: `c-${Math.random().toString(36).slice(2, 8)}`,
      ...body,
    })
    assert.equal(response.status, 200, `${command} 传输层必须是 200：${JSON.stringify(response.body)}`)
    return response.body
  }

  try {
    const templates = (await call('template/list')).data
    const templateVersionId = templates[0].published_version_id

    const created = await call('workItem/create', {
      idempotencyKey: `create-${Date.now()}`,
      payload: { domain: '研究', category: '研究推进', title: '把行业融资监控接进每日巡检', templateVersionId },
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const workItemId = created.objectId as string

    const accepted = await call('workItem/accept', {
      idempotencyKey: `accept-${Date.now()}`,
      objectId: workItemId,
      payload: {},
    })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))

    // 模板要求：doc ≥ 1 份 + log ≥ 1 份
    for (const [kind, ref] of [['doc', '01-invest/projects/funding-monitor/README.md'], ['log', 'cron/funding-monitor/2026-11-15.log']]) {
      const appended = await call('workItem/addEvidence', {
        idempotencyKey: `ev-${kind}-${ref}`,
        objectId: workItemId,
        payload: { kind, ref, observedAt: AT, source: 'panel' },
      })
      assert.equal(appended.ok, true, `${kind} 证据写入失败：${JSON.stringify(appended)}`)
    }

    const requested = await call('workItem/requestClosure', {
      idempotencyKey: `close-${Date.now()}`,
      objectId: workItemId,
      payload: { reason: '2 条读数 + 1 张照片已齐，请审批关单' },
    })
    assert.equal(requested.ok, true, JSON.stringify(requested))

    const approvals = (await call('approval/list', { payload: { status: 'pending' } })).data
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].subject_id, workItemId)

    const decided = await call('approval/decide', {
      idempotencyKey: `decide-${Date.now()}`,
      objectId: approvals[0].id,
      payload: { decision: 'approve', note: '证据齐，同意关单' },
    })
    assert.equal(decided.ok, true, JSON.stringify(decided))

    const final = (await call('workItem/get', { objectId: workItemId })).data
    assert.equal(final.status, 'completed', '批准与关单同一步：状态必须直接到 completed')
    assert.ok(final.completed_at)

    const overview = (await call('overview/get')).data
    assert.equal(overview.counts.byStatus.completed, 1)
    assert.equal(overview.counts.myOpen, 0)
  } finally {
    registered.dispose()
  }
})

test('p16 老库升级：给本机负责人岗位补授 M6 能力，知识源默认指向 $DSH_HOME/skills', async () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'hams')
  const skillRoot = sandboxPath(root, 'home', 'skills')
  const skillDir = path.join(skillRoot, 'demo-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示\n---\n\n# 正文\n', 'utf8')

  const first = fakeCtx()
  const registered = registerHams(first.ctx, {
    dataDir,
    tickEnabled: false,
    toolsEnabled: false,
    knowledgeSkillDirs: [skillRoot],
  })
  try {
    const whoami = first.routes.get(`${API_PREFIX}session/whoami`)!
    const response = await invoke(whoami, { commandId: 'c1' })
    const capabilities = response.body.data.capabilities as string[]
    for (const capability of [
      'project.create',
      'project.manage',
      'project.archive',
      'metric.record',
      'member.manage',
      'knowledge.write',
      'knowledge.sync',
    ]) {
      assert.ok(capabilities.includes(capability), `本机负责人应当有 ${capability}`)
    }
    assert.ok(registered.operatorCapabilitiesAdded >= 7)

    const synced = registered.service.syncKnowledge({
      principalId: 'h-owner',
      channel: 'ui',
      correlationId: 'sync-1',
      idempotencyKey: 'sync-1',
    })
    assert.equal(synced.ok, true)
    const list = registered.service.listKnowledge({
      principalId: 'h-owner',
      channel: 'ui',
      correlationId: 'list-1',
    })
    assert.equal(list.counts.skills, 1)
    assert.equal(list.counts.tables, 12)
    assert.deepEqual(list.sources.skill_dirs, [skillRoot])
    assert.match(list.sources.docs_dir, /knowledge[/\\]docs$/)
  } finally {
    registered.dispose()
  }

  const second = fakeCtx()
  const reopened = registerHams(second.ctx, { dataDir, tickEnabled: false, toolsEnabled: false, knowledgeSkillDirs: [skillRoot] })
  try {
    assert.equal(reopened.operatorCapabilitiesAdded, 0, '第二次启动不应重复补授')
    const list = reopened.service.listKnowledge({
      principalId: 'h-owner',
      channel: 'ui',
      correlationId: 'list-2',
    })
    assert.equal(list.counts.skills, 1, '技能与表登记在重启后保留')
  } finally {
    reopened.dispose()
  }
})

test('p17 启动时应用工作区画像：真实项目/成员/文档进库，二次启动不重复', async () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'hams')
  const docsDir = sandboxPath(root, 'notes')
  mkdirSync(docsDir, { recursive: true })
  const docPath = path.join(docsDir, 'real.md')
  writeFileSync(docPath, '# 真实文档\n\n来自工作区\n', 'utf8')
  const profileFile = sandboxPath(root, 'profile.json')
  writeFileSync(
    profileFile,
    JSON.stringify({
      version: 1,
      workspaceRoot: root,
      template: {
        id: 'tpl-profile-start',
        versionId: 'tpl-profile-start-v1',
        key: 'profile_start',
        name: '画像启动模板',
        domain: '研究',
        category: '研究推进',
        requiredEvidence: [{ kind: 'doc', min_count: 1 }],
        checkPolicy: { mode: 'after_hours', hours: 72 },
        reviewPolicy: { approver: 'owner', expires_hours: 72, auto_close: false },
      },
      members: [{ key: 'b', kind: 'bot', name: '画像启动 bot', capabilities: ['work_item.claim'] }],
      projects: [
        {
          key: 'p',
          name: '画像启动项目',
          type: 'continuous',
          status: 'active',
          goalText: '验证启动时应用画像',
          coordinatorKey: 'b',
          metrics: [{ name: '条目', direction: 'higher', targetValue: 10, unit: '条', windowKind: 'snapshot' }],
        },
      ],
      workItems: [
        { key: 'w', projectKey: 'p', title: '画像启动工作项', domain: '研究', category: '研究推进', dueInDays: 2 },
      ],
      docs: [{ path: 'notes/real.md', title: '真实工作区文档' }],
      overview: { title: '启动画像总览', body: '正文' },
      cleanupTemplates: ['tpl-battery-alert'],
    }),
    'utf8',
  )

  const first = fakeCtx()
  const registered = registerHams(first.ctx, {
    dataDir,
    tickEnabled: false,
    toolsEnabled: false,
    workspaceProfileFile: profileFile,
    workspaceRoot: root,
  })
  try {
    assert.equal(registered.workspaceProfile?.status, 'applied')
    assert.equal(registered.workspaceProfile?.created.projects, 1)
    assert.equal(registered.workspaceProfile?.created.members, 1)
    assert.equal(registered.workspaceProfile?.created.workItems, 1)
    const projects = await invoke(first.routes.get(`${API_PREFIX}project/list`)!, { commandId: 'p1', payload: {} })
    assert.equal(projects.body.data.length, 1)
    assert.equal(projects.body.data[0].name, '画像启动项目')
    const members = await invoke(first.routes.get(`${API_PREFIX}member/list`)!, { commandId: 'm1', payload: {} })
    assert.ok(members.body.data.some((member: { name: string }) => member.name === '画像启动 bot'))
    const knowledge = await invoke(first.routes.get(`${API_PREFIX}knowledge/list`)!, { commandId: 'k1', payload: {} })
    assert.equal(knowledge.body.data.counts.docs, 2, '一篇导入 + 一篇总览')
  } finally {
    registered.dispose()
  }

  const second = fakeCtx()
  const reopened = registerHams(second.ctx, {
    dataDir,
    tickEnabled: false,
    toolsEnabled: false,
    workspaceProfileFile: profileFile,
    workspaceRoot: root,
  })
  try {
    assert.equal(reopened.workspaceProfile?.status, 'unchanged')
    const projects = await invoke(second.routes.get(`${API_PREFIX}project/list`)!, { commandId: 'p2', payload: {} })
    assert.equal(projects.body.data.length, 1, '二次启动不能重复建项目')
  } finally {
    reopened.dispose()
  }
})

test('p18 启动即有两个默认 bot：项目管理 / 数据分析，重启不重复', (t) => {
  const root = createSandbox(t)
  const dataDir = prepareDataDir(root)
  const first = registerHams(fakeCtx().ctx, { ...CONFIG, dataDir, botRuntime: false })
  try {
    assert.deepEqual(first.defaultBots?.created.map((bot) => bot.name), ['项目管理', '数据分析'])
    const rows = first.db.prepare("SELECT id, kind, role, status FROM member WHERE id IN ('bot-pm', 'bot-data') ORDER BY id").all() as any[]
    assert.deepEqual(rows.map((row) => [row.id, row.kind, row.role, row.status]), [
      ['bot-data', 'bot', 'executor', 'active'],
      ['bot-pm', 'bot', 'coordinator', 'active'],
    ])
    assert.equal(first.service.whoami({ principalId: IDS.owner, channel: 'ui', correlationId: 'who' }).principal.memberId, IDS.owner)
  } finally {
    first.dispose()
  }

  const second = registerHams(fakeCtx().ctx, { ...CONFIG, dataDir, botRuntime: false })
  try {
    assert.equal(second.defaultBots?.created.length, 0)
    assert.equal(second.defaultBots?.existing.length, 2)
  } finally {
    second.dispose()
  }
})
