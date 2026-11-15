import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import {
  bootstrapStore,
  openReadOnlyStore,
  type BootstrapOptions,
} from '../../src/store/bootstrap.ts'
import { MIGRATIONS, type Migration } from '../../src/store/migrations.ts'
import { databasePath, userVersion } from '../../src/store/db.ts'
import { lockPath, readLock } from '../../src/store/lock.ts'
import { createSandbox, sandboxPath } from './helpers.ts'

const T0 = 1_800_000_000_000

function boot(root: string, options: Partial<BootstrapOptions> = {}) {
  return bootstrapStore({
    dataDir: sandboxPath(root, 'data'),
    now: () => T0,
    ...options,
  })
}

// 自定义一版迁移，用来测「已有库升级」路径：真实链到 v9 就停了。
const V5: Migration = { version: 10, name: 'p10-test', sql: 'CREATE TABLE kb_test (id TEXT PRIMARY KEY);' }
const UPGRADE_CHAIN: Migration[] = [...MIGRATIONS, V5]

test('t01 空目录首次启动：拿锁 → 建库到 v9 → 种子 → 启动代次 1', () => {
  const root = createSandbox(test)
  const runtime = boot(root)

  assert.deepEqual(runtime.report.steps, [
    'acquire-lock',
    'open-db',
    'skip-backup-fresh-db',
    'migrate:1,2,3,4,5,6,7,8,9',
    'seed-meta',
    'assert-baseline-seed',
    'bump-runtime-epoch:1',
  ])
  assert.equal(runtime.report.fromVersion, 0)
  assert.equal(runtime.report.toVersion, 9)
  assert.equal(runtime.report.runtimeEpoch, 1)
  assert.equal(runtime.report.backup, null, '空库迁移不制造无意义的备份')
  assert.equal(runtime.report.seed.tables, 58)
  assert.equal(runtime.report.seed.transitions, 36)
  assert.equal(runtime.report.seed.systemMember, true)
  assert.equal(runtime.report.meta.runtime_epoch, '1')

  assert.ok(existsSync(databasePath(runtime.dataDir)))
  assert.ok(existsSync(lockPath(runtime.dataDir)), '运行期间应持有写锁')
  assert.ok(!existsSync(path.join(runtime.dataDir, 'sessions')), '业务数据目录不得出现 sessions')

  runtime.close()
  assert.equal(runtime.closed, true)
  assert.equal(readLock(runtime.dataDir), null, '关闭后必须释放锁')
  runtime.close() // 幂等
})

test('t02 二次启动：不迁移、不动数据、启动代次 +1', () => {
  const root = createSandbox(test)
  const first = boot(root)
  first.close()

  const second = boot(root, { now: () => T0 + 1_000 })
  assert.equal(second.report.fromVersion, 9)
  assert.equal(second.report.migration.migrated, false)
  assert.deepEqual(second.report.steps, [
    'acquire-lock',
    'open-db',
    'skip-backup-no-upgrade',
    'migrate:noop',
    'seed-meta',
    'assert-baseline-seed',
    'bump-runtime-epoch:2',
  ])
  assert.equal(second.report.runtimeEpoch, 2)
  assert.equal(second.report.meta.runtime_epoch, '2')
  assert.equal(second.report.meta.bootstrapped_at, String(T0), '首次引导时间不能被重启覆盖')
  second.close()
})

test('t03 写锁被占用时第二个实例起不来（同进程明确自锁）', () => {
  const root = createSandbox(test)
  const runtime = boot(root)

  assert.throws(
    () => boot(root),
    (error: unknown) => (error as { code?: string }).code === 'LOCK_HELD_SELF',
  )
  runtime.close()
  const again = boot(root)
  again.close()
})

test('t04 版本升级：先做可校验的事前备份，再迁移', () => {
  const root = createSandbox(test)
  const v1 = boot(root)
  v1.close()

  const upgraded = boot(root, { migrations: UPGRADE_CHAIN, backupKeep: 3 })
  assert.equal(upgraded.report.fromVersion, 9)
  assert.equal(upgraded.report.toVersion, 10)
  assert.deepEqual(upgraded.report.migration.applied.map((item) => item.version), [10])
  assert.ok(upgraded.report.steps.includes('backup-before-migrate:' + upgraded.report.backup?.name))

  const backup = upgraded.report.backup
  assert.ok(backup, '升级前必须有备份')
  assert.equal(backup.tables, 58)

  const copy = new DatabaseSync(backup.path, { readOnly: true })
  assert.equal(userVersion(copy), 9, '备份必须是迁移前的版本')
  const copyTables = copy
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row: { name: string }) => row.name)
  assert.ok(!copyTables.includes('kb_test'), '备份里不应出现迁移后的新表')
  copy.close()

  assert.equal(userVersion(upgraded.db), 10)
  assert.equal(upgraded.report.meta.schema_version, '10', 'hams_meta 的 schema_version 要跟着迁移走')
  upgraded.close()
})

test('t05 备份失败就不迁移：宁可起不来也不越过备份', () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'data')
  const v1 = boot(root)
  v1.close()

  // 用一个同名普通文件占住 backups 目录，备份必然失败。
  writeFileSync(path.join(dataDir, 'backups'), 'not a directory\n')

  assert.throws(() => boot(root, { migrations: UPGRADE_CHAIN }), /EEXIST|ENOTDIR|not a directory/i)

  const reader = openReadOnlyStore(dataDir, 9)
  assert.equal(reader.userVersion, 9)
  const tables = reader.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row: { name: string }) => row.name)
  assert.ok(!tables.includes('kb_test'), '迁移不能发生')
  reader.close()
  assert.equal(readLock(dataDir), null, '失败路径也必须放锁')
})

test('t06 只读实例：版本不符拒绝打开，且写不进去', () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'data')

  assert.throws(() => openReadOnlyStore(dataDir, 9), /unable to open|Cannot open|SQLITE_CANTOPEN/i)

  const runtime = boot(root)
  runtime.close()

  const reader = openReadOnlyStore(dataDir, 9)
  assert.equal(reader.userVersion, 9)
  assert.throws(() => reader.db.prepare("INSERT INTO hams_meta (key, value) VALUES ('x','1')").run())
  reader.close()
})

test('t07 只读实例遇到更高版本库：报 SCHEMA_TOO_NEW', () => {
  const root = createSandbox(test)
  const runtime = boot(root)
  runtime.db.exec('PRAGMA user_version = 99')
  runtime.close()

  assert.throws(
    () => openReadOnlyStore(sandboxPath(root, 'data'), 9),
    (error: unknown) => (error as { code?: string }).code === 'SCHEMA_TOO_NEW',
  )
})

test('t08 启动失败不会留下锁：拿锁后开库失败（路径不可用）', () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'data')
  writeFileSync(dataDir, 'data 是文件，不是目录\n')

  assert.throws(() => boot(root), /EEXIST|ENOTDIR|not a directory|无法/i)
  assert.equal(readLock(dataDir), null)
})
