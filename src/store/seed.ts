/**
 * 种子与元数据。
 *
 * v1 的 DDL 已经带了两条基线种子：唯一的系统主体（member.id='system'）与 36 条状态转换
 * 白名单。本文件负责其余「必须有、但可以缺省补写」的元数据，原则只有一条：
 * **只补缺失，不覆盖已有值**——重启不能把 runtime_epoch 或工作区指针重置。
 *
 * 岗位能力矩阵属于业务待确认项（status §5），不在这里造数据。
 */
import type { DatabaseSync } from 'node:sqlite'
import { transaction, userVersion, StoreError } from './db.ts'

export const META_KEYS = [
  'schema_version',
  'runtime_epoch',
  'primary_workspace_id',
  'last_tick_at',
  'bootstrapped_at',
] as const

export type MetaKey = (typeof META_KEYS)[number]

export class SeedError extends StoreError {
  constructor(message: string, code = 'SEED_INVALID') {
    super(code, message)
    this.name = 'SeedError'
  }
}

export function readMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM hams_meta').all() as { key: string; value: string }[]
  const meta: Record<string, string> = {}
  for (const row of rows) meta[row.key] = row.value
  return meta
}

export interface SeedOptions {
  now?: number
}

/**
 * 补齐 hams_meta 的缺省键（幂等）。schema_version 永远与 PRAGMA user_version 对齐。
 */
export function ensureMetaDefaults(db: DatabaseSync, options: SeedOptions = {}): Record<string, string> {
  const now = options.now ?? Date.now()
  const defaults: Record<MetaKey, string> = {
    schema_version: String(userVersion(db)),
    runtime_epoch: '0',
    primary_workspace_id: '',
    last_tick_at: '0',
    bootstrapped_at: String(now),
  }

  return transaction(db, () => {
    const insert = db.prepare('INSERT OR IGNORE INTO hams_meta (key, value) VALUES (?, ?)')
    for (const key of META_KEYS) insert.run(key, defaults[key])
    const update = db.prepare('UPDATE hams_meta SET value = ? WHERE key = ?')
    update.run(String(userVersion(db)), 'schema_version')
    return readMeta(db)
  })
}

/** 宿主启动代次 +1：与业务代次无关，只用于识别上个进程留下的运行。 */
export function bumpRuntimeEpoch(db: DatabaseSync): number {
  return transaction(db, () => {
    const row = db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get() as
      | { value: string }
      | undefined
    const current = Number(row?.value ?? 0)
    const next = (Number.isFinite(current) && current >= 0 ? current : 0) + 1
    db.prepare(
      `INSERT INTO hams_meta (key, value) VALUES ('runtime_epoch', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(next))
    return next
  })
}

export function readRuntimeEpoch(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get() as
    | { value: string }
    | undefined
  return Number(row?.value ?? 0)
}

export interface SeedSummary {
  systemMember: boolean
  transitions: number
  tables: number
}

/**
 * 基线种子核对：系统主体必须唯一存在，状态白名单必须正好 36 条。
 * 迁移完成后立刻调用；不满足说明 DDL 被改坏，拒绝接流量。
 */
export function assertBaselineSeed(db: DatabaseSync): SeedSummary {
  const system = db
    .prepare("SELECT COUNT(*) AS c FROM member WHERE kind = 'system' AND id = 'system'")
    .get() as { c: number }
  const transitions = (db.prepare('SELECT COUNT(*) AS c FROM work_item_transition').get() as { c: number }).c
  const tables = (
    db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { c: number }
  ).c

  if (Number(system.c) !== 1) {
    throw new SeedError(`系统主体应唯一存在一行，实际 ${system.c} 行；拒绝接流量`)
  }
  if (Number(transitions) !== 36) {
    throw new SeedError(`状态转换白名单应有 36 条，实际 ${transitions} 条；拒绝接流量`)
  }
  return { systemMember: true, transitions: Number(transitions), tables: Number(tables) }
}
