/**
 * 宿主适配器：把纯函数 handler 与工具定义接到 Cordis 的 `webServer` / `tools` 上。
 *
 * 只依赖注入的 ctx 形状（`webServer.register` / `tools.register` / 可选 `effect`），
 * 不 import 宿主包——这样既能在测试里用假 ctx 跑，也能在宿主升级时只改这一层。
 *
 * 与 design 的对应：
 * - `webServer.register({kind:'exact', path, handler})`：24 条精确路由（backend §9）；
 * - `tools.register(tool)`：11 个窄语义工具，**没有审批/决定/关单/SQL**；
 * - 启动编排沿用存储层：拿锁 → 开库 → 备份 → 迁移 → 种子 → runtime_epoch +1；
 * - 拿不到写锁时降级为只读实例：读路由可用，写命令返回 HOST_CAPABILITY_MISSING 并说明原因。
 *
 * 安全边界（P1 单机）：只接受回环 Origin；主体来自配置或 `hams_user(auth_source='local_host')`。
 * 同 OS 账户下的本机管理员仍可直接改库——这条诚实边界写在 README 与状态文档里。
 */
import { homedir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { bootstrapStore, openReadOnlyStore, type BootstrapReport } from '../store/bootstrap.ts'
import { resolveDataDir, type StoreError } from '../store/db.ts'
import { HamsService } from '../service/hams.ts'
import { createHamsHttpHandler, API_PREFIX, ROUTE_PATHS, type AuthResult, type HttpRequest, type HttpResponse } from '../http/handler.ts'
import { createHamsTools, type ToolDefinition, type ToolExecContext } from '../service/tools.ts'
import { createTicker, readRuntimeEpoch, recover, type TickerHandle } from '../service/tick.ts'
import { ChatService } from '../service/chat.ts'
import { createHostChatRuntime, ensureHamsBotPreset, parseModelChoice, resolveAgentOptions, HAMS_BOT_PRESET } from './chat-runtime.ts'
import { HamsSessionAdapter } from './session-adapter.ts'
import { ensureAllDefaultPlans } from '../service/project-lifecycle.ts'
import { createIdFactory } from '../domain/ids.ts'
import { HamsError } from '../domain/errors.ts'
import { ensureStarterTemplate } from '../service/templates.ts'
import { ensureDefaultBots, type DefaultBotResult } from '../service/defaults.ts'
import { applyWorkspaceProfile, defaultProfilePath, type WorkspaceProfileReport } from '../service/workspace-profile.ts'


export interface HostDisposer {
  (): void
}

export interface HostWebServer {
  register(spec: {
    kind: 'exact'
    path: string
    handler: (req: HostRequest, res: HostResponse) => unknown
  }): HostDisposer
}

export interface HostRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface HostResponse {
  writeHead?: (status: number, headers?: Record<string, string>) => unknown
  setHeader?: (name: string, value: string) => unknown
  end?: (body?: string | Buffer) => unknown
  statusCode?: number
}

export interface HostTools {
  register(tool: unknown): unknown
}

/**
 * 宿主 `ctx.connection` 的最小面（Desktop 0.2.2-rc.3 的 `HostConnectionHandle`）。
 *
 * 只声明 C2 真正需要的两个方法，并且都按「传 headers 拿判定」的纯函数用：
 * - `admit()`：官方给「另一个 Web 路由」复用的认证入口，返回已认证 Peer 或 401/403；
 * - `requestRejection()`：更轻的同类入口（只要判定不要 Peer）。
 *
 * 用结构类型而不是 import 宿主包：宿主升级时最多改这一处，测试用假对象即可。
 */
export interface HostConnectionPeer {
  readonly principal?: { readonly kind?: string }
}

export type HostPeerAdmission =
  | { readonly peer: HostConnectionPeer }
  | { readonly rejection: 401 | 403 }

export interface HostConnection {
  admit?(request: { readonly headers: Record<string, string | undefined> }): HostPeerAdmission
  requestRejection?(
    request: { readonly headers: Record<string, string | undefined> },
  ): 401 | 403 | undefined
}

export interface HostContext {
  webServer: HostWebServer
  tools?: HostTools
  effect?: (fn: () => HostDisposer | void, label?: string) => unknown
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
  /** Cordis 的服务读取入口。**必须**用它取 connection：直接读 `ctx.connection`
   *  在 Cordis 里会抛「cannot get property without inject」。 */
  get?: (name: string) => unknown
}

/**
 * 浏览器会话校验策略：
 * - `auto`：宿主提供 `connection` 就必须过会话校验；没有则退回「只验 Origin」并告警；
 * - `require`：没有 `connection` 就直接拒绝所有界面请求（安全优先的部署用）；
 * - `off`：不校验会话（只给测试/排障用，不要装到真实环境）。
 */
export type HostSessionMode = 'auto' | 'require' | 'off'

export type HostSessionState = 'host' | 'origin-only' | 'off'

export interface HamsHostConfig {
  /** 数据目录；空 = $DSH_HOME/hams。 */
  dataDir?: string
  /** tick 周期，默认 5 秒。 */
  tickMs?: number
  /** 本机操作者 member id；空 = 查 hams_user(auth_source='local_host')。 */
  localPrincipalId?: string
  /** 允许的 Origin 前缀；默认只放行回环。 */
  allowedOrigins?: string[]
  /** 首次认领时线程尚未建立，用这个 bot 成员兜底（P1 单 bot）；M5 会后由线程取代。 */
  defaultBotMemberId?: string
  /** 关闭工具注册（排障用）。 */
  toolsEnabled?: boolean
  /** 关闭 bot 运行时（不建会话、不派发运行）；默认开。 */
  botRuntime?: boolean
  /** 关闭 tick（手工验证用）。 */
  tickEnabled?: boolean
  /** 升级前备份保留份数。 */
  backupKeep?: number
  /** 浏览器会话校验策略，默认 `auto`。 */
  hostSession?: HostSessionMode
  /**
   * 知识屏的真实技能目录；默认 `$DSH_HOME/skills`。
   * 只读每个子目录里的 `SKILL.md`，不写宿主文件。
   */
  knowledgeSkillDirs?: string[]
  /** 工作区画像文件；默认 `<dataDir>/workspace-profile.json`。 */
  workspaceProfileFile?: string
  /** 画像里相对路径的根；空 = 读画像自己的 workspaceRoot。 */
  workspaceRoot?: string
  /**
   * 显式注入宿主连接服务（装配与测试用）。不传就按 `ctx.get('connection')` 现取，
   * 因为 connection 可能在插件 apply 之后才激活。
   */
  connection?: HostConnection
}

export interface RegisteredHams {
  mode: 'writer' | 'reader'
  service: HamsService
  db: DatabaseSync
  report: BootstrapReport | null
  ticker: TickerHandle | null
  routes: string[]
  toolNames: string[]
  /** 实际生效的浏览器会话校验形态（启动时判定）。 */
  sessionState: HostSessionState
  /** 本次启动给本机负责人岗位补授的能力条数（老库升级时非零）。 */
  operatorCapabilitiesAdded: number
  /** 工作区画像的应用结果（没有画像文件时为 null）。 */
  workspaceProfile: WorkspaceProfileReport | null
  /** 默认 bot（项目管理 / 数据分析）的补齐结果；只读实例为 null。 */
  defaultBots: DefaultBotResult | null
  dispose(): void
}

const DEFAULT_ORIGINS = ['http://127.0.0.1:', 'http://localhost:', 'http://[::1]:']

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value.join(',')
  return value
}

export function toHeaderRecord(raw: Record<string, string | string[] | undefined> | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}

/** 读请求体：兼容 Node 流、async iterator 与直接给 string 的假对象。 */
export async function readRequestBody(request: HostRequest, maxBytes = 256 * 1024): Promise<string> {
  if (typeof request.body === 'string') return request.body
  const chunks: Buffer[] = []
  let size = 0
  const push = (chunk: Buffer | string): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }

  if (request[Symbol.asyncIterator]) {
    for await (const chunk of request as AsyncIterable<Buffer | string>) push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  if (typeof request.on === 'function') {
    await new Promise<void>((resolve, reject) => {
      request.on!('data', (chunk) => {
        try {
          push(chunk as Buffer | string)
        } catch (error) {
          reject(error)
        }
      })
      request.on!('end', () => resolve())
      request.on!('error', (error) => reject(error))
    })
    return Buffer.concat(chunks).toString('utf8')
  }
  return ''
}

function writeResponse(response: HostResponse, result: HttpResponse): void {
  if (typeof response.writeHead === 'function') {
    response.writeHead(result.status, result.headers)
  } else if (typeof response.setHeader === 'function') {
    response.statusCode = result.status
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value)
  } else {
    response.statusCode = result.status
  }
  response.end?.(result.body)
}

export function isAllowedOrigin(origin: string, allowed: string[] = DEFAULT_ORIGINS): boolean {
  return allowed.some((prefix) => origin === prefix.replace(/:$/, '') || origin.startsWith(prefix))
}

const UNAUTHENTICATED_MESSAGE = '浏览器会话未通过认证（没有宿主会话 cookie，或已过期）'
const UNAUTHENTICATED_NEXT_STEP = '用 dsh 打印的带 ?token= 的地址重新打开这一页（或刷新），再操作面板'
const UNTRUSTED_MESSAGE = '请求来源不被宿主信任（Host/Origin 校验失败）'
const UNTRUSTED_NEXT_STEP = '只从本机 127.0.0.1/localhost 打开面板；不要用外部页面调用'

function unauthenticated(): { ok: false; reason: 'UNAUTHORIZED'; message: string; nextStep: string } {
  return { ok: false, reason: 'UNAUTHORIZED', message: UNAUTHENTICATED_MESSAGE, nextStep: UNAUTHENTICATED_NEXT_STEP }
}

function untrusted(): { ok: false; reason: 'FORBIDDEN'; message: string; nextStep: string } {
  return { ok: false, reason: 'FORBIDDEN', message: UNTRUSTED_MESSAGE, nextStep: UNTRUSTED_NEXT_STEP }
}

export type SessionVerdict =
  | { ok: true }
  | { ok: false; reason: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string; nextStep: string }

/**
 * 用宿主自己的浏览器会话判定「这个请求是不是已认证的本机页面」。
 *
 * 语义对齐宿主（`dsh-client-connection`）：认证只认两样东西——进程启动时随 URL
 * 下发、换成熟 cookie 的宿主令牌，以及 `/connect` 换来的 API Peer。HAMS 不自己
 * 造令牌、不登录、不存口令；cookie 是宿主写的（HttpOnly + SameSite=Strict），
 * 我们只读判定结果。
 *
 * 宿主调用失败（抛异常）一律按 403 拒绝——宁可让面板报错，也不要放进来路不明
 * 的写请求。
 */
export function checkHostSession(
  connection: HostConnection | undefined,
  headers: Record<string, string | undefined>,
  mode: HostSessionMode = 'auto',
): SessionVerdict {
  if (mode === 'off') return { ok: true }
  if (!connection) {
    if (mode === 'require') {
      return {
        ok: false,
        reason: 'FORBIDDEN',
        message: '宿主没有提供 connection 服务，无法校验浏览器会话',
        nextStep: '把插件装进带 Web 载体的宿主，或把配置 hostSession 设为 auto（只验 Origin）',
      }
    }
    return { ok: true }
  }
  const request = { headers }
  try {
    if (typeof connection.admit === 'function') {
      const admission = connection.admit(request)
      if ('rejection' in admission) {
        return admission.rejection === 401 ? unauthenticated() : untrusted()
      }
      const kind = admission.peer?.principal?.kind
      // 协议目前只有 owner；将来加了别的 driver（例如 bot peer），界面通道一律不收。
      if (kind !== undefined && kind !== 'owner') {
        return {
          ok: false,
          reason: 'FORBIDDEN',
          message: `主体类型 ${kind} 不能调用 HAMS 界面接口`,
          nextStep: 'bot 只能走工具通道；界面接口只服务已认证的本机操作者',
        }
      }
      return { ok: true }
    }
    if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(request)
      if (rejection === 401) return unauthenticated()
      if (rejection === 403) return untrusted()
      return { ok: true }
    }
    if (mode === 'require') {
      return {
        ok: false,
        reason: 'FORBIDDEN',
        message: '宿主 connection 服务没有可用的认证入口',
        nextStep: '确认宿主版本提供 admit/requestRejection，或把 hostSession 设为 auto',
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'FORBIDDEN',
      message: `宿主会话校验失败：${String((error as Error)?.message ?? error)}`,
      nextStep: '看宿主日志确认 connection 服务状态后重试',
    }
  }
}

/**
 * P1 鉴权：Origin 白名单 → 宿主浏览器会话 → 主体。
 *
 * 主体仍然是「本机负责人」（单机模式没有登录页），但**能不能进来**由宿主会话
 * 说了算：没有换过宿主令牌的请求拿不到 cookie，也就到不了业务层。
 */
export function createLocalAuthenticator(
  db: DatabaseSync,
  config: HamsHostConfig,
  resolveConnection?: () => HostConnection | undefined,
): (request: HttpRequest) => AuthResult {
  const allowed = config.allowedOrigins ?? DEFAULT_ORIGINS
  const mode = config.hostSession ?? 'auto'
  return (request) => {
    const origin = request.headers.origin
    if (origin && !isAllowedOrigin(origin, allowed)) {
      return { ok: false, reason: 'FORBIDDEN', message: `非同源请求：${origin}`, nextStep: UNTRUSTED_NEXT_STEP }
    }
    const verdict = checkHostSession(resolveConnection?.(), request.headers, mode)
    if (!verdict.ok) return verdict

    let principalId = config.localPrincipalId ?? ''
    if (!principalId) {
      const row = db
        .prepare("SELECT member_id FROM hams_user WHERE auth_source = 'local_host' AND status = 'active' LIMIT 1")
        .get() as { member_id: string } | undefined
      principalId = row?.member_id ?? ''
    }
    if (!principalId) {
      return {
        ok: false,
        reason: 'FORBIDDEN',
        message: '还没有绑定本机操作者：请先建立 hams_user(auth_source=local_host) 或配置 localPrincipalId',
        nextStep: '重启插件会首次自动创建本机操作者；若仍失败，检查 hams_user 表',
      }
    }
    return { ok: true, principalId, authSubject: origin ?? 'local_host' }
  }
}

/**
 * 参数直接保持标准 JSON Schema（`required` 是对象层的数组）。
 *
 * 实测（2026-11-14，Desktop 0.2.2-rc.3）：`ctx.tools.register` 校验的是标准 JSON Schema，
 * 属性节点上标 `required: true` 会被拒：JsonSchemaError: ... is not supported on type "boolean"。
 */
export function toHostParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  return {
    type: 'object',
    properties,
    ...(Array.isArray(schema.required) && schema.required.length ? { required: schema.required } : {}),
    additionalProperties: schema.additionalProperties === undefined ? false : schema.additionalProperties,
  }
}

export function hostToolOutput(renderKey = 'render'): Record<string, unknown> {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        [renderKey]: { type: 'string' },
      },
      required: ['ok', renderKey],
    },
    render: (_args: unknown, value: Record<string, unknown>) => [
      { type: 'text', text: String(value?.[renderKey] ?? JSON.stringify(value)) },
    ],
  }
}

/** 把工具结果压成「模型能读的一段文字 + 机器可读的 ok」。 */
export function renderToolResult(name: string, result: { ok: boolean; data?: unknown; error?: { code: string; message: string; nextStep: string } }): {
  ok: boolean
  render: string
  code?: string
} {
  if (result.ok) {
    return {
      ok: true,
      render: `${name} 成功：${JSON.stringify(result.data ?? {}, null, 2).slice(0, 4000)}`,
    }
  }
  return {
    ok: false,
    code: result.error?.code,
    render: `${name} 失败（${result.error?.code}）：${result.error?.message}\n下一步：${result.error?.nextStep}`,
  }
}

export interface BuildHostToolsOptions {
  defineTool?: (definition: Record<string, unknown>) => unknown
}

export function toHostTools(
  definitions: ToolDefinition[],
  options: BuildHostToolsOptions = {},
): unknown[] {
  const define = options.defineTool ?? ((definition: Record<string, unknown>) => definition)
  return definitions.map((definition) => {
    const parameters = toHostParameters(definition.parameters)
    const tool = define({
      name: definition.name,
      description: definition.description,
      parameters,
      output: hostToolOutput(),
      async execute(args: unknown, exec: { agent?: { session?: { id?: string } }; sessionId?: string }): Promise<unknown> {
        const sessionId = exec?.agent?.session?.id ?? exec?.sessionId ?? ''
        const result = await definition.execute(args, { sessionId } as ToolExecContext)
        return renderToolResult(definition.name, result)
      },
    })
    return tool
  })
}

/**
 * P1 首次使用：宿主本机操作者还没有档案时，建一个最小可用的人 + 岗位 + 登录身份。
 *
 * 这是设计里「宿主本机令牌映射本机负责人」的落地：单机模式没有登录页，第一次打开面板
 * 就得有一个能审批、能建单的人。只建一次；已有 hams_user(local_host) 就什么都不做。
 * 不写任何业务数据（项目、工作项仍要人自己建）。
 */
export function ensureLocalOperator(db: DatabaseSync, now = Date.now()): string {
  const existing = db
    .prepare("SELECT member_id FROM hams_user WHERE auth_source = 'local_host' AND status = 'active' LIMIT 1")
    .get() as { member_id: string } | undefined
  if (existing) return existing.member_id

  const memberId = 'h-owner'
  const positionId = 'pos-owner'
  db.exec('BEGIN IMMEDIATE')
  try {
    const member = db.prepare('SELECT id FROM member WHERE id = ?').get(memberId) as { id: string } | undefined
    if (!member) {
      db.prepare(
        `INSERT INTO member (id, kind, name, role, current_version, created_at, updated_at)
         VALUES (?, 'human', '本机操作者', 'coordinator', 0, ?, ?)`,
      ).run(memberId, now, now)
    }
    const position = db.prepare('SELECT id FROM position WHERE id = ?').get(positionId) as { id: string } | undefined
    if (!position) {
      db.prepare("INSERT INTO position (id, name, domain, description) VALUES (?, '本机负责人', NULL, 'P1 自动创建')").run(positionId)
    }
    const capability = db.prepare(
      'INSERT OR IGNORE INTO position_permission (position_id, capability, scope) VALUES (?, ?, ?)',
    )
    for (const name of [
      'work_item.create',
      'work_item.accept',
      'work_item.manage',
      'work_item.request_closure',
      'evidence.append',
      'check.evaluate',
      'proposal.decide',
      'approval.decide',
    ]) {
      capability.run(positionId, name, 'global')
    }
    const assigned = db
      .prepare('SELECT 1 FROM member_position WHERE member_id = ? AND position_id = ?')
      .get(memberId, positionId) as { 1: number } | undefined
    if (!assigned) {
      db.prepare(
        `INSERT INTO member_position (member_id, position_id, starts_at, ends_at, assigned_by)
         VALUES (?, ?, 0, NULL, 'system')`,
      ).run(memberId, positionId)
    }
    db.prepare(
      `INSERT INTO hams_user (id, member_id, login, display_name, auth_source, external_id, is_admin, status, last_login_at)
       VALUES ('user-local', ?, 'local', '本机操作者', 'local_host', 'local', 1, 'active', ?)`,
    ).run(memberId, now)
    db.exec('COMMIT')
    return memberId
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 给本机负责人岗位补齐 M6 需要的能力。
 *
 * 为什么要单独一步：`ensureLocalOperator` 在已有 operator 时直接返回，老库不会
 * 重新走一遍授权；而项目 / 成员 / 知识三屏的写命令需要 `project.create`、
 * `member.manage` 等新能力。这里只对**自动创建的 `pos-owner` 岗位**补缺失项，
 * 不碰用户自建岗位，也不覆盖已有的 scope。
 */
export const OPERATOR_CAPABILITIES = [
  'work_item.create',
  'work_item.accept',
  'work_item.manage',
  'work_item.request_closure',
  'evidence.append',
  'check.evaluate',
  'proposal.decide',
  'approval.decide',
  'project.create',
  'project.manage',
  'project.archive',
  'target.publish',
  'review.confirm',
  'metric.record',
  'member.manage',
  'knowledge.write',
  'knowledge.sync',
] as const

export function ensureOperatorCapabilities(db: DatabaseSync, memberId: string): number {
  const position = db.prepare("SELECT id FROM position WHERE id = 'pos-owner'").get() as
    | { id: string }
    | undefined
  if (!position) return 0
  const assigned = db
    .prepare('SELECT 1 AS ok FROM member_position WHERE member_id = ? AND position_id = ? AND ends_at IS NULL')
    .get(memberId, position.id) as { ok: number } | undefined
  if (!assigned) return 0
  const insert = db.prepare(
    'INSERT OR IGNORE INTO position_permission (position_id, capability, scope) VALUES (?, ?, ?)',
  )
  let added = 0
  for (const capability of OPERATOR_CAPABILITIES) added += Number(insert.run(position.id, capability, 'global').changes ?? 0)
  return added
}

function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : ''
  return configured ? path.resolve(configured) : path.join(homedir(), '.dsh')
}

function isLockError(error: unknown): boolean {
  const code = (error as StoreError | undefined)?.code
  return code === 'LOCK_HELD' || code === 'LOCK_HELD_SELF'
}

/**
 * 在宿主里启动 HAMS：拿写锁；拿不到就降级只读。所有注册都返回 disposer。
 */
export function registerHams(ctx: HostContext, config: HamsHostConfig = {}): RegisteredHams {
  const startedAt = Date.now()
  const dataDir = resolveDataDir(config.dataDir)

  let runtime: ReturnType<typeof bootstrapStore> | null = null
  let reader: ReturnType<typeof openReadOnlyStore> | null = null
  let mode: 'writer' | 'reader'
  try {
    runtime = bootstrapStore({ dataDir, backupKeep: config.backupKeep })
    mode = 'writer'
  } catch (error) {
    if (!isLockError(error)) throw error
    reader = openReadOnlyStore(dataDir)
    mode = 'reader'
  }

  const db = runtime?.db ?? reader!.db
  const dshHome = resolveDshHome()
  const knowledgeSkillDirs =
    config.knowledgeSkillDirs && config.knowledgeSkillDirs.length
      ? [...config.knowledgeSkillDirs]
      : [path.join(dshHome, 'skills')]
  let starterTemplateVersionId: string | null = null
  let operatorCapabilitiesAdded = 0
  let workspaceProfile: WorkspaceProfileReport | null = null
  let defaultBots: DefaultBotResult | null = null
  if (mode === 'writer') {
    const operatorId = ensureLocalOperator(db, startedAt)
    operatorCapabilitiesAdded = ensureOperatorCapabilities(db, operatorId)
    starterTemplateVersionId = ensureStarterTemplate(db, operatorId, startedAt)
    // 默认 bot 先于画像落库：画像里的项目如果没指定推进 bot，也能拿到「项目管理」。
    try {
      defaultBots = ensureDefaultBots(db, createIdFactory(() => Date.now()), startedAt, operatorId)
    } catch (error) {
      ctx.logger?.warn?.(`[hams] 默认 bot 补齐失败：${String(error)}`)
    }
    workspaceProfile = applyWorkspaceProfile({
      db,
      dataDir,
      operatorId,
      now: startedAt,
      idFactory: createIdFactory(() => Date.now()),
      file: config.workspaceProfileFile?.trim() || defaultProfilePath(dataDir),
      workspaceRoot: config.workspaceRoot?.trim() || undefined,
      skillDirs: knowledgeSkillDirs,
    })
  }
  if (mode === 'writer') {
    // 历史项目补齐「默认阶段 + 首个目标」：界面永远有可推进的骨架。
    try { ensureAllDefaultPlans(db, createIdFactory(() => Date.now()), Date.now()) } catch (error) { ctx.logger?.warn?.(`[hams] 补默认阶段失败：${String(error)}`) }
  }
  const service = new HamsService({
    db,
    runtimeEpoch: runtime?.report.runtimeEpoch ?? readRuntimeEpoch(db),
    knowledge: { dataDir, skillDirs: knowledgeSkillDirs },
  })
  // 对话：只在写者实例接宿主 agent 服务（只读实例没有写权限存会话指针）。
  const chatRuntime =
    mode === 'writer'
      ? createHostChatRuntime({ ctx, dataDir, log: (line) => ctx.logger?.warn?.(line) })
      : null
  const chat = chatRuntime ? new ChatService({ db, runtime: chatRuntime }) : null
  const disposers: HostDisposer[] = []

  // bot 运行时：把工作项线程接到真实 agent 会话；服务缺失时只记日志，不影响面板启动。
  const hostService = <T>(name: string): T | undefined => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      const found = ctx.get(name)
      return found && typeof found === 'object' ? (found as T) : undefined
    } catch {
      return undefined
    }
  }
  let sessionAdapter: HamsSessionAdapter | null = null
  if (mode === 'writer' && config.botRuntime !== false) {
    const agentsProxy = {
      async create(options: Record<string, unknown>) {
        const agents = hostService<{ create(o: Record<string, unknown>): Promise<unknown> }>('agents')
        if (!agents) throw new Error('宿主没有 agents 服务')
        return (await agents.create(options)) as never
      },
      async resume(options: Record<string, unknown>) {
        const agents = hostService<{ resume(o: Record<string, unknown>): Promise<unknown> }>('agents')
        if (!agents) throw new Error('宿主没有 agents 服务')
        return (await agents.resume(options)) as never
      },
    }
    sessionAdapter = new HamsSessionAdapter({
      db,
      service,
      dataDir,
      defaultPreset: HAMS_BOT_PRESET,
      agents: agentsProxy as never,
      createUserMessage: (input: Record<string, unknown>) => ({ id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, role: 'user', ...input }),
      compose: async (bot) => {
        const preset = bot.agentPreset && bot.agentPreset !== HAMS_BOT_PRESET ? bot.agentPreset : await ensureHamsBotPreset(ctx, (line) => ctx.logger?.warn?.(line))
        // bot 没配模型时用宿主默认模型兜底（否则会话一开就报 has no provider/model）。
        const selection = hostService<{ currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string } }>('agentDefaultModel')?.currentSelection?.()
        const model = await resolveAgentOptions(bot.model, hostService('llm') as never, selection)
        if (!model) {
          throw new HamsError(
            'HOST_CAPABILITY_MISSING',
            `bot ${bot.memberId} 没有配置模型，宿主也没有默认模型`,
            { nextStep: '在成员配置里给这个 bot 选一个模型，或在宿主设置里选一个默认模型' },
          )
        }
        const registry = hostService<{ mount(agentCtx: unknown, id: string): Promise<unknown> }>('agentPresets')
        const setup = registry && preset ? async (agentCtx: unknown) => { await registry.mount(agentCtx, preset) } : undefined
        return { agentOptions: model ? { ...model } : {}, ...(setup ? { setup } : {}), agentPreset: preset }
      },
    })
  }


  // 宿主 connection 可能在插件 apply 之后才激活：每次请求现取，别在启动时缓存。
  // 只走 ctx.get()：Cordis 里直接读 ctx.connection 会抛「without inject」。
  const resolveConnection = (): HostConnection | undefined => {
    if (config.connection) return config.connection
    if (typeof ctx.get !== 'function') return undefined
    try {
      const found = ctx.get('connection')
      return found && typeof found === 'object' ? (found as HostConnection) : undefined
    } catch {
      return undefined
    }
  }
  const sessionMode = config.hostSession ?? 'auto'
  const sessionState: HostSessionState =
    sessionMode === 'off' ? 'off' : resolveConnection() ? 'host' : 'origin-only'

  let ticker: TickerHandle | null = null
  if (mode === 'writer' && config.tickEnabled !== false) {
    // 启动对账：上一个进程留下的 queued/running 运行必须收尾，否则会一直占着 uq_wi_active_run，
    // 被指派的 bot 永远等不到新一轮。
    const recovered = recover({ db, runtimeEpoch: runtime!.report.runtimeEpoch, dataDir })
    if (recovered.cancelledQueuedRuns || recovered.orphanedRunningRuns) {
      ctx.logger?.warn?.(`[hams] 启动对账：取消排队 ${recovered.cancelledQueuedRuns} 个 / 标记孤儿 ${recovered.orphanedRunningRuns} 个`)
    }
    ticker = createTicker({
      db,
      runtimeEpoch: runtime!.report.runtimeEpoch,
      intervalMs: config.tickMs ?? 5_000,
      dataDir,
    })
    ticker.start()
  }

  // 派发：到期复查只把 run 排队；这里负责真正把 queued 运行与「已指派的任务」投给 bot 会话。
  let dispatchTimer: ReturnType<typeof setInterval> | null = null
  if (sessionAdapter) {
    let dispatching = false
    dispatchTimer = setInterval(() => {
      if (dispatching) return
      dispatching = true
      Promise.resolve()
        .then(() => sessionAdapter!.dispatchAssignments())
        .then((report) => { if (report.errors.length) ctx.logger?.warn?.(`[hams] 指派派发失败：${report.errors.slice(0, 3).join(' | ')}`) })
        .then(() => sessionAdapter!.dispatchQueued())
        .catch((error) => ctx.logger?.warn?.(`[hams] 派发失败：${String(error)}`))
        .finally(() => { dispatching = false })
    }, Math.max(3000, config.tickMs ?? 5_000))
    if (typeof dispatchTimer === 'object' && dispatchTimer && 'unref' in dispatchTimer) dispatchTimer.unref()
  }

  const routePaths = ROUTE_PATHS.map((path) => `${API_PREFIX}${path}`)
  let toolNames: string[] = []
  try {
  if (config.toolsEnabled !== false && ctx.tools) {
    const definitions = createHamsTools({
      service,
      db,
      resolveSessionOwner: config.defaultBotMemberId
        ? () => ({ memberId: config.defaultBotMemberId as string })
        : undefined,
      ...(chat
        ? {
            chat: {
              projectOfSession: (sessionId: string) => chat.projectOfSession(sessionId),
              groupMembersBySession: (sessionId: string) => chat.groupMembersBySession(sessionId),
              groupSpeakBySession: (sessionId: string, input) => chat.groupSpeakBySession(sessionId, input),
              groupSpawnBySession: (sessionId: string, input) => chat.groupSpawnBySession(sessionId, input),
              noteAssignment: (sessionId: string, input) => chat.groupNoteAssignmentBySession(sessionId, input),
              rememberBySession: (sessionId: string, input) => chat.rememberBySession(sessionId, input),
            },
          }
        : {}),
    })
    const hostTools = toHostTools(definitions)
    for (const tool of hostTools) {
      const disposer = ctx.tools.register(tool)
      if (typeof disposer === 'function') disposers.push(disposer as HostDisposer)
    }
    toolNames = definitions.map((definition) => definition.name)
  }

  const handler = createHamsHttpHandler({
    service,
    authenticate: createLocalAuthenticator(db, config, resolveConnection),
    readOnly: mode === 'reader',
    ...(chat ? { chat } : {}),
    deliverables: { dataDir, db },
  })

  for (const path of routePaths) {
    const disposer = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const body = await readRequestBody(req)
          const response = await handler({
            method: req.method ?? 'POST',
            path,
            headers: toHeaderRecord(req.headers),
            body,
          })
          writeResponse(res, response)
        } catch (error) {
          writeResponse(res, {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: false, error: { code: 'STATE_INVALID', message: String((error as Error)?.message ?? error), nextStep: '检查请求体大小后重试' } }),
          })
        }
      },
    })
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  } catch (error) {
    // 注册到一半失败：把已经建好的路由、工具、tick 与连接全部收回，再抛出。
    while (disposers.length) {
      try {
        disposers.pop()?.()
      } catch {
        // 忽略注销失败，继续清理。
      }
    }
    ticker?.stop()
    reader?.close()
    runtime?.close()
    throw error
  }

  ctx.logger?.info?.(
    `[hams] ${mode === 'writer' ? '写者' : '只读'} 模式启动：${routePaths.length} 条路由 / ${toolNames.length} 个工具，用时 ${Date.now() - startedAt}ms，数据目录 ${dataDir}，会话校验 ${sessionState}`,
  )
  if (workspaceProfile && workspaceProfile.status !== 'missing') {
    const summary = workspaceProfile.created
    const line = `[hams] 工作区画像 ${workspaceProfile.status}：成员 ${summary.members} / 项目 ${summary.projects} / 工作项 ${summary.workItems} / 文档 ${summary.docs} / 技能 ${summary.skills} / 表 ${summary.tables} / 清理模板 ${summary.removedTemplates}${workspaceProfile.errors.length ? ` / 错误 ${workspaceProfile.errors.length}` : ''}${workspaceProfile.warnings.length ? ` / 告警 ${workspaceProfile.warnings.length}` : ''}`
    if (workspaceProfile.status === 'failed' || workspaceProfile.errors.length) ctx.logger?.warn?.(line)
    else ctx.logger?.info?.(line)
    for (const error of workspaceProfile.errors.slice(0, 5)) ctx.logger?.warn?.(`[hams] 画像：${error}`)
    for (const warning of workspaceProfile.warnings.slice(0, 5)) ctx.logger?.warn?.(`[hams] 画像告警：${warning}`)
  }
  if (sessionState === 'origin-only') {
    ctx.logger?.warn?.(
      '[hams] 宿主没有提供 connection 服务：界面接口只验 Origin，不校验宿主浏览器会话。' +
        '要强制校验，把配置 hostSession 设为 require（或在带 Web 载体的宿主里运行）。',
    )
  }

  const registered: RegisteredHams = {
    mode,
    service,
    db,
    report: runtime?.report ?? null,
    ticker,
    routes: routePaths,
    toolNames,
    sessionState,
    operatorCapabilitiesAdded,
    workspaceProfile,
    defaultBots,
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch {
          // 注销失败不能阻碍释放锁。
        }
      }
      ticker?.stop()
      if (dispatchTimer) clearInterval(dispatchTimer)
      void sessionAdapter?.dispose()
      reader?.close()
      runtime?.close()
      void chatRuntime?.dispose()
    },
  }
  return registered
}

/** 插件入口调用：优先用 ctx.effect 托管生命周期，拿不到就同步注册。 */
export function applyHams(ctx: HostContext, config: HamsHostConfig = {}): RegisteredHams | null {
  if (typeof ctx.effect === 'function') {
    let registered: RegisteredHams | null = null
    ctx.effect(() => {
      registered = registerHams(ctx, config)
      return () => registered?.dispose()
    }, 'hams.runtime')
    return registered
  }
  return registerHams(ctx, config)
}
