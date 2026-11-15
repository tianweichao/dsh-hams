/**
 * 结构漂移守卫：代码里的 DDL 必须与 docs/schema-2026-11-14.sql 逐句一致。
 *
 * 四个独立判据，任何一条红就说明「文档与代码开始各说各话」：
 * 1. 生成物（v1 的 001_p1.*、v2 的 002_knowledge.*）与权威文件同步，权威文件 sha256 未变；
 * 2. 迁移建出的 45 张表及其索引、触发器，SQL 文本与权威 DDL 同名对象逐字相同（只折叠空白）；
 * 3. 权威 DDL 里没进迁移的 5 张表，只能是注释写着 [P2] 或 [壳] 的那些，不能有别的遗漏；
 * 4. 知识四张表必须来自权威 DDL 的 [P2] 知识子集，不得手写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from '../../scripts/split-schema.mjs'
import { PROJECTS_SCHEMA_META } from '../../src/store/schema/003_projects.sql.ts'
import { TEAM_SCHEMA_META } from '../../src/store/schema/004_team.sql.ts'
import { TARGET_CHECK_SCHEMA_META } from '../../src/store/schema/005_target_check.sql.ts'
import { MEMORY_SCHEMA_META } from '../../src/store/schema/008_memory.sql.ts'
import {
  KNOWLEDGE_SCHEMA_META,
  KNOWLEDGE_SCHEMA_SQL,
  P1_SCHEMA_META,
  P1_SCHEMA_SQL,
  migrate,
} from '../../src/store/migrations.ts'
import { listObjects, normalizeSql, tableNames } from '../../src/store/db.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const AUTHORITY_FILE = path.join(ROOT, 'docs', 'schema-2026-11-14.sql')
const P1_SQL_FILE = path.join(ROOT, 'src', 'store', 'schema', '001_p1.sql')
const P1_TS_FILE = path.join(ROOT, 'src', 'store', 'schema', '001_p1.sql.ts')
const KB_SQL_FILE = path.join(ROOT, 'src', 'store', 'schema', '002_knowledge.sql')
const KB_TS_FILE = path.join(ROOT, 'src', 'store', 'schema', '002_knowledge.sql.ts')

function objectMap(db: DatabaseSync): Map<string, string> {
  return new Map(listObjects(db).map((object) => [`${object.type}:${object.name}`, normalizeSql(object.sql)]))
}

test('t01 权威 DDL 未变，生成物与它同步（--check 等价）', () => {
  const authorityText = readFileSync(AUTHORITY_FILE, 'utf8')
  const sha256 = createHash('sha256').update(authorityText).digest('hex')
  assert.equal(sha256, P1_SCHEMA_META.authoritySha256, 'docs 里的权威 DDL 改过但没重新生成迁移 DDL')
  assert.equal(sha256, PROJECTS_SCHEMA_META.authoritySha256)
  assert.equal(sha256, KNOWLEDGE_SCHEMA_META.authoritySha256, 'v2 知识 DDL 记录的不是同一份权威文件')

  const built = build()
  assert.equal(readFileSync(P1_SQL_FILE, 'utf8'), built.sql, '001_p1.sql 不是最新生成物')
  assert.equal(readFileSync(P1_TS_FILE, 'utf8'), built.ts, '001_p1.sql.ts 不是最新生成物')
  assert.equal(readFileSync(KB_SQL_FILE, 'utf8'), built.sql2, '002_knowledge.sql 不是最新生成物')
  assert.equal(readFileSync(KB_TS_FILE, 'utf8'), built.ts2, '002_knowledge.sql.ts 不是最新生成物')
  assert.equal(P1_SCHEMA_SQL, built.sql, '迁移代码内嵌的 SQL 与生成物不一致')
  assert.equal(KNOWLEDGE_SCHEMA_SQL, built.sql2, 'v2 迁移内嵌的 SQL 与生成物不一致')
})

test('t02 v1 的每个对象都与权威 DDL 的同名对象逐字一致', () => {
  const authorityText = readFileSync(AUTHORITY_FILE, 'utf8')
  const full = new DatabaseSync(':memory:')
  full.exec('PRAGMA foreign_keys = ON')
  full.exec(authorityText)

  const p1 = new DatabaseSync(':memory:')
  p1.exec('PRAGMA foreign_keys = ON')
  migrate(p1)

  const fullObjects = objectMap(full)
  const p1Objects = objectMap(p1)
  assert.ok(p1Objects.size > 0)

  const handWrittenTables = new Set<string>([...TEAM_SCHEMA_META.tableNames, ...TARGET_CHECK_SCHEMA_META.tableNames, ...MEMORY_SCHEMA_META.tableNames])
  // 后加列会改写 sqlite_master 里的建表原文，逐字比较只对被改动前的列有意义。
  const alteredTables = new Set(['member', 'member_version', 'project', 'project_phase_target', 'project_phase_target_check'])
  const handWrittenIndexes = new Set(['idx_project_participant_active', 'idx_project_message_project', 'idx_phase_target_check_target', 'idx_project_memory_project', 'idx_bot_memory_member'])
  for (const [key, sql] of p1Objects) {
    const name = key.slice(key.indexOf(':') + 1)
    if (!fullObjects.has(key)) {
      // v4 起是手写增量（团队/群聊），权威 DDL 只覆盖 [P1]/[P2]；登记在允许清单里。
      const allowed = handWrittenTables.has(name) || (key.startsWith('index:') && handWrittenIndexes.has(name))
      assert.ok(allowed, `迁移里有权威 DDL 没有、也不在手写清单里的对象：${key}`)
      continue
    }
    if (alteredTables.has(name)) continue
    assert.equal(fullObjects.get(key), sql, `${key} 的 SQL 与权威 DDL 不一致`)
  }

  const fullTables = tableNames(full)
  assert.equal(fullTables.length, 57)
  assert.equal(tableNames(p1).length, 57 - 5 + TEAM_SCHEMA_META.tableNames.length + TARGET_CHECK_SCHEMA_META.tableNames.length + MEMORY_SCHEMA_META.tableNames.length)
  full.close()
  p1.close()
})

test('t03 没进迁移的 5 张表只能是 [P2] 或 [壳]', () => {
  const authorityText = readFileSync(AUTHORITY_FILE, 'utf8')
  const full = new DatabaseSync(':memory:')
  full.exec(authorityText)
  const p1 = new DatabaseSync(':memory:')
  migrate(p1)

  const p1Tables = new Set(tableNames(p1))
  const omitted = tableNames(full).filter((name) => !p1Tables.has(name))
  assert.equal(omitted.length, P1_SCHEMA_META.p2Tables + P1_SCHEMA_META.shellTables - KNOWLEDGE_SCHEMA_META.tables - PROJECTS_SCHEMA_META.tableNames.length)
  assert.equal(omitted.length, 5)

  for (const name of omitted) {
    const pattern = new RegExp(`CREATE TABLE\\s+${name}\\s*\\([^\\n]*\\[(P2|壳)\\]`)
    assert.match(authorityText, pattern, `${name} 没进 v1，但权威 DDL 标注的不是 [P2]/[壳]`)
  }

  const omittedTriggers = listObjects(full)
    .filter((object) => object.type === 'trigger')
    .filter((object) => !objectMap(p1).has(`trigger:${object.name}`))
    .map((object) => object.name)
  assert.deepEqual(omittedTriggers, [])
  full.close()
  p1.close()
})

test('t04 两版之间的基线种子完全一致（系统主体与 36 条转换）', () => {
  const authorityText = readFileSync(AUTHORITY_FILE, 'utf8')
  const full = new DatabaseSync(':memory:')
  full.exec(authorityText)
  const p1 = new DatabaseSync(':memory:')
  migrate(p1)

  const systemA = full.prepare("SELECT id, kind, name FROM member WHERE kind = 'system'").all()
  const systemB = p1.prepare("SELECT id, kind, name FROM member WHERE kind = 'system'").all()
  assert.deepEqual(systemB, systemA)

  const transitionsA = full
    .prepare('SELECT from_status, to_status, command FROM work_item_transition ORDER BY from_status, to_status')
    .all()
  const transitionsB = p1
    .prepare('SELECT from_status, to_status, command FROM work_item_transition ORDER BY from_status, to_status')
    .all()
  assert.deepEqual(transitionsB, transitionsA)
  assert.equal(transitionsB.length, 36)
  full.close()
  p1.close()
})

test('t05 生成物记录的分期清单与迁移建出的表集合一致', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const expected = [...P1_SCHEMA_META.tableNames, ...KNOWLEDGE_SCHEMA_META.tableNames, ...PROJECTS_SCHEMA_META.tableNames, ...TEAM_SCHEMA_META.tableNames, ...TARGET_CHECK_SCHEMA_META.tableNames, ...MEMORY_SCHEMA_META.tableNames].sort()
  assert.deepEqual([...tableNames(db)].sort(), expected)
  assert.equal(P1_SCHEMA_META.tables, 41)
  assert.equal(P1_SCHEMA_META.indexes, 30)
  assert.equal(P1_SCHEMA_META.triggers, 31)
  assert.equal(KNOWLEDGE_SCHEMA_META.tables, 4)
  db.close()
})

test('t06 v2 知识表逐个来自权威 DDL 的 [P2] 建表语句', () => {
  const authorityText = readFileSync(AUTHORITY_FILE, 'utf8')
  for (const name of KNOWLEDGE_SCHEMA_META.tableNames) {
    const pattern = new RegExp(`CREATE TABLE\\s+${name}\\s*\\([^\\n]*\\[P2\\]`)
    assert.match(authorityText, pattern, `${name} 不在权威 DDL 的 [P2] 里`)
  }
})
