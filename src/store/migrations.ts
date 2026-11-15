/**
 * 迁移框架：`PRAGMA user_version` 做版本号，显式数组做迁移链。
 *
 * 规则（backend-design §8 / engineering-design §6.4）：
 * - 每步一个事务，DDL 与 `PRAGMA user_version = N` 同一事务提交，失败整体回滚；
 * - `user_version` 高于代码支持上限时拒绝启动，绝不让旧代码碰新库（错误码 SCHEMA_TOO_NEW）；
 * - 迁移里不许调外部 IO、不许多语句拼业务逻辑，只放 DDL 与必要的基线种子。
 *
 * v1 的 DDL 由 `scripts/split-schema.mjs` 从 docs/schema-2026-11-14.sql 生成：
 * 只取 [P1] 的 41 张表 / 30 索引 / 31 触发器，以及系统主体与 36 条状态转换两条种子。
 */
import type { DatabaseSync } from 'node:sqlite'
import { PROJECTS_SCHEMA_SQL, PROJECTS_SCHEMA_META } from './schema/003_projects.sql.ts'
import { TEAM_SCHEMA_SQL, TEAM_SCHEMA_META } from './schema/004_team.sql.ts'
import { TARGET_CHECK_SCHEMA_SQL, TARGET_CHECK_SCHEMA_META } from './schema/005_target_check.sql.ts'
import { TARGET_FLOW_SCHEMA_SQL, TARGET_FLOW_SCHEMA_META } from './schema/006_target_flow.sql.ts'
import { PROJECT_DELETE_SCHEMA_SQL, PROJECT_DELETE_SCHEMA_META } from './schema/007_project_delete.sql.ts'
import { MEMORY_SCHEMA_SQL, MEMORY_SCHEMA_META } from './schema/008_memory.sql.ts'
import { P1_SCHEMA_SQL, P1_SCHEMA_META } from './schema/001_p1.sql.ts'
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_META } from './schema/002_knowledge.sql.ts'
import {
  listObjects,
  setUserVersion,
  tableNames,
  transaction,
  userVersion,
  StoreError,
} from './db.ts'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'p1-baseline', sql: P1_SCHEMA_SQL },
  // v2：知识的四张表（kb_table / kb_doc / kb_skill / kb_skill_version）。
  // 从权威 DDL 的 [P2] 知识子集生成，不手抄；界面「知识」屏需要真实落库才能接版本与发布。
  { version: 2, name: 'knowledge', sql: KNOWLEDGE_SCHEMA_SQL },
  { version: 3, name: 'project-lifecycle', sql: PROJECTS_SCHEMA_SQL },
  // v4：项目群团队（参与者 / 合并消息 / 会话游标）+ 临时 bot 的归属列。
  { version: 4, name: 'project-team', sql: TEAM_SCHEMA_SQL },
  // v5：阶段目标的检验提交记录（项目经理提交结果 + 报告链接）。
  { version: 5, name: 'target-check', sql: TARGET_CHECK_SCHEMA_SQL },
  // v6：目标详情字段 + 检验提交的审批字段（提交检验走审批，不再直接生成结果）。
  { version: 6, name: 'target-flow', sql: TARGET_FLOW_SCHEMA_SQL },
  // v7：归档项目的「删除」标记（软删；工作项解绑保留，审计与证据不动）。
  { version: 7, name: 'project-delete', sql: PROJECT_DELETE_SCHEMA_SQL },
  // v8：项目记忆（自动/手工/工具收集）+ 能力类记忆同步给 bot。
  { version: 8, name: 'project-memory', sql: MEMORY_SCHEMA_SQL },
])

export const TARGET_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version

export { P1_SCHEMA_META, P1_SCHEMA_SQL, KNOWLEDGE_SCHEMA_META, KNOWLEDGE_SCHEMA_SQL, PROJECTS_SCHEMA_META, PROJECTS_SCHEMA_SQL, TEAM_SCHEMA_META, TEAM_SCHEMA_SQL, TARGET_CHECK_SCHEMA_META, TARGET_CHECK_SCHEMA_SQL, TARGET_FLOW_SCHEMA_META, TARGET_FLOW_SCHEMA_SQL, PROJECT_DELETE_SCHEMA_META, PROJECT_DELETE_SCHEMA_SQL, MEMORY_SCHEMA_META, MEMORY_SCHEMA_SQL }

export class SchemaTooNewError extends StoreError {
  found: number
  supported: number

  constructor(found: number, supported: number) {
    super(
      'SCHEMA_TOO_NEW',
      `数据库版本 ${found} 高于代码支持的上限 ${supported}；拒绝启动，避免旧代码改坏新库`,
    )
    this.found = found
    this.supported = supported
  }
}

export class SchemaIncompleteError extends StoreError {
  missing: string[]

  constructor(missing: string[]) {
    super('SCHEMA_INCOMPLETE', `user_version 已是当前版本，但缺少基线表：${missing.join(', ')}`)
    this.missing = missing
  }
}

export interface MigrateOptions {
  migrations?: readonly Migration[]
  /** 默认 true：迁移链与内置链一致且无待执行项时，校验 P1 基线表是否齐全。 */
  verifyBaseline?: boolean
}

export interface MigrateReport {
  fromVersion: number
  toVersion: number
  applied: { version: number; name: string }[]
  migrated: boolean
  checkedBaseline: boolean
}

function tablesUpTo(version: number): string[] {
  const tables = [...P1_SCHEMA_META.tableNames]
  if (version >= 2) tables.push(...KNOWLEDGE_SCHEMA_META.tableNames)
  if (version >= 3) tables.push(...PROJECTS_SCHEMA_META.tableNames)
  if (version >= 4) tables.push(...TEAM_SCHEMA_META.tableNames)
  if (version >= 5) tables.push(...TARGET_CHECK_SCHEMA_META.tableNames)
  if (version >= 6) tables.push(...TARGET_FLOW_SCHEMA_META.tableNames)
  return tables
}

export function validateChain(migrations: readonly Migration[]): void {
  if (migrations.length === 0) throw new StoreError('BAD_MIGRATIONS', '迁移链为空')
  let expected = 1
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new StoreError(
        'BAD_MIGRATIONS',
        `迁移链必须从 1 连续递增：期望 ${expected}，收到 ${migration.version}（${migration.name}）`,
      )
    }
    if (!migration.sql.trim()) throw new StoreError('BAD_MIGRATIONS', `迁移 ${migration.version} 的 SQL 为空`)
    expected += 1
  }
}

export function pendingMigrations(
  current: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  return migrations.filter((migration) => migration.version > current)
}

/**
 * 在给定连接上把库迁移到链尾版本。调用方负责先拿单写者锁（见 lock.ts / bootstrap.ts）。
 * 返回报告；没有待执行项时是幂等 no-op，并做一次基线完整性校验。
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateReport {
  const migrations = options.migrations ?? MIGRATIONS
  const useBuiltin = migrations === MIGRATIONS
  const verifyBaseline = options.verifyBaseline ?? useBuiltin

  validateChain(migrations)
  const target = migrations[migrations.length - 1].version
  const from = userVersion(db)

  if (from > target) throw new SchemaTooNewError(from, target)

  const pending = pendingMigrations(from, migrations)
  const applied: { version: number; name: string }[] = []

  // 已有库先核对「它声称的版本」对应的表是否齐全：user_version 说有 v1、实际表没了，
  // 应该报 SCHEMA_INCOMPLETE，而不是硬在空库上继续加列/加表。
  if (from >= 1 && verifyBaseline && useBuiltin) {
    const expected = tablesUpTo(from)
    const present = new Set(tableNames(db))
    const missing = expected.filter((name) => !present.has(name))
    if (missing.length) throw new SchemaIncompleteError(missing)
  }

  for (const migration of pending) {
    transaction(db, () => {
      db.exec(migration.sql)
      setUserVersion(db, migration.version)
      // hams_meta 在 v1 才存在；镜像一份便于诊断页只查表不查 pragma。
      if (tableNames(db).includes('hams_meta')) {
        db.prepare(
          `INSERT INTO hams_meta (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(String(migration.version))
      }
    })
    applied.push({ version: migration.version, name: migration.name })
  }

  let checkedBaseline = false
  if (verifyBaseline && useBuiltin) {
    const present = new Set(tableNames(db))
    const missing = tablesUpTo(target).filter((name) => !present.has(name))
    if (missing.length) throw new SchemaIncompleteError([...missing])
    checkedBaseline = true
  }

  return {
    fromVersion: from,
    toVersion: userVersion(db),
    applied,
    migrated: applied.length > 0,
    checkedBaseline,
  }
}

export interface BaselineSummary {
  userVersion: number
  tables: number
  indexes: number
  triggers: number
  systemMember: boolean
  transitions: number
}

/** 冒烟与测试共用的基线摘要，用于一眼判断「这个库是不是已经按 v1 建好」。 */
export function baselineSummary(db: DatabaseSync): BaselineSummary {
  const objects = listObjects(db)
  const systemMember =
    (db.prepare("SELECT COUNT(*) AS c FROM member WHERE id = 'system' AND kind = 'system'").get() as {
      c: number
    }).c === 1
  const transitions = (db.prepare('SELECT COUNT(*) AS c FROM work_item_transition').get() as { c: number }).c
  return {
    userVersion: userVersion(db),
    tables: objects.filter((object) => object.type === 'table').length,
    indexes: objects.filter((object) => object.type === 'index').length,
    triggers: objects.filter((object) => object.type === 'trigger').length,
    systemMember,
    transitions: Number(transitions),
  }
}
