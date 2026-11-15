import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import {
  BACKUP_NAME_RE,
  BackupError,
  backupDir,
  createBackup,
  listBackups,
  pruneBackups,
  verifyBackup,
} from '../../src/store/backup.ts'
import { openDatabase } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { createSandbox, sandboxPath } from './helpers.ts'

function makeStore(root: string): { db: DatabaseSync; dir: string } {
  const db = openDatabase({ path: sandboxPath(root, 'source.db') })
  migrate(db)
  return { db, dir: backupDir(root) }
}

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0)

test('t01 备份产出可通过四项校验的副本，且能只读重开', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)

  const report = createBackup(db, { dir, now: new Date(T0) })
  assert.match(report.name, BACKUP_NAME_RE)
  assert.equal(report.integrity, 'ok')
  assert.ok(report.bytes > 0)
  assert.equal(report.userVersion, 8)
  assert.equal(report.tables, 58)
  assert.equal(report.rows.work_item_transition, 36)
  assert.deepEqual(report.pruned, [])

  const verification = verifyBackup(db, report.path)
  assert.equal(verification.integrity, 'ok')
  assert.equal(verification.rowsMatch, true)
  assert.equal(verification.schemaMatch, true)
  assert.equal(verification.userVersion, verification.sourceUserVersion)
  assert.deepEqual(verification.mismatches, [])

  const copy = new DatabaseSync(report.path, { readOnly: true })
  const transitions = copy.prepare('SELECT COUNT(*) AS c FROM work_item_transition').get() as { c: number }
  assert.equal(Number(transitions.c), 36)
  copy.close()
  db.close()
})

test('t02 保留策略：默认保留最新 3 份，非备份文件不动', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)

  const names: string[] = []
  for (let i = 0; i < 4; i += 1) {
    names.push(createBackup(db, { dir, now: new Date(T0 + i * 60_000) }).name)
  }
  writeFileSync(path.join(dir, 'notes.txt'), '不是备份，不该被删\n')
  const report = createBackup(db, { dir, keep: 3, now: new Date(T0 + 10 * 60_000) })
  assert.deepEqual(report.pruned, [names[1]], '四份里应当只淘汰最旧的一份')
  assert.equal(listBackups(dir).length, 3)
  assert.ok(existsSync(path.join(dir, 'notes.txt')), '保留策略只认 hams-*.db')
  assert.ok(listBackups(dir).every((file) => BACKUP_NAME_RE.test(file.name)))
  db.close()
})

test('t03 同一秒连续备份：文件名自动加序号，不互相覆盖', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)

  const first = createBackup(db, { dir, keep: 5, now: new Date(T0) })
  const second = createBackup(db, { dir, keep: 5, now: new Date(T0) })
  assert.notEqual(first.name, second.name)
  assert.match(second.name, /-\d{2}\.db$/)
  assert.ok(existsSync(first.path) && existsSync(second.path))
  db.close()
})

test('t04 备份在事务内被拒绝', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)

  db.exec('BEGIN IMMEDIATE')
  assert.throws(
    () => createBackup(db, { dir }),
    (error: unknown) => (error as { code?: string }).code === 'BACKUP_IN_TRANSACTION',
  )
  db.exec('ROLLBACK')
  assert.equal(listBackups(dir).length, 0)
  db.close()
})

test('t05 行数不一致能被校验发现（不信任写入方）', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)
  const report = createBackup(db, { dir, now: new Date(T0) })

  db.prepare(
    "INSERT INTO member (id, kind, name, created_at, updated_at) VALUES ('h_x', 'human', '临时', 0, 0)",
  ).run()

  const verification = verifyBackup(db, report.path)
  assert.equal(verification.rowsMatch, false)
  assert.ok(verification.mismatches.some((item) => item.startsWith('member:')))
  db.close()
})

test('t06 keep 参数非法时直接拒绝，不删任何东西', () => {
  const root = createSandbox(test)
  const { db, dir } = makeStore(root)
  assert.throws(
    () => createBackup(db, { dir, keep: 0 }),
    (error: unknown) => (error as { code?: string }).code === 'BAD_KEEP' && error instanceof BackupError,
  )
  assert.equal(listBackups(dir).length, 0)
  db.close()
})

test('t07 prune 只处理 backups 目录里符合命名的普通文件', () => {
  const root = createSandbox(test)
  const dir = sandboxPath(root, 'backups')
  const { db } = makeStore(root)
  mkdirSync(dir, { recursive: true })
  for (const name of ['hams-20260101-000000-01.db', 'hams-20260102-000000-01.db', 'random.db', 'hams-bad.db']) {
    writeFileSync(path.join(dir, name), 'x')
  }
  const pruned = pruneBackups(dir, 1)
  assert.deepEqual(pruned, ['hams-20260101-000000-01.db'])
  assert.ok(existsSync(path.join(dir, 'random.db')))
  assert.ok(existsSync(path.join(dir, 'hams-bad.db')))
  db.close()
})
