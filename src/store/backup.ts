/**
 * 备份与校验。
 *
 * 实测结论：本版 DatabaseSync 没有 `db.backup`，
 * 因此备份 = `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO '<backups/...>'`，
 * 然后**必须重新打开副本**校验：integrity_check、user_version、结构指纹、每张表行数，
 * 三项全对才算成功。校验失败就删掉这一份候选文件（只删刚写出的那一个），不让坏备份混进保留集。
 *
 * 目录约定：$DSH_HOME/hams/backups/，默认保留最近 3 份（dsh-compat §7）。
 * 恢复是人工流程，不提供自动脚本。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  closeDatabase,
  isInTransaction,
  schemaFingerprint,
  tableRowCounts,
  tableNames,
  userVersion,
  StoreError,
} from './db.ts'

export const BACKUP_DIRNAME = 'backups'
export const BACKUP_NAME_RE = /^hams-\d{8}-\d{6}-\d{2}\.db$/
export const DEFAULT_KEEP = 3

export class BackupError extends StoreError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options)
    this.name = 'BackupError'
  }
}

export interface BackupFileInfo {
  name: string
  path: string
  bytes: number
  mtimeMs: number
}

export interface CheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

export interface BackupReport {
  name: string
  path: string
  bytes: number
  checkpoint: CheckpointResult
  userVersion: number
  tables: number
  rows: Record<string, number>
  integrity: string
  schemaFingerprint: string
  pruned: string[]
}

export interface CreateBackupOptions {
  /** 备份目录（通常是 <dataDir>/backups）。 */
  dir: string
  keep?: number
  now?: Date
}

export function backupDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), BACKUP_DIRNAME)
}

function stamp(now: Date): string {
  const iso = now.toISOString() // 2026-11-14T09:05:00.000Z
  const date = iso.slice(0, 10).replaceAll('-', '')
  const time = iso.slice(11, 19).replaceAll(':', '')
  return `${date}-${time}`
}

function pickName(dir: string, now: Date): string {
  // 序号永远带两位，既解决同秒碰撞，又保证文件名按字典序等于按生成顺序：
  // hams-20261114-091048-01.db < ...-02.db < hams-20261114-091049-01.db
  const base = `hams-${stamp(now)}`
  let seq = 1
  while (existsSync(path.join(dir, `${base}-${String(seq).padStart(2, '0')}.db`))) seq += 1
  return `${base}-${String(seq).padStart(2, '0')}.db`
}

export function listBackups(dir: string): BackupFileInfo[] {
  const resolved = path.resolve(dir)
  if (!existsSync(resolved)) return []
  const files: BackupFileInfo[] = []
  for (const name of readdirSync(resolved)) {
    if (!BACKUP_NAME_RE.test(name)) continue
    const full = path.join(resolved, name)
    const stat = statSync(full)
    if (!stat.isFile()) continue
    files.push({ name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs })
  }
  // 文件名里的时间戳可排序，等价于按生成时间排序。
  files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return files
}

export function checkpoint(db: DatabaseSync, mode: 'PASSIVE' | 'TRUNCATE' = 'TRUNCATE'): CheckpointResult {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as CheckpointResult
  return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) }
}

function rowCountsEqual(a: Record<string, number>, b: Record<string, number>): string[] {
  const mismatches: string[] = []
  for (const table of Object.keys(a)) {
    if (b[table] !== a[table]) mismatches.push(`${table}: ${a[table]} -> ${b[table] ?? 'missing'}`)
  }
  for (const table of Object.keys(b)) {
    if (!(table in a)) mismatches.push(`${table}: 副本多出该表`)
  }
  return mismatches
}

export interface VerifyReport {
  path: string
  integrity: string
  userVersion: number
  sourceUserVersion: number
  tables: number
  rowsMatch: boolean
  schemaMatch: boolean
  mismatches: string[]
}

/** 重新打开副本做四项核对；它不信任写入方，也不复用源连接。 */
export function verifyBackup(sourceDb: DatabaseSync, backupPath: string): VerifyReport {
  const copy = new DatabaseSync(backupPath, { readOnly: true })
  try {
    const integrityRow = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    const integrity = String(integrityRow.integrity_check)
    const sourceRows = tableRowCounts(sourceDb)
    const copyRows = tableRowCounts(copy)
    const mismatches = rowCountsEqual(sourceRows, copyRows)
    const rowsMatch = mismatches.length === 0
    const schemaMatch = schemaFingerprint(sourceDb) === schemaFingerprint(copy)
    if (!schemaMatch) mismatches.push('结构指纹不一致')
    return {
      path: backupPath,
      integrity,
      userVersion: userVersion(copy),
      sourceUserVersion: userVersion(sourceDb),
      tables: tableNames(copy).length,
      rowsMatch,
      schemaMatch,
      mismatches,
    }
  } finally {
    closeDatabase(copy)
  }
}

/**
 * 生成一份可恢复的备份并校验。返回报告；校验失败时抛错且不留下坏文件。
 */
export function createBackup(db: DatabaseSync, options: CreateBackupOptions): BackupReport {
  const dir = path.resolve(options.dir)
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? new Date()

  if (isInTransaction(db)) {
    throw new BackupError('BACKUP_IN_TRANSACTION', '备份不能在事务内做：先提交当前写事务')
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupError('BAD_KEEP', `keep 必须是 ≥1 的整数，收到 ${keep}`)
  }

  mkdirSync(dir, { recursive: true })
  const checkpointResult = checkpoint(db, 'TRUNCATE')
  const name = pickName(dir, now)
  const target = path.join(dir, name)

  try {
    db.prepare('VACUUM INTO ?').run(target)
  } catch (error) {
    if (existsSync(target)) unlinkSync(target)
    throw new BackupError('BACKUP_FAILED', `VACUUM INTO 失败：${(error as Error).message}`, { cause: error })
  }

  let verification: VerifyReport
  try {
    verification = verifyBackup(db, target)
  } catch (error) {
    unlinkSync(target)
    throw new BackupError('BACKUP_UNVERIFIED', `备份无法重新打开校验，已丢弃 ${name}`, { cause: error })
  }
  const ok =
    verification.integrity === 'ok' &&
    verification.rowsMatch &&
    verification.schemaMatch &&
    verification.userVersion === verification.sourceUserVersion
  if (!ok) {
    unlinkSync(target)
    throw new BackupError(
      'BACKUP_UNVERIFIED',
      `备份校验失败，已丢弃 ${name}：${verification.mismatches.join('; ') || `integrity=${verification.integrity}`}`,
    )
  }

  const stat = statSync(target)
  const pruned = pruneBackups(dir, keep)
  if (!existsSync(target)) {
    throw new BackupError('BACKUP_UNEXPECTEDLY_PRUNED', `保留策略误删了刚生成的备份：${target}`)
  }

  return {
    name,
    path: target,
    bytes: stat.size,
    checkpoint: checkpointResult,
    userVersion: verification.userVersion,
    tables: verification.tables,
    rows: tableRowCounts(db),
    integrity: verification.integrity,
    schemaFingerprint: schemaFingerprint(db),
    pruned,
  }
}

/** 按文件名（= 生成顺序）保留最新 keep 份；只删 backups/ 下符合命名规则的普通文件。 */
export function pruneBackups(dir: string, keep: number): string[] {
  const resolved = path.resolve(dir)
  const files = listBackups(resolved)
  const pruned: string[] = []
  files.forEach((file, index) => {
    if (index < keep) return
    if (path.dirname(file.path) !== resolved) return
    if (!BACKUP_NAME_RE.test(file.name)) return
    unlinkSync(file.path)
    pruned.push(file.name)
  })
  return pruned
}
