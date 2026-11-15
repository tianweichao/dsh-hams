#!/usr/bin/env node
/**
 * 一键把空目录建到 user_version=1（或把已有库升级到当前版本）。
 *
 * 这是给人和运维用的入口，不是插件运行路径——插件走 src/store/bootstrap.ts。
 * 行为与插件启动严格一致：拿锁 → 开库 → （非空库先备份）→ 迁移 → 种子 → runtime_epoch +1 → 释放。
 *
 * 用法：
 *   node scripts/init-store.mjs --data-dir /tmp/hams-demo
 *   node scripts/init-store.mjs --data-dir "$DSH_HOME/hams" --json
 *
 * 安全：先打印解析后的绝对路径再动手；不递归删除任何东西；--data-dir 必填，
 * 避免「以为在测临时目录、实际写进真实 DSH_HOME」。
 */
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { bootstrapStore } from '../src/store/bootstrap.ts'

function parseArgs(argv) {
  const options = { dataDir: '', json: false, backupKeep: undefined, staleMs: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--json') options.json = true
    else if (flag === '--data-dir') options.dataDir = argv[++i] ?? ''
    else if (flag === '--backup-keep') options.backupKeep = Number(argv[++i])
    else if (flag === '--stale-ms') options.staleMs = Number(argv[++i])
    else throw new Error(`未知参数：${flag}`)
  }
  return options
}

function usage() {
  console.log(
    [
      '用法：node scripts/init-store.mjs --data-dir <目录> [--json] [--backup-keep 3] [--stale-ms 30000]',
      '',
      '把 HAMS 业务库初始化到当前迁移版本（v2 = 41 张 P1 表 + 知识 4 表 + 36 条状态转换 + 系统主体）。',
      '--data-dir 必填；数据目录下的 hams.db / hams.lock / backups/ 由本命令管理。',
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
    throw new Error('缺少 --data-dir：为避免误写真实 $DSH_HOME，必须显式指定目录')
  }

  const resolved = path.resolve(options.dataDir)
  console.log(`目标数据目录：${resolved}`)
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error(`目标路径已存在但不是目录：${resolved}`)
  }
  if (existsSync(path.join(resolved, 'hams.db'))) {
    console.log('检测到已有 hams.db：将按当前版本校验/升级，升级前自动备份')
  }

  const runtime = bootstrapStore({
    dataDir: resolved,
    backupKeep: options.backupKeep,
    staleMs: options.staleMs,
  })
  try {
    const report = runtime.report
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(`版本：${report.fromVersion} → ${report.toVersion}（${report.migration.migrated ? '已迁移' : '无需迁移'}）`)
      console.log(`表：${report.seed.tables} 张 · 状态转换：${report.seed.transitions} 条 · 系统主体：${report.seed.systemMember ? '存在' : '缺失'}`)
      console.log(`启动代次：${report.runtimeEpoch}`)
      if (report.backup) console.log(`升级前备份：${report.backup.path}（${report.backup.bytes} 字节，${report.backup.tables} 张表）`)
      console.log(`步骤：${report.steps.join(' → ')}`)
    }
  } finally {
    runtime.close()
  }
  console.log('完成，已释放写锁。')
}

try {
  main()
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
