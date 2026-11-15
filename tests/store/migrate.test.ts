import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  MIGRATIONS,
  SchemaIncompleteError,
  SchemaTooNewError,
  TARGET_VERSION,
  baselineSummary,
  migrate,
  type Migration,
} from '../../src/store/migrations.ts'
import { setUserVersion, tableNames, userVersion } from '../../src/store/db.ts'

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

test('t01 空库迁移到 v9：58 表（41 P1 + 4 知识 + 7 生命周期 + 3 项目群团队 + 1 目标检验 + 2 项目记忆 + v9 加列）/ 36 条转换 / 唯一系统主体', () => {
  const db = memoryDb()
  const report = migrate(db)

  assert.equal(report.fromVersion, 0)
  assert.equal(report.toVersion, TARGET_VERSION)
  assert.equal(report.migrated, true)
  assert.deepEqual(report.applied, [
    { version: 1, name: 'p1-baseline' },
    { version: 2, name: 'knowledge' },
    { version: 3, name: 'project-lifecycle' },
    { version: 4, name: 'project-team' },
    { version: 5, name: 'target-check' },
    { version: 6, name: 'target-flow' },
    { version: 7, name: 'project-delete' },
    { version: 8, name: 'project-memory' },
    { version: 9, name: 'bot-prompt' },
  ])
  assert.equal(report.checkedBaseline, true)
  assert.equal(userVersion(db), TARGET_VERSION)

  const summary = baselineSummary(db)
  assert.deepEqual(summary, {
    userVersion: TARGET_VERSION,
    tables: 58,
    indexes: 35,
    triggers: 32,
    systemMember: true,
    transitions: 36,
  })
  db.close()
})

test('t01b v9 迁移不去改 member_version 既有行（IMMUTABLE 触发器）', () => {
  const db = memoryDb()
  migrate(db, { migrations: MIGRATIONS.slice(0, 8) })
  db.prepare("INSERT INTO member (id, kind, name, role, current_version, created_at, updated_at) VALUES ('h1','human','迁移负责人','coordinator',0,1,1)").run()
  db.prepare("INSERT INTO member_version (id, member_id, version, agent_preset, model, memory_scope_json, prompt_digest, change_class, published_by, published_at) VALUES ('mv1','h1',1,'hams-bot','deepseek-chat','{}','d','major','h1',1)").run()

  const report = migrate(db)
  assert.deepEqual(report.applied.map((item) => item.version), [9])
  const row = db.prepare("SELECT prompt FROM member_version WHERE id='mv1'").get() as { prompt: string }
  assert.equal(row.prompt, '', '既有版本保持空白提示词，迁移不能 UPDATE 它')
  assert.equal(userVersion(db), TARGET_VERSION)
  db.close()
})

test('t02 重复迁移是 no-op，种子不重复、计数不漂移', () => {
  const db = memoryDb()
  migrate(db)
  const second = migrate(db)

  assert.equal(second.migrated, false)
  assert.deepEqual(second.applied, [])
  assert.equal(second.fromVersion, TARGET_VERSION)
  assert.equal(second.toVersion, TARGET_VERSION)

  const systemRows = db.prepare("SELECT COUNT(*) AS c FROM member WHERE kind = 'system'").get() as { c: number }
  const transitions = db.prepare('SELECT COUNT(*) AS c FROM work_item_transition').get() as { c: number }
  assert.equal(Number(systemRows.c), 1)
  assert.equal(Number(transitions.c), 36)
  assert.equal(tableNames(db).length, 58)
  db.close()
})

test('t03 库版本高于代码支持上限：拒绝启动，且不动库', () => {
  const db = memoryDb()
  setUserVersion(db, 99)

  assert.throws(
    () => migrate(db),
    (error: unknown) => {
      assert.ok(error instanceof SchemaTooNewError)
      assert.equal((error as SchemaTooNewError).code, 'SCHEMA_TOO_NEW')
      assert.equal((error as SchemaTooNewError).found, 99)
      assert.equal((error as SchemaTooNewError).supported, TARGET_VERSION)
      return true
    },
  )
  assert.equal(userVersion(db), 99)
  assert.deepEqual(tableNames(db), [])
  db.close()
})

test('t04 迁移中途失败整体回滚：user_version 与表都回到迁移前', () => {
  const db = memoryDb()
  const broken: Migration[] = [
    {
      version: 1,
      name: 'broken',
      sql: 'CREATE TABLE first_ok (x INTEGER);\nCREATE TABLE second_ok (y TEXT);\nTHIS IS NOT SQL;',
    },
  ]

  assert.throws(() => migrate(db, { migrations: broken }), /syntax error|near "THIS"/i)
  assert.equal(userVersion(db), 0)
  assert.deepEqual(tableNames(db), [])
  db.close()
})

test('t05 迁移链必须从 1 连续递增', () => {
  const db = memoryDb()
  assert.throws(
    () => migrate(db, { migrations: [{ version: 2, name: 'skips-v1', sql: 'CREATE TABLE x (y);' }] }),
    (error: unknown) => (error as { code?: string }).code === 'BAD_MIGRATIONS',
  )
  assert.throws(
    () => migrate(db, { migrations: [] }),
    (error: unknown) => (error as { code?: string }).code === 'BAD_MIGRATIONS',
  )
  db.close()
})

test('t06 增量迁移：v2 只加新表，既有数据不动', () => {
  const db = memoryDb()
  const chain: Migration[] = [
    MIGRATIONS[0],
    { version: 2, name: 'phase-2-test', sql: 'CREATE TABLE pending_p2 (id TEXT PRIMARY KEY);' },
  ]

  const first = migrate(db, { migrations: chain })
  assert.equal(first.toVersion, 2)
  assert.deepEqual(
    first.applied.map((item) => item.version),
    [1, 2],
  )
  assert.equal(first.checkedBaseline, false)
  assert.ok(tableNames(db).includes('pending_p2'))
  assert.equal(userVersion(db), 2)

  const second = migrate(db, { migrations: chain })
  assert.equal(second.migrated, false)
  assert.equal(second.toVersion, 2)
  db.close()
})

test('t07 user_version 已是当前版但基线表缺失：报 SCHEMA_INCOMPLETE', () => {
  const db = memoryDb()
  setUserVersion(db, 1)

  assert.throws(
    () => migrate(db),
    (error: unknown) => {
      assert.ok(error instanceof SchemaIncompleteError)
      assert.equal((error as SchemaIncompleteError).code, 'SCHEMA_INCOMPLETE')
      assert.ok((error as SchemaIncompleteError).missing.includes('work_item'))
      assert.equal((error as SchemaIncompleteError).missing.length, 41)
      return true
    },
  )
  db.close()
})
