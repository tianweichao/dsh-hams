/**
 * node:sqlite 的唯一封装点。
 *
 * 约定（来自实测）：
 * - 连接参数固定 WAL + foreign_keys=ON + busy_timeout，由本文件统一设置，别处不再重复；
 * - 写事务一律 BEGIN IMMEDIATE，禁止嵌套；
 * - 本版运行时的 DatabaseSync 没有 backup()，备份走 VACUUM INTO（见 backup.ts）。
 *
 * 这一层只碰数据库，不解析宿主对象、不读 $DSH_HOME/sessions/。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const DB_FILENAME = 'hams.db'
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export interface OpenDatabaseOptions {
  /** 数据库文件的绝对路径。 */
  path: string
  /** 只读打开：第二实例与运维查看用；不建目录、不设 WAL。 */
  readOnly?: boolean
  busyTimeoutMs?: number
}

export class StoreError extends Error {
  code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.name = 'StoreError'
  }
}

/**
 * 数据目录解析：显式传入 > $DSH_HOME/hams > ~/.dsh/hams。
 * 只做路径计算，不创建目录——创建发生在 openDatabase 的可写分支。
 */
export function resolveDataDir(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit && explicit.trim()) return path.resolve(explicit)
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(path.resolve(dshHome), 'hams')
}

export function databasePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), DB_FILENAME)
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const readOnly = options.readOnly === true
  if (!readOnly) mkdirSync(path.dirname(options.path), { recursive: true })

  const db = new DatabaseSync(options.path, { readOnly })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`)

  if (!readOnly) {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string }
    if (String(mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
      db.close()
      throw new StoreError('WAL_UNAVAILABLE', `无法把 journal_mode 切到 WAL（当前 ${mode?.journal_mode}）`)
    }
    // 业务库按会计口径保守设置：崩溃后最后一次 tick 可以重跑，但不能丢已提交事务。
    db.exec('PRAGMA synchronous = FULL')
  }
  return db
}

/** 当前事务状态以 node:sqlite 的 isTransaction 为准，不自己记账。 */
export function isInTransaction(db: DatabaseSync): boolean {
  return db.isTransaction === true
}

export function beginImmediate(db: DatabaseSync): void {
  if (isInTransaction(db)) {
    throw new StoreError('NESTED_TRANSACTION', 'BEGIN IMMEDIATE 不允许嵌套')
  }
  db.exec('BEGIN IMMEDIATE')
}

export function commit(db: DatabaseSync): void {
  db.exec('COMMIT')
}

export function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 事务已经被 SQLite 自己回滚（例如语句级错误）时，这里无事可做。
  }
}

/** 同步事务包装：回调抛错即回滚，返回值原样带回。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  beginImmediate(db)
  try {
    const result = fn()
    commit(db)
    return result
  } catch (error) {
    rollbackQuietly(db)
    throw error
  }
}

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number }
  return Number(row?.user_version ?? 0)
}

export function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new StoreError('BAD_VERSION', `user_version 必须是非负整数，收到 ${version}`)
  }
  db.exec(`PRAGMA user_version = ${version}`)
}

export interface DbObject {
  type: 'table' | 'index' | 'trigger' | 'view'
  name: string
  table: string
  sql: string
}

/** 用户对象清单（排除 sqlite_ 内部表，例如 AUTOINCREMENT 生成的 sqlite_sequence）。 */
export function listObjects(db: DatabaseSync): DbObject[] {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name AS "table", COALESCE(sql, '') AS sql
         FROM sqlite_master
        WHERE type IN ('table','index','trigger','view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as DbObject[]
  return rows.map((row) => ({ ...row }))
}

export function tableNames(db: DatabaseSync): string[] {
  return listObjects(db)
    .filter((object) => object.type === 'table')
    .map((object) => object.name)
}

/** 每张用户表的行数；备份校验与冒烟检查共用。 */
export function tableRowCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of tableNames(db)) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replaceAll('"', '""')}"`).get() as { c: number }
    counts[name] = Number(row.c)
  }
  return counts
}

/** 结构指纹：对象类型 + 名字 + 规范化 SQL 的哈希，用于「备份与源库结构一致」的判断。 */
export function schemaFingerprint(db: DatabaseSync): string {
  const parts = listObjects(db).map((object) => `${object.type}|${object.name}|${normalizeSql(object.sql)}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** 只折叠空白，不改写 SQL 文本——注释也是结构的一部分（保存了分期标记）。 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

export function objectByTypeAndName(db: DatabaseSync, type: string, name: string): DbObject | undefined {
  return listObjects(db).find((object) => object.type === type && object.name === name)
}

export function closeDatabase(db: DatabaseSync): void {
  if (isInTransaction(db)) rollbackQuietly(db)
  db.close()
}
