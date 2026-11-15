/**
 * HTTP handler：只做「协议 → 命令上下文 → 领域服务 → 回执」的翻译。
 *
 * 刻意不依赖 `ctx.webServer`：宿主注册（`webServer.register({kind:'exact'})`）与
 * Origin/自定义头能不能读，要等 C2 实测；本文件先把可以确定的部分做成纯函数，
 * 宿主接线时只包一层薄适配器。
 *
 * 进站顺序（与 backend §9 一致）：
 *   方法/路径 → 验来源与主体（注入的 authenticate）→ 拒绝 bot 走 UI 通道 →
 *   读负载（大小上限）→ 解析信封 → 可选修订号校验 → 领域命令 → 回执。
 *
 * 传输层错误用 HTTP 状态码：405 / 404 / 413 / 400 / 401 / 403；
 * 业务成败一律 200 + 回执里的 `ok`，界面不需要解析状态码猜业务结果。
 *
 * 401 与 403 都表示「没进业务层」：401 = 浏览器会话缺失/过期（界面该重开带
 * `?token=` 的地址），403 = 来源不可信或主体明确不允许（重开也没用）。
 */
import type { HamsService } from '../service/hams.ts'
import type { CommandContext, CommandReceipt } from '../service/types.ts'
import {
  asNumber,
  asObject,
  asString,
  optionalString,
  rejectedReceipt,
  requireEnvelope,
  toCommandContext,
  type CommandEnvelope,
  type ErrorResult,
  type HamsResponseBody,
  type QueryResult,
} from '../service/contracts.ts'
import { HamsError } from '../domain/errors.ts'
import type { MetricInput } from '../service/projects.ts'
import { listDeliverables, readDeliverable } from '../service/deliverables.ts'

export interface HttpRequest {
  method: string
  path: string
  /** 键一律按小写读取；宿主适配器负责把原始头转成这个形状。 */
  headers: Record<string, string | undefined>
  body: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface AuthSuccess {
  ok: true
  principalId: string
  authSubject?: string
  hostPreset?: string
  onBehalfOf?: string
}

export interface AuthFailure {
  ok: false
  /**
   * `UNAUTHORIZED` → 401（浏览器会话缺失/过期，界面应重开带 ?token= 的地址）；
   * `FORBIDDEN` → 403（来源不可信，或主体明确不允许）。两者都不进业务层。
   */
  reason: 'UNAUTHORIZED' | 'FORBIDDEN'
  message: string
  nextStep?: string
}

export type AuthResult = AuthSuccess | AuthFailure

export interface HamsHttpDeps {
  service: HamsService
  /** 对话（单聊/群聊）与宿主模型/preset 目录；未提供时这些路由返回 HOST_CAPABILITY_MISSING。 */
  chat?: import('../service/chat.ts').ChatService
  /** 宿主适配器提供：验 Origin / 本机令牌 / SSO 头，并解析出主体。 */
  authenticate(request: HttpRequest): AuthResult
  maxBodyBytes?: number
  correlationId?: () => string
  /** 第二实例只读模式：写命令一律拒绝并说明原因。 */
  readOnly?: boolean
}

export const API_PREFIX = '/hams/api/v1/'
const DEFAULT_MAX_BODY = 256 * 1024

export interface HamsHttpExtras {
  /** 对话与宿主目录：需要读宿主会话时才有；纯只读实例可以不给。 */
  chat?: import('../service/chat.ts').ChatService
  /** 项目交付物扫描需要 HAMS 数据目录（bot 工作区在 <dataDir>/bots 下）。 */
  deliverables?: { dataDir: string; db: import('node:sqlite').DatabaseSync }
}

type RouteHandler = (
  service: HamsService,
  ctx: CommandContext,
  envelope: CommandEnvelope,
  extras: HamsHttpExtras,
) => CommandReceipt | QueryResult | Promise<CommandReceipt | QueryResult>

interface Route {
  write: boolean
  handle: RouteHandler
  /** 对工作项类命令做 expectedRevision 前置校验。 */
  revisionCheck?: boolean
}

function payloadOf(envelope: CommandEnvelope): Record<string, unknown> {
  return envelope.payload === undefined ? {} : asObject(envelope.payload, 'payload')
}

function idOf(envelope: CommandEnvelope, payload: Record<string, unknown>, field = 'objectId'): string {
  const fromEnvelope = envelope.objectId
  if (fromEnvelope) return fromEnvelope
  return asString(payload[field], field)
}

/** 项目指标列表：建项目与存草稿共用；草稿允许只填一半（后续发布时再严格校验）。 */
function metricListOf(payload: Record<string, unknown>, lenient = false): unknown[] | undefined {
  const list = payload.metrics
  if (list === undefined) return undefined
  if (!Array.isArray(list)) throw new HamsError('STATE_INVALID', 'payload.metrics 必须是数组')
  if (!lenient) return list
  return list.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
}

function ok<T>(data: T, correlationId: string): QueryResult<T> {
  return { ok: true, data, correlationId }
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new HamsError('STATE_INVALID', `${field} 必须是字符串数组`)
  return value.map((item, index) => asString(item, `${field}[${index}]`))
}

const ROUTES = new Map<string, Route>([
  [
    'session/whoami',
    {
      write: false,
      handle: (service, ctx) => ok(service.whoami(ctx), ctx.correlationId),
    },
  ],
  [
    'ops/health',
    {
      write: false,
      handle: (service, ctx) => ok(service.health(ctx), ctx.correlationId),
    },
  ],
  [
    'overview/get',
    {
      write: false,
      handle: (service, ctx) => ok(service.overview(ctx), ctx.correlationId),
    },
  ],
  // ── 对话：单聊（智能体）/ 群聊（项目）──────────────────────────────────
  // 消息正文留在宿主会话里，这里只读；线程指针存在 hams_meta，不新建表。
  [
    'chat/open',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务', { nextStep: '重启 DSH 让插件接上 agents 服务' })
        const payload = payloadOf(envelope)
        const kind = asString(payload.kind, 'payload.kind')
        if (kind !== 'member' && kind !== 'project') throw new HamsError('STATE_INVALID', 'kind 只能是 member 或 project')
        return ok(await extras.chat.open(ctx, { kind, targetId: asString(payload.targetId, 'payload.targetId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/send',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务', { nextStep: '重启 DSH 让插件接上 agents 服务' })
        const payload = payloadOf(envelope)
        const kind = asString(payload.kind, 'payload.kind')
        if (kind !== 'member' && kind !== 'project') throw new HamsError('STATE_INVALID', 'kind 只能是 member 或 project')
        return ok(await extras.chat.send(ctx, { kind, targetId: asString(payload.targetId, 'payload.targetId'), text: asString(payload.text, 'payload.text') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/messages',
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ thread: null, messages: [], running: false, available: false, reason: '当前实例没有接宿主会话服务' }, ctx.correlationId)
        const payload = payloadOf(envelope)
        const kind = asString(payload.kind, 'payload.kind')
        if (kind !== 'member' && kind !== 'project') throw new HamsError('STATE_INVALID', 'kind 只能是 member 或 project')
        return ok(await extras.chat.read(ctx, { kind, targetId: asString(payload.targetId, 'payload.targetId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/stop',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务', { nextStep: '重启 DSH 让插件接上 agents 服务' })
        const payload = payloadOf(envelope)
        const kind = asString(payload.kind, 'payload.kind')
        if (kind !== 'member' && kind !== 'project') throw new HamsError('STATE_INVALID', 'kind 只能是 member 或 project')
        return ok(await extras.chat.stop(ctx, { kind, targetId: asString(payload.targetId, 'payload.targetId') }), ctx.correlationId)
      },
    },
  ],
  [
    'project/deliverables',
    {
      write: false,
      handle: (service, ctx, envelope, extras) => {
        if (!extras.deliverables) return ok({ items: [], truncated: false, workItems: 0 }, ctx.correlationId)
        const payload = payloadOf(envelope)
        return ok(
          listDeliverables({
            db: extras.deliverables.db,
            dataDir: extras.deliverables.dataDir,
            projectId: asString(payload.projectId, 'payload.projectId'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'project/deliverable',
    {
      write: false,
      handle: (service, ctx, envelope, extras) => {
        if (!extras.deliverables) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有交付物目录，无法预览文件')
        const payload = payloadOf(envelope)
        return ok(
          readDeliverable({
            db: extras.deliverables.db,
            dataDir: extras.deliverables.dataDir,
            projectId: asString(payload.projectId, 'payload.projectId'),
            relPath: asString(payload.path, 'payload.path'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'chat/team',
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ coordinator: null, members: [] }, ctx.correlationId)
        return ok(await extras.chat.team(ctx, { projectId: asString(payloadOf(envelope).projectId, 'payload.projectId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/team/add',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务')
        const payload = payloadOf(envelope)
        return ok(extras.chat.addParticipant(ctx, { projectId: asString(payload.projectId, 'payload.projectId'), memberId: asString(payload.memberId, 'payload.memberId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/team/remove',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务')
        const payload = payloadOf(envelope)
        return ok(extras.chat.removeParticipant(ctx, { projectId: asString(payload.projectId, 'payload.projectId'), memberId: asString(payload.memberId, 'payload.memberId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/team/spawn',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务')
        const payload = payloadOf(envelope)
        return ok(extras.chat.spawnTempBot(ctx, { projectId: asString(payload.projectId, 'payload.projectId'), name: asString(payload.name, 'payload.name'), brief: optionalString(payload.brief, 'payload.brief') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/group/messages',
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) return ok({ messages: [], members: [], coordinator: null, running: false, available: false, reason: '当前实例没有接宿主会话服务' }, ctx.correlationId)
        return ok(await extras.chat.groupRead(ctx, { projectId: asString(payloadOf(envelope).projectId, 'payload.projectId') }), ctx.correlationId)
      },
    },
  ],
  [
    'chat/group/send',
    {
      write: true,
      handle: async (service, ctx, envelope, extras) => {
        if (!extras.chat) throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务')
        const payload = payloadOf(envelope)
        return ok(await extras.chat.groupSend(ctx, { projectId: asString(payload.projectId, 'payload.projectId'), text: asString(payload.text, 'payload.text') }), ctx.correlationId)
      },
    },
  ],
  [
    'host/catalog',
    {
      write: false,
      handle: async (service, ctx, envelope, extras) => ok({
        available: Boolean(extras.chat && extras.chat.available),
        reason: extras.chat ? extras.chat.reason : '当前实例没有接宿主会话服务',
        presets: extras.chat ? await extras.chat.presets() : [],
        models: extras.chat ? await extras.chat.models() : [],
      }, ctx.correlationId),
    },
  ],
  [
    'changes/since',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.changesSince(ctx, {
            cursor: payload.cursor === undefined ? undefined : asNumber(payload.cursor, 'payload.cursor'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'proposal/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listProposals(ctx, {
            deciderId: optionalString(payload.deciderId, 'payload.deciderId'),
            status: optionalString(payload.status, 'payload.status'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'workItem/create',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.createWorkItem(ctx, {
          domain: asString(payload.domain, 'payload.domain'),
          category: asString(payload.category, 'payload.category'),
          title: asString(payload.title, 'payload.title'),
          ownerHumanId: optionalString(payload.ownerHumanId, 'payload.ownerHumanId'),
          projectId: optionalString(payload.projectId, 'payload.projectId'),
          templateVersionId: optionalString(payload.templateVersionId, 'payload.templateVersionId'),
          assetId: optionalString(payload.assetId, 'payload.assetId'),
          dedupeKey: optionalString(payload.dedupeKey, 'payload.dedupeKey'),
          priority: payload.priority === undefined ? undefined : asNumber(payload.priority, 'payload.priority'),
          dueAt: payload.dueAt === undefined ? undefined : asNumber(payload.dueAt, 'payload.dueAt'),
        })
      },
    },
  ],
  [
    'workItem/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listWorkItems(ctx, {
            status: optionalString(payload.status, 'payload.status'),
            assigneeId: optionalString(payload.assigneeId, 'payload.assigneeId'),
            ownerId: optionalString(payload.ownerId, 'payload.ownerId'),
            projectId: optionalString(payload.projectId, 'payload.projectId'),
            domain: optionalString(payload.domain, 'payload.domain'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'workItem/get',
    {
      write: false,
      handle: (service, ctx, envelope) => ok(service.getWorkItem(ctx, idOf(envelope, payloadOf(envelope))), ctx.correlationId),
    },
  ],
  [
    'check/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(service.listChecks(ctx, asString(payload.workItemId, 'payload.workItemId')), ctx.correlationId)
      },
    },
  ],
  [
    'template/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listTemplates(ctx, { domain: optionalString(payload.domain, 'payload.domain') }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'approval/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listApprovals(ctx, {
            approverId: optionalString(payload.approverId, 'payload.approverId'),
            status: optionalString(payload.status, 'payload.status'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'workItem/assign',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.assignWorkItem(ctx, {
          workItemId: idOf(envelope, payload),
          memberId: asString(payload.memberId ?? payload.assigneeId, 'payload.memberId'),
        })
      },
    },
  ],
  [
    'workItem/accept',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.accept(ctx, {
          workItemId: idOf(envelope, payload),
          note: optionalString(payload.note, 'payload.note'),
        })
      },
    },
  ],
  ...[
    ['workItem/pause', 'pause'],
    ['workItem/resume', 'resume'],
    ['workItem/cancel', 'cancel'],
    ['workItem/reopen', 'reopen'],
    ['workItem/retry', 'retry'],
  ].map(([path, method]): [string, Route] => [
    path,
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        const fn = service[method as 'pause' | 'resume' | 'cancel' | 'reopen' | 'retry'].bind(service)
        return fn(ctx, {
          workItemId: idOf(envelope, payload),
          reason: optionalString(payload.reason, 'payload.reason'),
        })
      },
    },
  ]),
  ['workItem/rotateThread',{write:true,handle:(service,ctx,envelope)=>{
    const p=payloadOf(envelope)
    return service.rotateThread(ctx,{workItemId:idOf(envelope,p),sessionId:asString(p.sessionId,'sessionId'),reason:optionalString(p.reason,'reason')})
  }}],
  [
    'workItem/addEvidence',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.appendEvidence(ctx, {
          workItemId: idOf(envelope, payload),
          kind: asString(payload.kind, 'payload.kind'),
          ref: asString(payload.ref, 'payload.ref'),
          observedAt: asNumber(payload.observedAt, 'payload.observedAt'),
          contentHash: optionalString(payload.contentHash, 'payload.contentHash'),
          source: optionalString(payload.source, 'payload.source'),
          runId: optionalString(payload.runId, 'payload.runId'),
          onBehalfOf: optionalString(payload.onBehalfOf, 'payload.onBehalfOf'),
          supersedesId: optionalString(payload.supersedesId, 'payload.supersedesId'),
        })
      },
    },
  ],
  [
    'workItem/reportBlocker',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.reportBlocker(ctx, {
          workItemId: idOf(envelope, payload),
          category: asString(payload.category, 'payload.category'),
          note: asString(payload.note, 'payload.note', { allowEmpty: true }),
        })
      },
    },
  ],
  [
    'workItem/unblock',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        const to = optionalString(payload.to, 'payload.to')
        if (to !== undefined && to !== 'ready' && to !== 'active') {
          throw new HamsError('STATE_INVALID', 'payload.to 只能是 ready 或 active')
        }
        return service.unblock(ctx, { workItemId: idOf(envelope, payload), to })
      },
    },
  ],
  [
    'workItem/requestClosure',
    {
      write: true,
      revisionCheck: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.requestClosure(ctx, {
          workItemId: idOf(envelope, payload),
          reason: asString(payload.reason, 'payload.reason'),
        })
      },
    },
  ],
  [
    'approval/decide',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        const decision = asString(payload.decision, 'payload.decision')
        if (decision !== 'approve' && decision !== 'reject' && decision !== 'return') {
          throw new HamsError('STATE_INVALID', 'payload.decision 只能是 approve / reject / return')
        }
        return service.decideApproval(ctx, {
          approvalId: idOf(envelope, payload, 'approvalId'),
          decision,
          note: optionalString(payload.note, 'payload.note'),
        })
      },
    },
  ],
  [
    'proposal/decide',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        const decision = asString(payload.decision, 'payload.decision')
        if (decision !== 'accept' && decision !== 'reject') {
          throw new HamsError('STATE_INVALID', 'payload.decision 只能是 accept / reject')
        }
        const workItemRaw = payload.workItem === undefined ? undefined : asObject(payload.workItem, 'payload.workItem')
        return service.decideProposal(ctx, {
          proposalId: idOf(envelope, payload, 'proposalId'),
          decision,
          note: asString(payload.note, 'payload.note', { allowEmpty: true }),
          workItem: workItemRaw
            ? {
                domain: asString(workItemRaw.domain, 'payload.workItem.domain'),
                category: asString(workItemRaw.category, 'payload.workItem.category'),
                title: asString(workItemRaw.title, 'payload.workItem.title'),
                ownerHumanId: asString(workItemRaw.ownerHumanId, 'payload.workItem.ownerHumanId'),
                projectId: optionalString(workItemRaw.projectId, 'payload.workItem.projectId'),
                templateVersionId: optionalString(workItemRaw.templateVersionId, 'payload.workItem.templateVersionId'),
                assetId: optionalString(workItemRaw.assetId, 'payload.workItem.assetId'),
                dueAt: workItemRaw.dueAt === undefined ? undefined : asNumber(workItemRaw.dueAt, 'payload.workItem.dueAt'),
              }
            : undefined,
        })
      },
    },
  ],
  [
    'check/evaluate',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.evaluateCheck(ctx, {
          checkId: idOf(envelope, payload, 'checkId'),
        })
      },
    },
  ],
  // ───────────────────────── 项目（M6） ─────────────────────────
  [
    'project/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listProjects(ctx, {
            status: optionalString(payload.status, 'payload.status'),
            type: optionalString(payload.type, 'payload.type'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'project/get',
    {
      write: false,
      handle: (service, ctx, envelope) =>
        ok(
          service.getProjectDetail(ctx, idOf(envelope, payloadOf(envelope), 'projectId')),
          ctx.correlationId,
        ),
    },
  ],
  [
    'project/create',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        const metricList = payload.metrics === undefined ? undefined : payload.metrics
        if (metricList !== undefined && !Array.isArray(metricList)) {
          throw new HamsError('STATE_INVALID', 'payload.metrics 必须是数组')
        }
        const metrics = (metricList as unknown[] | undefined)?.map((item, index) => {
          const metric = asObject(item, `payload.metrics[${index}]`)
          return {
            name: asString(metric.name, `payload.metrics[${index}].name`),
            direction: asString(metric.direction, `payload.metrics[${index}].direction`),
            targetValue:
              metric.targetValue === undefined || metric.targetValue === null
                ? null
                : asNumber(metric.targetValue, `payload.metrics[${index}].targetValue`),
            targetMax:
              metric.targetMax === undefined || metric.targetMax === null
                ? null
                : asNumber(metric.targetMax, `payload.metrics[${index}].targetMax`),
            unit: optionalString(metric.unit, `payload.metrics[${index}].unit`),
            windowKind: asString(metric.windowKind, `payload.metrics[${index}].windowKind`),
            definitionText: optionalString(metric.definitionText, `payload.metrics[${index}].definitionText`),
            sourceKind: optionalString(metric.sourceKind, `payload.metrics[${index}].sourceKind`),
            calculatorKey: optionalString(metric.calculatorKey, 'calculatorKey'),
            calculatorParams: metric.calculatorParams === undefined ? undefined : asObject(metric.calculatorParams,'calculatorParams'),
            sourceRef: optionalString(metric.sourceRef,'sourceRef'),
          }
        })
        return service.createProject(ctx, {
          name: asString(payload.name, 'payload.name'),
          type: asString(payload.type, 'payload.type'),
          goalText: asString(payload.goalText, 'payload.goalText', { allowEmpty: true }),
          ownerHumanId: optionalString(payload.ownerHumanId, 'payload.ownerHumanId'),
          coordinatorId:
            payload.coordinatorId === null ? null : optionalString(payload.coordinatorId, 'payload.coordinatorId'),
          metrics,
          publish: payload.publish === undefined ? undefined : payload.publish === true,
        })
      },
    },
  ],
  [
    'project/saveDraft',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.saveProjectDraft(ctx, {
          projectId: optionalString(payload.projectId, 'payload.projectId'),
          name: asString(payload.name, 'payload.name'),
          type: asString(payload.type, 'payload.type'),
          goalText: asString(payload.goalText ?? '', 'payload.goalText', { allowEmpty: true }),
          coordinatorId:
            payload.coordinatorId === null ? null : optionalString(payload.coordinatorId, 'payload.coordinatorId'),
          metrics: metricListOf(payload, true) as MetricInput[] | undefined,
          step: payload.step === undefined ? undefined : asNumber(payload.step, 'payload.step'),
        })
      },
    },
  ],
  [
    'project/delete',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.deleteProject(ctx, {
          projectId: idOf(envelope, payload, 'projectId'),
          reason: optionalString(payload.reason, 'payload.reason'),
        })
      },
    },
  ],
  [
    'project/status',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.updateProjectStatus(ctx, {
          projectId: idOf(envelope, payload, 'projectId'),
          status: asString(payload.status, 'payload.status'),
          reason: optionalString(payload.reason, 'payload.reason'),
        })
      },
    },
  ],
  [
    'project/memory/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listProjectMemories(ctx, {
            projectId: asString(payload.projectId, 'payload.projectId'),
            status: optionalString(payload.status, 'payload.status'),
            kind: optionalString(payload.kind, 'payload.kind'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'project/memory/create',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.createProjectMemory(ctx, {
          projectId: idOf(envelope, payload, 'projectId'),
          kind: asString(payload.kind, 'payload.kind'),
          title: asString(payload.title, 'payload.title'),
          body: asString(payload.body, 'payload.body'),
          memberId: optionalString(payload.memberId, 'payload.memberId'),
        })
      },
    },
  ],
  [
    'project/memory/update',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.updateProjectMemory(ctx, {
          memoryId: idOf(envelope, payload, 'memoryId'),
          title: optionalString(payload.title, 'payload.title'),
          body: optionalString(payload.body, 'payload.body'),
          status: optionalString(payload.status, 'payload.status'),
        })
      },
    },
  ],
  [
    'project/recordMetric',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.recordMetric(ctx, {
          projectId: idOf(envelope, payload, 'projectId'),
          metricId: asString(payload.metricId, 'payload.metricId'),
          value:
            payload.value === undefined || payload.value === null
              ? null
              : asNumber(payload.value, 'payload.value'),
          observedAt: payload.observedAt === undefined ? undefined : asNumber(payload.observedAt, 'payload.observedAt'),
          windowStart: payload.windowStart === undefined ? undefined : asNumber(payload.windowStart, 'payload.windowStart'),
          windowEnd: payload.windowEnd === undefined ? undefined : asNumber(payload.windowEnd, 'payload.windowEnd'),
          sourceRef: optionalString(payload.sourceRef, 'payload.sourceRef'),
        })
      },
    },
  ],

  ...[
    ['project/publishTarget','publishProjectTarget'],
    ['project/createPhase','createProjectPhase'],
    ['project/updatePhase','updateProjectPhase'],
    ['project/confirmPhase','confirmProjectPhase'],
    ['project/submitTargetCheck','submitProjectTargetCheck'],
    ['project/updateTarget','updateProjectTarget'],
    ['project/addTarget','addProjectTarget'],
    ['project/createReview','createProjectReview'],
    ['project/confirmReview','confirmProjectReview'],
  ].map(([path,method]):[string,Route]=>[path,{write:true,handle:(service,ctx,envelope)=>{
    const payload=payloadOf(envelope)
    return (service[method as 'publishProjectTarget'] as Function).call(service,ctx,{...payload,projectId:idOf(envelope,payload,'projectId')})
  }}]),
  ['project/tryMetric',{write:false,handle:(service,ctx,envelope)=>{
    const p=payloadOf(envelope)
    return ok(service.tryProjectMetric(ctx,{projectId:optionalString(p.projectId,'projectId'),metric:asObject(p.metric,'metric') as any}),ctx.correlationId)
  }}],
  ['member/publishConfig',{write:true,handle:(service,ctx,envelope)=>{
    const p=payloadOf(envelope)
    return service.publishMemberConfig(ctx,{...p,memberId:idOf(envelope,p,'memberId')} as any)
  }}],

  // ───────────────────────── 人机成员（M6） ─────────────────────────
  [
    'member/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listMembers(ctx, {
            kind: optionalString(payload.kind, 'payload.kind'),
            status: optionalString(payload.status, 'payload.status'),
            projectId: optionalString(payload.projectId, 'payload.projectId'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'member/get',
    {
      write: false,
      handle: (service, ctx, envelope) =>
        ok(service.getMemberDetail(ctx, idOf(envelope, payloadOf(envelope), 'memberId')), ctx.correlationId),
    },
  ],
  [
    'position/list',
    {
      write: false,
      handle: (service, ctx) => ok(service.listPositions(ctx), ctx.correlationId),
    },
  ],
  [
    'member/create',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.createMember(ctx, {
          kind: asString(payload.kind, 'payload.kind'),
          name: asString(payload.name, 'payload.name'),
          role: optionalString(payload.role, 'payload.role'),
          domain: optionalString(payload.domain, 'payload.domain'),
          responsibility: optionalString(payload.responsibility, 'payload.responsibility'),
          positionId: optionalString(payload.positionId, 'payload.positionId'),
          ownerHumanId: optionalString(payload.ownerHumanId, 'payload.ownerHumanId'),
          agentPreset: optionalString(payload.agentPreset, 'payload.agentPreset'),
          model: optionalString(payload.model, 'payload.model'),
          capabilities: stringArray(payload.capabilities, 'payload.capabilities'),
          scope: optionalString(payload.scope, 'payload.scope'),
        })
      },
    },
  ],
  [
    'member/status',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.updateMemberStatus(ctx, {
          memberId: idOf(envelope, payload, 'memberId'),
          status: asString(payload.status, 'payload.status'),
        })
      },
    },
  ],

  // ───────────────────────── 知识（M6） ─────────────────────────
  [
    'knowledge/list',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.listKnowledge(ctx, {
            kind: optionalString(payload.kind, 'payload.kind'),
            q: optionalString(payload.q, 'payload.q'),
            limit: payload.limit === undefined ? undefined : asNumber(payload.limit, 'payload.limit'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'knowledge/get',
    {
      write: false,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return ok(
          service.getKnowledge(ctx, {
            kind: asString(payload.kind, 'payload.kind'),
            id: idOf(envelope, payload, 'id'),
          }),
          ctx.correlationId,
        )
      },
    },
  ],
  [
    'knowledge/sync',
    {
      write: true,
      handle: (service, ctx) => service.syncKnowledge(ctx),
    },
  ],
  [
    'knowledge/createDoc',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.createKnowledgeDoc(ctx, {
          title: asString(payload.title, 'payload.title'),
          body: asString(payload.body, 'payload.body', { allowEmpty: true }),
          status: optionalString(payload.status, 'payload.status'),
        })
      },
    },
  ],
  [
    'knowledge/updateDoc',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.updateKnowledgeDoc(ctx, {
          docId: idOf(envelope, payload, 'docId'),
          title: optionalString(payload.title, 'payload.title'),
          body: asString(payload.body, 'payload.body', { allowEmpty: true }),
          expectedRevision:
            payload.expectedRevision === undefined
              ? undefined
              : asNumber(payload.expectedRevision, 'payload.expectedRevision'),
        })
      },
    },
  ],
  [
    'knowledge/publishDoc',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.publishKnowledgeDoc(ctx, { docId: idOf(envelope, payload, 'docId') })
      },
    },
  ],
  [
    'knowledge/importDocs',
    {
      write: true,
      handle: (service, ctx, envelope) => {
        const payload = payloadOf(envelope)
        return service.importKnowledgeDocs(ctx, {
          dir: asString(payload.dir, 'payload.dir'),
          recursive: payload.recursive === undefined ? undefined : payload.recursive === true,
          maxFiles: payload.maxFiles === undefined ? undefined : asNumber(payload.maxFiles, 'payload.maxFiles'),
        })
      },
    },
  ],
])

export const ROUTE_PATHS: string[] = [...ROUTES.keys()].sort()

function json(status: number, body: HamsResponseBody): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  }
}

function transportError(
  status: number,
  correlationId: string,
  message: string,
  code: 'STATE_INVALID' | 'HOST_CAPABILITY_MISSING' = 'STATE_INVALID',
): HttpResponse {
  const body: ErrorResult = {
    ok: false,
    correlationId,
    error: { code, message, nextStep: '检查请求路径与请求头后重试' },
  }
  return json(status, body)
}

/** 认证失败也用同一份错误信封，界面按码分支；只有 401 才提示「重开带 token 的地址」。 */
function authError(correlationId: string, auth: AuthFailure): HttpResponse {
  const status = auth.reason === 'UNAUTHORIZED' ? 401 : 403
  return json(status, {
    ok: false,
    correlationId,
    error: {
      code: 'POLICY_DENIED',
      message: auth.message,
      nextStep:
        auth.nextStep ??
        (status === 401
          ? '重新打开 dsh 打印的带 ?token= 的地址（或刷新页面）后再试'
          : '确认请求来自本机面板后重试'),
    },
  })
}

let counter = 0

export function createHamsHttpHandler(deps: HamsHttpDeps): (request: HttpRequest) => HttpResponse | Promise<HttpResponse> {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY
  const newCorrelationId = deps.correlationId ?? (() => `http-${Date.now().toString(36)}-${(counter += 1)}`)

  // 同步命令一定返回对象（老测试与适配器都按同步读）；只有对话这类要等宿主会话的命令返回 Promise。
  const finish = (routeKey: string, result: CommandReceipt | QueryResult, correlationId: string): HttpResponse => {
    if (routeKey === 'ops/health' && result.ok && 'data' in result) {
      return json(200, { ...result, data: { ...result.data as object, readOnly: deps.readOnly === true } })
    }
    return json(200, result)
  }

  return function handle(request: HttpRequest): HttpResponse | Promise<HttpResponse> {
    const correlationId = newCorrelationId()

    if (request.method.toUpperCase() !== 'POST') {
      return transportError(405, correlationId, '只接受 POST')
    }
    if (!request.path.startsWith(API_PREFIX)) {
      return transportError(404, correlationId, `未知接口：${request.path}`)
    }
    const routeKey = request.path.slice(API_PREFIX.length)
    const route = ROUTES.get(routeKey)
    if (!route) return transportError(404, correlationId, `未知命令：${routeKey}`)

    if (Buffer.byteLength(request.body, 'utf8') > maxBody) {
      return transportError(413, correlationId, '请求体过大')
    }

    const auth = deps.authenticate(request)
    if (!auth.ok) {
      return authError(correlationId, auth)
    }

    let rawBody: unknown
    try {
      rawBody = JSON.parse(request.body || '{}')
    } catch {
      return transportError(400, correlationId, '请求体不是合法 JSON')
    }

    let envelope: CommandEnvelope
    try {
      envelope = requireEnvelope(rawBody, { write: route.write, correlationId })
    } catch (error) {
      return json(200, rejectedReceipt(correlationId, error))
    }

    const ctx = toCommandContext({
      principalId: auth.principalId,
      channel: 'ui',
      correlationId,
      envelope,
      authSubject: auth.authSubject,
      hostPreset: auth.hostPreset,
      onBehalfOf: auth.onBehalfOf,
    })

    try {
      if (deps.readOnly && route.write) {
        throw new HamsError('HOST_CAPABILITY_MISSING', '另一实例持有写锁，当前实例为只读视图', {
          nextStep: '关闭另一实例，或等它释放写锁后重试',
        })
      }
      const principal = deps.service.whoami(ctx).principal
      if (principal.kind === 'bot') {
        // 通道隔离：bot 的动作只能走工具通道，不能借 HTTP 冒充人。
        return json(200, rejectedReceipt(correlationId, new HamsError('POLICY_DENIED', 'bot 只能通过工具通道动作，不能调用 UI 接口')))
      }
      const result = route.handle(deps.service, ctx, envelope, { chat: deps.chat })
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<CommandReceipt | QueryResult>)
          .then((settled) => finish(routeKey, settled, correlationId))
          .catch((error) => json(200, rejectedReceipt(correlationId, error)))
      }
      return finish(routeKey, result as CommandReceipt | QueryResult, correlationId)
    } catch (error) {
      return json(200, rejectedReceipt(correlationId, error))
    }
  }
}
