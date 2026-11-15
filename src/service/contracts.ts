/**
 * HTTP 契约：统一信封、统一回执、错误码 → 界面文案。
 *
 * 形态只有一种（backend-design §9）：
 *   POST /hams/api/v1/<domain>/<command>
 * 字面精确匹配；进站顺序固定为「验来源与主机 → 解析主体 → 校验岗位 → 解析负载 →
 * 查幂等 → 领域命令事务 → 审计与游标 → 回执」。
 *
 * 这一层只做协议与映射，不碰 `ctx.webServer`——宿主注册要等 C2 实测（能不能读
 * Origin / 自定义头）之后再接，避免把没验证过的假设写进核心路径。
 */
import type { HamsErrorCode } from '../domain/errors.ts'
import { HamsError } from '../domain/errors.ts'
import type { CommandContext, CommandReceipt } from './types.ts'

export interface CommandEnvelope {
  commandId: string
  idempotencyKey?: string
  objectId?: string
  expectedRevision?: number
  expectedEpoch?: number
  payload?: unknown
}

export interface QueryResult<T = unknown> {
  ok: true
  data: T
  correlationId: string
}

export interface ErrorResult {
  ok: false
  correlationId: string
  error: {
    code: HamsErrorCode
    message: string
    nextStep: string
    detail?: unknown
  }
}

export type HamsResponseBody = CommandReceipt | QueryResult | ErrorResult

/**
 * 每个错误码对应的「下一步该做什么」——界面不许自己拼字符串，也不许只说「失败」。
 * 与 backend §9 的表格一一对应；用例会断言每个码都有文案。
 */
export const NEXT_STEP: Record<HamsErrorCode, string> = {
  VERSION_CONFLICT: '刷新后在最新版本上重做；你的输入不会丢',
  EVIDENCE_CHANGED: '材料已变，请按新材料重新申请',
  APPROVAL_EXPIRED: '这张审批已过期，请重新申请',
  NOT_APPROVER: '只有申请时指定的审批人可以处理',
  POLICY_DENIED: '确认岗位是否在岗、是否具备该能力；需要时找管理员授权',
  STATE_INVALID: '刷新后重试；若状态已变，按当前状态里的可用动作操作',
  EPOCH_STALE: '这次操作已因生命周期变化作废，请刷新后重来',
  APPROVAL_REQUIRED: '先去申请关单，等有效审批通过',
  EVIDENCE_INCOMPLETE: '补齐缺的证据后重新申请',
  LEASE_LOST: '租约已被回收，运行结果记为未知，请核对后再重试',
  IDEMPOTENCY_MISMATCH: '同一幂等键不能改载荷；请换一个幂等键重试',
  CURSOR_EXPIRED: '游标已超出保留期，请重新拉取快照',
  DATA_STALE: '数据源已过期，结论只能记「无法判断」',
  EXTERNAL_RESULT_UNKNOWN: '外部动作结果不明，请去对账，不要直接重发',
  HOST_CAPABILITY_MISSING: '宿主能力缺失，已按降级方式处理；详情见诊断页',
}

export function nextStepFor(code: HamsErrorCode): string {
  return NEXT_STEP[code] ?? '联系管理员'
}

export interface ReceiptError {
  code: HamsErrorCode
  message: string
  nextStep: string
  detail?: unknown
}

/** 领域错误 → 回执错误块；非 HamsError 一律按 STATE_INVALID 处理，绝不把堆栈抛给界面。 */
export function toReceiptError(error: unknown): ReceiptError {
  if (error instanceof HamsError) {
    return {
      code: error.code,
      message: error.message,
      nextStep: error.nextStep ?? nextStepFor(error.code),
      detail: error.detail,
    }
  }
  return {
    code: 'STATE_INVALID',
    message: error instanceof Error ? error.message : String(error),
    nextStep: nextStepFor('STATE_INVALID'),
  }
}

export function rejectedReceipt(correlationId: string, error: unknown): CommandReceipt {
  return {
    ok: false,
    status: 'rejected',
    auditId: '',
    correlationId,
    error: toReceiptError(error),
  }
}

export function errorResult(correlationId: string, error: unknown): ErrorResult {
  const mapped = toReceiptError(error)
  return { ok: false, correlationId, error: mapped }
}

// ───────────────────────── 负载校验 ─────────────────────────
//
// 这一版不引入 zod：需要的形状很少，手写校验更直白；校验失败统一走 STATE_INVALID，
// 界面看到的是「这个请求不完整」，而不是 500。

export class PayloadError extends HamsError {
  constructor(message: string) {
    super('STATE_INVALID', message, { nextStep: '检查请求参数后重试' })
    this.name = 'PayloadError'
  }
}

export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PayloadError(`${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}

export function asString(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new PayloadError(`${field} 必须是字符串`)
  if (!options.allowEmpty && value.trim().length === 0) throw new PayloadError(`${field} 不能为空`)
  return value
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return asString(value, field, { allowEmpty: true })
}

export function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new PayloadError(`${field} 必须是数字`)
  return parsed
}

export function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return asNumber(value, field)
}

export function asArray<T = unknown>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) throw new PayloadError(`${field} 必须是数组`)
  return value as T[]
}

export function requireEnvelope(raw: unknown, options: { write: boolean; correlationId: string }): CommandEnvelope {
  const body = asObject(raw, '请求体')
  const commandId = asString(body.commandId, 'commandId')
  const idempotencyKey = optionalString(body.idempotencyKey, 'idempotencyKey')
  if (options.write && !idempotencyKey) {
    // 写命令必须能重放：没有幂等键就无法保证「同一个请求只生效一次」。
    throw new PayloadError(`写命令必须带 idempotencyKey（command ${commandId}）`)
  }
  const envelope: CommandEnvelope = {
    commandId,
    idempotencyKey,
    objectId: optionalString(body.objectId, 'objectId'),
    expectedRevision: optionalNumber(body.expectedRevision, 'expectedRevision'),
    expectedEpoch: optionalNumber(body.expectedEpoch, 'expectedEpoch'),
    payload: body.payload,
  }
  return envelope
}

export function toCommandContext(input: {
  principalId: string
  channel: CommandContext['channel']
  correlationId: string
  envelope: CommandEnvelope
  authSubject?: string
  hostPreset?: string
  onBehalfOf?: string
}): CommandContext {
  return {
    principalId: input.principalId,
    channel: input.channel,
    correlationId: input.correlationId,
    idempotencyKey: input.envelope.idempotencyKey,
    expectedRevision: input.envelope.expectedRevision,
    authSubject: input.authSubject,
    hostPreset: input.hostPreset,
    onBehalfOf: input.onBehalfOf,
  }
}
