/**
 * 错误码：与 backend-design §9 的 15 类错误一一对应。
 *
 * 这 15 个码是界面文案的分支依据，**不要随手新增**——新增一个码就意味着界面要
 * 多一个分支说明。内部配置/实现错误尽量复用到语义最近的码，并在 message 里写清，
 * 例如「模板的复查策略无法解析」用 STATE_INVALID 而不是造一个 CONFIG_INVALID。
 */
export const HAMS_ERROR_CODES = [
  'VERSION_CONFLICT',
  'EVIDENCE_CHANGED',
  'APPROVAL_EXPIRED',
  'NOT_APPROVER',
  'POLICY_DENIED',
  'STATE_INVALID',
  'EPOCH_STALE',
  'APPROVAL_REQUIRED',
  'EVIDENCE_INCOMPLETE',
  'LEASE_LOST',
  'IDEMPOTENCY_MISMATCH',
  'CURSOR_EXPIRED',
  'DATA_STALE',
  'EXTERNAL_RESULT_UNKNOWN',
  'HOST_CAPABILITY_MISSING',
] as const

export type HamsErrorCode = (typeof HAMS_ERROR_CODES)[number]

export class HamsError extends Error {
  code: HamsErrorCode
  nextStep: string | undefined
  detail: unknown

  constructor(code: HamsErrorCode, message: string, options: { nextStep?: string; detail?: unknown } = {}) {
    super(message)
    this.name = 'HamsError'
    this.code = code
    this.nextStep = options.nextStep
    this.detail = options.detail
  }
}

export function isHamsError(error: unknown): error is HamsError {
  return error instanceof HamsError
}

export function denied(message: string, nextStep?: string): HamsError {
  return new HamsError('POLICY_DENIED', message, { nextStep })
}

export function stateInvalid(message: string, nextStep?: string): HamsError {
  return new HamsError('STATE_INVALID', message, { nextStep })
}

export function evidenceIncomplete(message: string, detail?: unknown): HamsError {
  return new HamsError('EVIDENCE_INCOMPLETE', message, {
    detail,
    nextStep: '补齐缺的证据后重新申请',
  })
}
