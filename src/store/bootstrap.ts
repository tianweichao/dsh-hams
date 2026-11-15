/**
 * 存储启动编排：严格按 dsh-compat §7 的顺序
 *
 *   拿锁 → 开可写库 → （库非空则）备份 → 迁移 → 种子元数据 → runtime_epoch +1 → 交付
 *
 * 细节取舍：
 * - 空库（user_version=0）不备份：没有业务数据可保，备份只会制造噪音；
 * - 非空库升级前必先备份，备份校验不过就**不迁移**，宁可起不来也不带着坏备份往前走；
 * - 任何一步失败都要回滚并释放锁，绝不半启动接流量（错误原样上抛，由插件置诊断态）；
 * - `recover()` 冷启动对账属于 M4，这里不做，但 runtime_epoch 已经就位供它使用。
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  closeDatabase,
  databasePath,
  openDatabase,
  resolveDataDir,
  userVersion,
  StoreError,
} from './db.ts'
import { acquireLock, lockPath, type LockHandle } from './lock.ts'
import { backupDir, createBackup, type BackupReport } from './backup.ts'
import {
  MIGRATIONS,
  P1_SCHEMA_META,
  SchemaTooNewError,
  TARGET_VERSION,
  migrate,
  type Migration,
} from './migrations.ts'
import {
  assertBaselineSeed,
  bumpRuntimeEpoch,
  ensureMetaDefaults,
  readMeta,
  type SeedSummary,
} from './seed.ts'

export interface BootstrapOptions {
  /** 数据目录；缺省 = $DSH_HOME/hams。 */
  dataDir?: string
  migrations?: readonly Migration[]
  now?: () => number
  backupKeep?: number
  staleMs?: number
  /** 默认 true；关掉只用于测试「不备份直接迁移」的失败路径。 */
  backupBeforeMigrate?: boolean
}

export interface BootstrapReport {
  dataDir: string
  dbPath: string
  lockPath: string
  fromVersion: number
  toVersion: number
  runtimeEpoch: number
  backup: { name: string; path: string; bytes: number; tables: number } | null
  migration: { migrated: boolean; applied: { version: number; name: string }[]; checkedBaseline: boolean }
  seed: SeedSummary
  meta: Record<string, string>
  steps: string[]
}

export interface StoreRuntime {
  dataDir: string
  dbPath: string
  db: DatabaseSync
  lock: LockHandle
  report: BootstrapReport
  readonly closed: boolean
  close(): void
}

function toBackupSummary(report: BackupReport | null): BootstrapReport['backup'] {
  if (!report) return null
  return { name: report.name, path: report.path, bytes: report.bytes, tables: report.tables }
}

export function bootstrapStore(options: BootstrapOptions = {}): StoreRuntime {
  const now = options.now ?? Date.now
  const migrations = options.migrations ?? MIGRATIONS
  const targetVersion = migrations[migrations.length - 1].version
  const dataDir = resolveDataDir(options.dataDir)
  const dbPath = databasePath(dataDir)

  const steps: string[] = []
  const lock = acquireLock(dataDir, { staleMs: options.staleMs, now: now() })
  steps.push('acquire-lock')

  let db: DatabaseSync | null = null
  try {
    db = openDatabase({ path: dbPath })
    steps.push('open-db')

    const fromVersion = userVersion(db)
    let backupReport: BackupReport | null = null

    if (fromVersion > 0 && fromVersion < targetVersion && options.backupBeforeMigrate !== false) {
      backupReport = createBackup(db, {
        dir: backupDir(dataDir),
        keep: options.backupKeep,
        now: new Date(now()),
      })
      steps.push(`backup-before-migrate:${backupReport.name}`)
    } else if (fromVersion === 0) {
      steps.push('skip-backup-fresh-db')
    } else {
      steps.push('skip-backup-no-upgrade')
    }

    const migrationReport = migrate(db, {
      migrations,
      verifyBaseline: options.verifyBaseline ?? migrations === MIGRATIONS,
    })
    steps.push(
      migrationReport.migrated
        ? `migrate:${migrationReport.applied.map((item) => item.version).join(',')}`
        : 'migrate:noop',
    )

    ensureMetaDefaults(db, { now: now() })
    steps.push('seed-meta')

    const seed = assertBaselineSeed(db)
    steps.push('assert-baseline-seed')

    const runtimeEpoch = bumpRuntimeEpoch(db)
    steps.push(`bump-runtime-epoch:${runtimeEpoch}`)

    // 报告里的 meta 必须是加了启动代次之后的快照（否则界面显示 epoch 0）。
    const finalMeta = readMeta(db)

    const report: BootstrapReport = {
      dataDir,
      dbPath,
      lockPath: lockPath(dataDir),
      fromVersion,
      toVersion: migrationReport.toVersion,
      runtimeEpoch,
      backup: toBackupSummary(backupReport),
      migration: {
        migrated: migrationReport.migrated,
        applied: migrationReport.applied,
        checkedBaseline: migrationReport.checkedBaseline,
      },
      seed,
      meta: finalMeta,
      steps,
    }

    let closed = false
    const runtime: StoreRuntime = {
      dataDir,
      dbPath,
      db,
      lock,
      report,
      get closed() {
        return closed
      },
      close(): void {
        if (closed) return
        closed = true
        try {
          closeDatabase(db as DatabaseSync)
        } finally {
          lock.release()
        }
      },
    }
    return runtime
  } catch (error) {
    if (db) {
      try {
        closeDatabase(db)
      } catch {
        // 关闭失败不能盖住原始错误。
      }
    }
    lock.release()
    throw error
  }
}

export interface ReadOnlyStore {
  dataDir: string
  db: DatabaseSync
  userVersion: number
  close(): void
}

/**
 * 第二实例 / 运维查看：只读打开，不迁移、不写 runtime_epoch、不拿写锁。
 * 版本必须与代码完全一致，否则拒绝（旧代码不许读新库，新代码也不假装能处理旧库）。
 */
export function openReadOnlyStore(dataDir?: string, expectedVersion: number = TARGET_VERSION): ReadOnlyStore {
  const resolved = resolveDataDir(dataDir)
  const db = openDatabase({ path: databasePath(resolved), readOnly: true })
  const version = userVersion(db)
  if (version > expectedVersion) {
    closeDatabase(db)
    throw new SchemaTooNewError(version, expectedVersion)
  }
  if (version < expectedVersion) {
    closeDatabase(db)
    throw new StoreError(
      'SCHEMA_OUTDATED',
      `只读实例遇到旧版本库 ${version} < ${expectedVersion}；请先用可写实例完成迁移`,
    )
  }
  let closed = false
  return {
    dataDir: resolved,
    db,
    userVersion: version,
    close(): void {
      if (closed) return
      closed = true
      closeDatabase(db)
    },
  }
}

/** 基线表数量，供诊断页显示「41 张 P1 表是否齐」。 */
export const P1_TABLE_COUNT = P1_SCHEMA_META.tables
