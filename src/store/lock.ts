/**
 * 单写者锁：$DSH_HOME/hams/hams.lock（JSON：pid / started_at / heartbeat_at / hostname / token）。
 *
 * 语义（dsh-compat §7）：
 * - 拿到锁的进程才允许迁移、tick 与写命令；拿不到的实例只读打开并在界面说明；
 * - 持有进程已不存在，或心跳超过 staleMs（默认 30 秒），视为陈旧锁，可接管；
 * - 接管与续期都用「写临时文件 + rename」的原子替换，rename 覆盖是原子的，
 *   写完再读回校验 token，避免两个进程同时接管后都以为自己是写者；
 * - 释放只删自己 token 的锁，绝不删别人的。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { StoreError } from './db.ts'

export const LOCK_FILENAME = 'hams.lock'
export const DEFAULT_STALE_MS = 30_000

export interface LockInfo {
  token: string
  pid: number
  hostname: string
  startedAt: number
  heartbeatAt: number
  runtimeEpoch: number
}

export class LockHeldError extends StoreError {
  holder: LockInfo | null

  constructor(holder: LockInfo | null, lockPath: string) {
    super(
      'LOCK_HELD',
      holder
        ? `数据目录已被 pid=${holder.pid}（${holder.hostname}，心跳 ${holder.heartbeatAt}）持有：${lockPath}`
        : `数据目录锁存在但内容不可解析，已按陈旧锁处理失败：${lockPath}`,
    )
    this.holder = holder
  }
}

export interface AcquireLockOptions {
  staleMs?: number
  now?: number
  pid?: number
  hostname?: string
  runtimeEpoch?: number
}

export interface LockHandle {
  path: string
  info: LockInfo
  /** 刷新心跳；返回写入后的快照。 */
  heartbeat(now?: number): LockInfo
  /** 只删自己 token 的锁；返回是否真的删掉了。 */
  release(): boolean
  ageMs(now?: number): number
}

export function lockPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), LOCK_FILENAME)
}

export function readLock(dataDir: string): LockInfo | null {
  const file = lockPath(dataDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.heartbeatAt !== 'number'
    ) {
      return null
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      heartbeatAt: parsed.heartbeatAt,
      runtimeEpoch: typeof parsed.runtimeEpoch === 'number' ? parsed.runtimeEpoch : 0,
    }
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但无权发信号，仍算活着。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writeAtomic(target: string, info: LockInfo): void {
  const tmp = `${target}.${info.token}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
}

export function acquireLock(dataDir: string, options: AcquireLockOptions = {}): LockHandle {
  const dir = path.resolve(dataDir)
  const file = lockPath(dir)
  const now = options.now ?? Date.now()
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const pid = options.pid ?? process.pid
  const hostname = options.hostname ?? osHostname()

  mkdirSync(dir, { recursive: true })

  const candidate: LockInfo = {
    token: randomUUID(),
    pid,
    hostname,
    startedAt: now,
    heartbeatAt: now,
    runtimeEpoch: options.runtimeEpoch ?? 0,
  }

  const current = readLock(dir)
  if (current) {
    const sameHost = current.hostname === hostname
    const heartbeatAge = now - current.heartbeatAt
    const dead = sameHost && !isProcessAlive(current.pid)
    const stale = dead || heartbeatAge > staleMs
    if (!stale) {
      if (sameHost && current.pid === pid) {
        throw new StoreError(
          'LOCK_HELD_SELF',
          `本进程（pid=${pid}）已经持有该数据目录的锁：${file}；不要重复获取`,
        )
      }
      throw new LockHeldError(current, file)
    }
  }

  writeAtomic(file, candidate)
  const confirmed = readLock(dir)
  if (!confirmed || confirmed.token !== candidate.token) {
    throw new LockHeldError(confirmed, file)
  }

  let released = false

  const handle: LockHandle = {
    path: file,
    info: confirmed,
    heartbeat(at?: number): LockInfo {
      if (released) throw new StoreError('LOCK_RELEASED', '锁已释放，不能再续期')
      const currentInfo = readLock(dir)
      if (!currentInfo || currentInfo.token !== candidate.token) {
        throw new StoreError('LOCK_LOST', '锁已被其它进程接管，续期失败')
      }
      const next: LockInfo = {
        ...currentInfo,
        heartbeatAt: at ?? Date.now(),
        runtimeEpoch: currentInfo.runtimeEpoch,
      }
      writeAtomic(file, next)
      handle.info = next
      return next
    },
    release(): boolean {
      if (released) return false
      const currentInfo = readLock(dir)
      if (!currentInfo || currentInfo.token !== candidate.token) {
        released = true
        return false
      }
      unlinkSync(file)
      released = true
      return true
    },
    ageMs(at?: number): number {
      return (at ?? Date.now()) - handle.info.heartbeatAt
    },
  }

  handle.info = confirmed
  return handle
}
