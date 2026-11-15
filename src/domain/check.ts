/**
 * 复查时点与模板策略解析。
 *
 * 三种复查节奏（backend-design §4.3 / 画板 ③）：
 * - `next_day_at`：次日当地 `HH:mm`（默认 09:00）；
 * - `after_hours`：N 小时后；
 * - `next_working_day`：下一工作日当地 `HH:mm`。
 *
 * 时区换算不引依赖：用 `Intl.DateTimeFormat` 取某时区的挂钟分量，再用
 * 「把挂钟当 UTC 求偏移、迭代两次」的方式把挂钟时间转回 UTC 瞬时。跨 DST 的
 * 边界会落在 ±1 小时以内，对「次日 09:00 复查」这种粒度足够；真需要分钟级
 * 精确的场合应改用带时区库，这一点写在这里而不是偷偷假设。
 */
import { stateInvalid } from './errors.ts'

export type CheckMode = 'next_day_at' | 'after_hours' | 'next_working_day'

export interface CheckPolicy {
  mode: CheckMode
  time: string
  tz: string
  hours: number
  maxRechecks: number | null
}

export interface ReviewPolicy {
  /** `owner` 或 `position:<id>`。 */
  approver: string
  expiresHours: number
  autoClose: boolean
}

const DEFAULT_TZ = 'Asia/Shanghai'

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function parseClock(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (!match) throw stateInvalid(`时间格式必须是 HH:mm，收到 ${time}`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function zoneParts(ms: number, timeZone: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(new Date(ms))
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  }
}

function offsetAt(ms: number, timeZone: string): number {
  const parts = zoneParts(ms, timeZone)
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return wallAsUtc - Math.floor(ms / 1000) * 1000
}

/** 把某时区的挂钟时间转成 UTC 毫秒。 */
export function wallToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let candidate = guess - offsetAt(guess, timeZone)
  // DST 切换附近，候选时刻的偏移可能和 guess 处不同；只有挂钟分量对不上时才再校准一次。
  const local = zoneParts(candidate, timeZone)
  if (local.hour !== hour || local.minute !== minute) {
    candidate = guess - offsetAt(candidate, timeZone)
  }
  return candidate
}

function normalizeDate(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

export function parseCheckPolicy(json: string | null | undefined): CheckPolicy {
  const fallback: CheckPolicy = {
    mode: 'after_hours',
    time: '09:00',
    tz: DEFAULT_TZ,
    hours: 24,
    maxRechecks: null,
  }
  if (!json || !json.trim()) return fallback
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw stateInvalid(`check_policy_json 不是合法 JSON：${json}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const item = raw as Record<string, unknown>
  const mode = typeof item.mode === 'string' ? (item.mode as CheckMode) : fallback.mode
  if (!['next_day_at', 'after_hours', 'next_working_day'].includes(mode)) {
    throw stateInvalid(`未知的复查节奏：${String(item.mode)}`)
  }
  const tz = typeof item.tz === 'string' && item.tz.trim() ? item.tz.trim() : DEFAULT_TZ
  const time = typeof item.time === 'string' && item.time.trim() ? item.time.trim() : fallback.time
  parseClock(time)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw stateInvalid(`未知时区：${tz}`)
  }
  const hours = item.hours === undefined ? fallback.hours : Number(item.hours)
  if (!Number.isFinite(hours) || hours <= 0) throw stateInvalid(`复查间隔小时数必须是正数：${String(item.hours)}`)
  const maxRaw = item.max_rechecks ?? item.maxRechecks
  const maxRechecks =
    maxRaw === undefined || maxRaw === null ? null : Number.isInteger(Number(maxRaw)) && Number(maxRaw) >= 0 ? Number(maxRaw) : null
  return { mode, time, tz, hours, maxRechecks }
}

export function nextCheckAt(policy: CheckPolicy, fromMs: number): number {
  if (policy.mode === 'after_hours') return fromMs + policy.hours * 3_600_000

  const { hour, minute } = parseClock(policy.time)
  const local = zoneParts(fromMs, policy.tz)

  if (policy.mode === 'next_day_at') {
    const nextDay = normalizeDate(local.year, local.month, local.day + 1)
    return wallToUtc(policy.tz, nextDay.year, nextDay.month, nextDay.day, hour, minute)
  }

  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = normalizeDate(local.year, local.month, local.day + offset)
    const weekday = weekdayOf(candidate.year, candidate.month, candidate.day)
    if (weekday === 0 || weekday === 6) continue
    return wallToUtc(policy.tz, candidate.year, candidate.month, candidate.day, hour, minute)
  }
  throw stateInvalid('无法计算下一工作日：日期滚动超过 8 天')
}

export function parseReviewPolicy(json: string | null | undefined): ReviewPolicy {
  const fallback: ReviewPolicy = { approver: 'owner', expiresHours: 24, autoClose: false }
  if (!json || !json.trim()) return fallback
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw stateInvalid(`review_policy_json 不是合法 JSON：${json}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const item = raw as Record<string, unknown>
  const approver = typeof item.approver === 'string' && item.approver.trim() ? item.approver.trim() : fallback.approver
  if (approver !== 'owner' && !/^position:.+$/.test(approver)) {
    throw stateInvalid(`review_policy.approver 只支持 owner 或 position:<id>，收到 ${approver}`)
  }
  const expiresRaw = item.expires_hours ?? item.expiresHours ?? fallback.expiresHours
  const expiresHours = Number(expiresRaw)
  if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
    throw stateInvalid(`review_policy.expires_hours 必须是正数：${String(expiresRaw)}`)
  }
  const autoClose = item.auto_close === true || item.autoClose === true
  return { approver, expiresHours, autoClose }
}

export function formatClock(time: string): string {
  const { hour, minute } = parseClock(time)
  return `${two(hour)}:${two(minute)}`
}
