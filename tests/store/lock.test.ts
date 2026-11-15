import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import {
  DEFAULT_STALE_MS,
  LockHeldError,
  acquireLock,
  isProcessAlive,
  lockPath,
  readLock,
} from '../../src/store/lock.ts'
import { createSandbox, sandboxPath } from './helpers.ts'

function seedLockFile(dir: string, info: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(lockPath(dir), JSON.stringify(info))
}

test('t01 首次获取、续期、释放', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')

  const handle = acquireLock(dir, { now: 1_000 })
  assert.equal(readLock(dir)?.token, handle.info.token)
  assert.equal(readLock(dir)?.pid, process.pid)
  assert.equal(statSync(lockPath(dir)).mode & 0o777, 0o600, '锁文件应对同机其他用户不可读写')

  const renewed = handle.heartbeat(5_000)
  assert.equal(renewed.heartbeatAt, 5_000)
  assert.equal(readLock(dir)?.heartbeatAt, 5_000)

  assert.equal(handle.release(), true)
  assert.equal(readLock(dir), null)
  assert.equal(handle.release(), false, '重复释放不能报成功')
})

test('t02 持有者活着且心跳新鲜：拒绝第二个写者', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')
  seedLockFile(dir, {
    token: 'holder-token',
    pid: process.pid,
    hostname: 'other-host', // 别的机器上的进程无法探测，只能看心跳
    startedAt: 1_000,
    heartbeatAt: 2_000,
    runtimeEpoch: 3,
  })

  assert.throws(
    () => acquireLock(dir, { now: 2_100 }),
    (error: unknown) => {
      assert.ok(error instanceof LockHeldError)
      assert.equal((error as LockHeldError).code, 'LOCK_HELD')
      assert.equal((error as LockHeldError).holder?.token, 'holder-token')
      return true
    },
  )
  assert.equal(readLock(dir)?.token, 'holder-token', '失败的获取不能改写别人的锁')
})

test('t03 心跳过期：按陈旧锁接管，token 换新', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')
  seedLockFile(dir, {
    token: 'stale-token',
    pid: process.pid,
    hostname: 'other-host',
    startedAt: 1_000,
    heartbeatAt: 1_000,
    runtimeEpoch: 1,
  })

  const handle = acquireLock(dir, { now: 1_000 + DEFAULT_STALE_MS + 1 })
  assert.notEqual(handle.info.token, 'stale-token')
  assert.equal(readLock(dir)?.token, handle.info.token)
  handle.release()
})

test('t04 同机进程已消失：不看心跳也能接管', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')
  seedLockFile(dir, {
    token: 'dead-token',
    pid: 999_999,
    hostname: osHostname(),
    startedAt: 1_000,
    heartbeatAt: 1_000,
    runtimeEpoch: 1,
  })

  const handle = acquireLock(dir, { now: 1_001 })
  assert.notEqual(handle.info.token, 'dead-token')
  handle.release()
})

test('t05 锁文件内容损坏：按陈旧锁处理', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')
  mkdirSync(dir, { recursive: true })
  writeFileSync(lockPath(dir), 'this is not json\n')

  assert.equal(readLock(dir), null)
  const handle = acquireLock(dir, { now: 1_000 })
  assert.ok(handle.info.token)
  handle.release()
})

test('t06 同进程重复获取：明确报 LOCK_HELD_SELF，不静默共享', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')

  const handle = acquireLock(dir, { now: 1_000 })
  assert.throws(
    () => acquireLock(dir, { now: 1_000 }),
    (error: unknown) => (error as { code?: string }).code === 'LOCK_HELD_SELF',
  )
  handle.release()
})

test('t07 锁被别的进程接管后，续期与释放都不能动对方的文件', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'data')

  const handle = acquireLock(dir, { now: 1_000 })
  seedLockFile(dir, {
    token: 'usurper',
    pid: process.pid,
    hostname: osHostname(),
    startedAt: 2_000,
    heartbeatAt: 2_000,
    runtimeEpoch: 2,
  })

  assert.throws(
    () => handle.heartbeat(3_000),
    (error: unknown) => (error as { code?: string }).code === 'LOCK_LOST',
  )
  assert.equal(handle.release(), false)
  const onDisk = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as { token: string }
  assert.equal(onDisk.token, 'usurper', '释放失败时不能删掉别人的锁')
})

test('t08 进程存活探测：当前进程活着，非法 pid 一律当死', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(999_999), false)
})
