import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrapStore } from '../../src/store/bootstrap.ts'
import { databasePath, resolveDataDir } from '../../src/store/db.ts'
import { createSandbox, isInsideSandbox, sandboxPath } from './helpers.ts'

test('t01 数据目录解析：显式参数 > $DSH_HOME/hams > ~/.dsh/hams', () => {
  assert.equal(resolveDataDir(undefined, { DSH_HOME: '/tmp/fake-dsh-home' }), '/tmp/fake-dsh-home/hams')
  assert.equal(resolveDataDir('/tmp/explicit', { DSH_HOME: '/tmp/fake-dsh-home' }), '/tmp/explicit')
  assert.equal(resolveDataDir('relative-dir', { DSH_HOME: '/tmp/fake-dsh-home' }), path.resolve('relative-dir'))
  assert.equal(resolveDataDir(undefined, {}), path.join(homedir(), '.dsh', 'hams'))
  assert.equal(resolveDataDir('  ', { DSH_HOME: '/tmp/x' }), '/tmp/x/hams', '空白参数应按未传处理')
  assert.equal(databasePath('/tmp/x'), '/tmp/x/hams.db')
})

test('t02 启动后数据目录里只有 hams.db：不往别处撒文件、不碰 sessions', () => {
  const root = createSandbox(test)
  const dataDir = sandboxPath(root, 'data')

  const runtime = bootstrapStore({ dataDir, now: () => 1_800_000_000_000 })
  runtime.close()

  const entries = readdirSync(dataDir).sort()
  assert.deepEqual(entries, ['hams.db'])
  assert.ok(!entries.includes('sessions'))
  assert.ok(!entries.includes('hams.lock'), '正常关闭后不留锁文件')
  assert.equal(readdirSync(root).sort().join(','), 'data')
})

test('t03 测试沙箱只允许清理自己登记的目录', () => {
  const root = createSandbox(test)
  assert.equal(isInsideSandbox(root), true)
  assert.equal(isInsideSandbox(path.join(root, 'nested', 'file.txt')), true)
  assert.equal(isInsideSandbox(tmpdir()), false)
  assert.equal(isInsideSandbox(homedir()), false)
  assert.equal(isInsideSandbox(path.join(root, '..')), false)

  assert.throws(() => sandboxPath(root, '..', 'outside'), /路径逃出沙箱/)
})
