#!/usr/bin/env node
/**
 * 手工做一份可校验的业务库备份（升级前的自动备份之外）。
 *
 * 与插件写者共享同一把锁：插件正在运行时这里会拿到 LOCK_HELD 并退出——
 * 这是刻意的，备份不该在写者活跃时凭猜测抢同一个库。
 *
 * 用法：
 *   node scripts/backup-store.mjs --data-dir "$DSH_HOME/hams"
 *   node scripts/backup-store.mjs --data-dir /tmp/hams-demo --keep 5 --json
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { acquireLock } from '../src/store/lock.ts'
import { closeDatabase, databasePath, openDatabase, resolveDataDir, userVersion } from '../src/store/db.ts'
import { backupDir, createBackup, listBackups } from '../src/store/backup.ts'

function parseArgs(argv) {
  const options = { dataDir: '', keep: undefined, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--json') options.json = true
    else if (flag === '--data-dir') options.dataDir = argv[++i] ?? ''
    else if (flag === '--keep') options.keep = Number(argv[++i])
    else throw new Error(`未知参数：${flag}`)
  }
  return options
}

function usage() {
  console.log(
    [
      '用法：node scripts/backup-store.mjs --data-dir <目录> [--keep 3] [--json]',
      '',
      '对已初始化的 HAMS 业务库做一次 checkpoint + VACUUM INTO，并重新打开校验。',
      '--data-dir 必填；插件正在运行时本命令会因写锁被占用而退出。',
    ].join('\n'),
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  if (!options.dataDir) {
    usage()
    throw new Error('缺少 --data-dir')
  }
  const dataDir = resolveDataDir(options.dataDir)
  console.log(`目标数据目录：${dataDir}`)
  if (!existsSync(databasePath(dataDir))) {
    throw new Error(`还没有业务库：${databasePath(dataDir)}；先跑 scripts/init-store.mjs`)
  }

  const lock = acquireLock(dataDir)
  let db
  try {
    db = openDatabase({ path: databasePath(dataDir) })
    if (userVersion(db) === 0) throw new Error('库存在但 user_version=0，可能是半初始化状态；先跑 init-store')
    const report = createBackup(db, { dir: backupDir(dataDir), keep: options.keep })
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(`已备份：${report.path}`)
      console.log(`  大小 ${report.bytes} 字节 · ${report.tables} 张表 · user_version=${report.userVersion} · integrity_check=${report.integrity}`)
      if (report.pruned.length) console.log(`  淘汰旧备份：${report.pruned.join(', ')}`)
      console.log(`  当前保留 ${listBackups(backupDir(dataDir)).length} 份`)
    }
  } finally {
    if (db) closeDatabase(db)
    lock.release()
  }
}

try {
  main()
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
