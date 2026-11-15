import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextCheckAt,
  parseCheckPolicy,
  parseReviewPolicy,
  wallToUtc,
} from '../../src/domain/check.ts'
import {
  evaluateRequirements,
  evidenceSetHash,
  parseEvidenceRequirements,
  type EvidenceSnapshotRow,
} from '../../src/domain/evidence.ts'
import { ulidAt, ULID_PATTERN } from '../../src/domain/ids.ts'

const CN_0900 = (month: number, day: number): number => Date.UTC(2026, month - 1, day, 1, 0, 0)

test('c01 次日 09:00 按当地时区换算（亚洲/上海 = UTC+8）', () => {
  const from = Date.UTC(2026, 10, 14, 1, 0, 0) // 2026-11-14 09:00 Asia/Shanghai
  const policy = parseCheckPolicy(JSON.stringify({ mode: 'next_day_at', time: '09:00', tz: 'Asia/Shanghai' }))
  assert.equal(nextCheckAt(policy, from), CN_0900(11, 15))
  assert.equal(wallToUtc('Asia/Shanghai', 2026, 11, 15, 9, 0), CN_0900(11, 15))
})

test('c02 次日 09:00：从当地凌晨算也指向未来的 09:00', () => {
  const from = Date.UTC(2026, 10, 14, 20, 0, 0) // 2026-11-15 04:00 Asia/Shanghai
  const policy = parseCheckPolicy(JSON.stringify({ mode: 'next_day_at', tz: 'Asia/Shanghai' }))
  assert.equal(nextCheckAt(policy, from), CN_0900(11, 16))
})

test('c03 after_hours 与 next_working_day', () => {
  const after = parseCheckPolicy(JSON.stringify({ mode: 'after_hours', hours: 6 }))
  assert.equal(nextCheckAt(after, 1_000_000), 1_000_000 + 6 * 3_600_000)

  // 2026-11-13 是周五 09:00（上海），下一工作日应跳到周一 11-16 09:00。
  const friday = CN_0900(11, 13)
  const working = parseCheckPolicy(JSON.stringify({ mode: 'next_working_day', time: '09:00', tz: 'Asia/Shanghai' }))
  assert.equal(nextCheckAt(working, friday), CN_0900(11, 16))
})

test('c04 策略解析：空值给 24 小时默认，非法值失败关闭', () => {
  assert.deepEqual(parseCheckPolicy('{}'), {
    mode: 'after_hours',
    time: '09:00',
    tz: 'Asia/Shanghai',
    hours: 24,
    maxRechecks: null,
  })
  assert.throws(() => parseCheckPolicy(JSON.stringify({ mode: 'next_day_at', time: '25:00' })), /HH:mm/)
  assert.throws(() => parseCheckPolicy(JSON.stringify({ mode: 'next_day_at', tz: 'Mars/Base' })), /未知时区/)
  assert.throws(() => parseCheckPolicy('{not json'), /合法 JSON/)

  assert.deepEqual(parseReviewPolicy('{}'), { approver: 'owner', expiresHours: 24, autoClose: false })
  assert.deepEqual(parseReviewPolicy(JSON.stringify({ approver: 'position:pos_approver', expires_hours: 4, auto_close: true })), {
    approver: 'position:pos_approver',
    expiresHours: 4,
    autoClose: true,
  })
  assert.throws(() => parseReviewPolicy(JSON.stringify({ approver: 'team' })), /approver/)
})

function row(id: string, kind: string, observedAt: number, status = 'active'): EvidenceSnapshotRow {
  return { id, kind, contentHash: `hash-${id}`, observedAt, status }
}

test('c05 证据集哈希：只算 active、与输入顺序无关', () => {
  const rows = [row('01A', 'reading', 100), row('01B', 'photo', 200), row('01C', 'reading', 300, 'superseded')]
  const a = evidenceSetHash(rows)
  const b = evidenceSetHash([...rows].reverse())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)

  const withoutSuperseded = evidenceSetHash([row('01A', 'reading', 100), row('01B', 'photo', 200)])
  assert.equal(a, withoutSuperseded, 'superseded 的证据不参与哈希')
  assert.notEqual(evidenceSetHash([row('01A', 'reading', 100)]), a)
})

test('c06 证据要求：条数、时效与缺口说明', () => {
  const requirements = parseEvidenceRequirements(
    JSON.stringify([
      { kind: 'reading', min_count: 2, max_age_hours: 24 },
      { kind: 'photo', min_count: 1 },
    ]),
  )
  const now = 100 * 3_600_000
  const ok = evaluateRequirements(
    [row('a', 'reading', now - 3_600_000), row('b', 'reading', now - 7_200_000), row('c', 'photo', 0)],
    requirements,
    now,
  )
  assert.equal(ok.satisfied, true)
  assert.deepEqual(ok.missing, [])

  const missingPhoto = evaluateRequirements([row('a', 'reading', now - 1000), row('b', 'reading', now - 2000)], requirements, now)
  assert.equal(missingPhoto.satisfied, false)
  assert.deepEqual(missingPhoto.missing, [{ kind: 'photo', need: 1, have: 0, reason: 'count' }])

  const stale = evaluateRequirements(
    [row('a', 'reading', now - 30 * 3_600_000), row('b', 'reading', now - 2_000), row('c', 'photo', 0)],
    requirements,
    now,
  )
  assert.equal(stale.satisfied, false)
  assert.deepEqual(stale.missing, [{ kind: 'reading', need: 2, have: 1, reason: 'stale' }])

  assert.deepEqual(parseEvidenceRequirements('[]'), [])
  assert.throws(() => parseEvidenceRequirements('[{"kind":"reading","min_count":0}]'), /min_count/)
})

test('c07 ULID：26 位、时间前缀可排序、同毫秒不依赖单调', () => {
  const first = ulidAt(Date.UTC(2026, 10, 14), () => 0)
  const second = ulidAt(Date.UTC(2026, 10, 15), () => 0)
  assert.match(first, ULID_PATTERN)
  assert.equal(first.length, 26)
  assert.ok(first < second, '时间前缀决定字典序')
  assert.notEqual(ulidAt(1_000, () => 0.1), ulidAt(1_000, () => 0.9))
})
