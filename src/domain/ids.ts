/**
 * 主键：ULID 文本（26 位 Crockford Base32，前 10 位毫秒时间戳）。
 *
 * 没有引入依赖：ULID 的规范只有两段——时间前缀 + 80 位随机数。这里不做同毫秒单调
 * 递增的严格实现（同一毫秒内靠随机位去重），因为所有插入都发生在单写者事务里，
 * 冲突由主键约束兜底。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type IdFactory = () => string

export function ulidAt(nowMs: number, random: () => number = Math.random): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error(`非法时间戳：${nowMs}`)
  let timePart = ''
  let rest = Math.floor(nowMs)
  for (let i = 0; i < 10; i += 1) {
    timePart = ENCODING[rest % 32] + timePart
    rest = Math.floor(rest / 32)
  }
  let randomPart = ''
  for (let i = 0; i < 16; i += 1) {
    randomPart += ENCODING[Math.floor(random() * 32)]
  }
  return timePart + randomPart
}

export function createIdFactory(now: () => number, random: () => number = Math.random): IdFactory {
  return () => ulidAt(now(), random)
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
