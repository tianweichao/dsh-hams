#!/usr/bin/env node
/**
 * 从权威 DDL（docs/schema-2026-11-14.sql）生成迁移用的 P1 子集。
 *
 * 为什么需要这一步：权威 DDL 一次写全 57 张表（P1 41 / P2 14 / 壳 2），而迁移 v1 按
 * backend-design §3 只建 P1 的 41 张。手工抄一份必然漂移，所以用脚本按表注释里的
 * 分期标记切分，并把生成物连同权威文件 sha256 一起落到 src/store/schema/。
 * tests/store/schema-drift.test.ts 会验证三件事：生成物与权威文件逐句一致、
 * P1 对象集合正好 41 张表、权威文件里没被切走的只能是 P2 与壳。
 *
 * 用法：
 *   node scripts/split-schema.mjs           # 重新生成
 *   node scripts/split-schema.mjs --check   # 只检查生成物是否最新（CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const AUTHORITY_REL = 'docs/schema-2026-11-14.sql'
const AUTHORITY_ABS = path.join(ROOT, AUTHORITY_REL)
const OUT_SQL_REL = 'src/store/schema/001_p1.sql'
const OUT_TS_REL = 'src/store/schema/001_p1.sql.ts'
/** v2 迁移：知识四张 P2 表（kb_table / kb_doc / kb_skill / kb_skill_version）。 */
const OUT_SQL2_REL = 'src/store/schema/002_knowledge.sql'
const OUT_TS2_REL = 'src/store/schema/002_knowledge.sql.ts'
export const KNOWLEDGE_TABLE_NAMES = ['kb_table', 'kb_doc', 'kb_skill', 'kb_skill_version']

const START_RE = /^(CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER)|INSERT INTO)\b/
const P1 = 'P1'
const RANK = { P1: 0, P2: 1, 壳: 2 }

/**
 * 把整份 DDL 切成语句，保留每条语句前面的注释（供生成物保持可读）。
 * 触发器以独立的 `END;` 行结束，其余语句以行尾 `;` 结束。
 */
export function parseSchema(text) {
  const lines = text.split(/\r?\n/)
  const statements = []
  let trivia = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) {
      trivia.push('')
      i += 1
      continue
    }
    if (trimmed.startsWith('--')) {
      trivia.push(raw.replace(/\s+$/, ''))
      i += 1
      continue
    }
    const start = i
    if (!START_RE.test(trimmed)) {
      throw new Error(`第 ${i + 1} 行不是可识别的语句开头：${raw}`)
    }
    const body = [raw]
    const isTrigger = trimmed.startsWith('CREATE TRIGGER')
    if (isTrigger && !/END;\s*$/.test(trimmed)) {
      i += 1
      while (i < lines.length && !lines[i].trim().endsWith('END;')) {
        body.push(lines[i])
        i += 1
      }
      if (i >= lines.length) throw new Error(`第 ${start + 1} 行的触发器没有 END;`)
      body.push(lines[i])
      i += 1
    } else {
      while (!body[body.length - 1].trim().endsWith(';')) {
        i += 1
        if (i >= lines.length) throw new Error(`第 ${start + 1} 行的语句没有以 ; 结束`)
        body.push(lines[i])
      }
      i += 1
    }
    statements.push({ text: body.join('\n'), trivia, startLine: start + 1 })
    trivia = []
  }
  return statements
}

function phaseMarker(text) {
  const m = /^CREATE TABLE[\s\S]*?\[(P1|P2|壳)\]/.exec(text)
  if (!m) throw new Error(`建表语句缺少分期标记 [P1]/[P2]/[壳]：\n${text.split('\n')[0]}`)
  return m[1]
}

function tableOf(stmt) {
  const t = tableOfRaw(stmt.text)
  if (!t) throw new Error(`无法从语句里取出目标表：${stmt.text.split('\n')[0]}`)
  return t
}

function tableOfRaw(text) {
  let m = /^CREATE TABLE\s+(\w+)/.exec(text)
  if (m) return m[1]
  m = /^CREATE (?:UNIQUE )?INDEX\s+\w+\s+ON\s+(\w+)\s*\(/.exec(text)
  if (m) return m[1]
  m = /^INSERT INTO\s+(\w+)/.exec(text)
  if (m) return m[1]
  m = /^CREATE TRIGGER\s+\w+[\s\S]*?\b(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE(?:\s+OF\s+[\w,\s]+)?|DELETE)\s+ON\s+(\w+)/.exec(text)
  if (m) return m[1]
  return null
}

function referencedTables(text) {
  const found = new Set()
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/g
  let m
  while ((m = re.exec(text))) {
    const word = m[1]
    if (['of', 'set', 'where', 'select', 'on', 'begin', 'values'].includes(word)) continue
    found.add(word)
  }
  return found
}

/** 给每条语句判定分期：表看自身标记，索引看目标表，触发器取引用表里最晚的一档。 */
export function classify(statements) {
  const tablePhase = new Map()
  for (const stmt of statements) {
    if (/^CREATE TABLE\b/.test(stmt.text)) {
      const name = /^CREATE TABLE\s+(\w+)/.exec(stmt.text)[1]
      tablePhase.set(name, phaseMarker(stmt.text))
    }
  }
  return statements.map((stmt) => {
    let phase
    if (/^CREATE TABLE\b/.test(stmt.text)) {
      phase = tablePhase.get(tableOf(stmt))
    } else if (/^CREATE TRIGGER\b/.test(stmt.text)) {
      const refs = [tableOf(stmt), ...referencedTables(stmt.text)]
      phase = P1
      for (const ref of refs) {
        const p = tablePhase.get(ref)
        if (!p) continue
        if (RANK[p] > RANK[phase]) phase = p
      }
    } else {
      phase = tablePhase.get(tableOf(stmt))
    }
    if (!phase) throw new Error(`无法判定分期的语句：${stmt.text.split('\n')[0]}`)
    return { ...stmt, phase }
  })
}

function counts(items) {
  const c = { table: 0, index: 0, trigger: 0, insert: 0 }
  for (const s of items) {
    if (/^CREATE TABLE\b/.test(s.text)) c.table += 1
    else if (/^CREATE TRIGGER\b/.test(s.text)) c.trigger += 1
    else if (/^INSERT INTO\b/.test(s.text)) c.insert += 1
    else c.index += 1
  }
  return c
}

function renderSql(classified, meta) {
  const kept = classified.filter((s) => s.phase === P1)
  const keptCounts = counts(kept)
  const header = [
    '-- ⚠️ 自动生成，请勿手改。',
    `-- 来源（权威）：${meta.authority}`,
    `-- 权威文件 sha256：${meta.sha256}`,
    `-- 生成命令：node scripts/split-schema.mjs`,
    `-- 内容：P1 ${keptCounts.table} 表 / ${keptCounts.index} 索引 / ${keptCounts.trigger} 触发器 / ${keptCounts.insert} 种子语句`,
    '-- 分期依据：表注释里的 [P1] / [P2] / [壳] 标记；触发器按它引用的表取最晚一档。',
    '',
  ]
  const body = []
  kept.forEach((stmt, idx) => {
    // 首条语句的 trivia 是权威文件的整份文件头（含 57 表说明），不进迁移文件。
    if (idx > 0 && stmt.trivia.length) {
      const trivia = stmt.trivia.filter((line, i2, arr) => !(line === '' && arr[i2 - 1] === ''))
      body.push(trivia.join('\n').trim())
    }
    body.push(stmt.text)
    body.push('')
  })
  return `${header.join('\n')}${body.join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderTs(sql, meta) {
  if (sql.includes('`') || sql.includes('${')) {
    throw new Error('DDL 里出现了反引号或 ${，无法安全内联进模板字符串')
  }
  const m = meta.counts
  const metaLines = [
    `  authority: ${JSON.stringify(meta.authority)},`,
    `  authoritySha256: ${JSON.stringify(meta.sha256)},`,
    `  tables: ${m.table},`,
    `  indexes: ${m.index},`,
    `  triggers: ${m.trigger},`,
    `  inserts: ${m.insert},`,
    `  p2Tables: ${meta.p2Tables},`,
    `  shellTables: ${meta.shellTables},`,
    `  tableNames: ${JSON.stringify(meta.tableNames)} as const,`,
  ].join('\n')
  return [
    '// ⚠️ 自动生成，请勿手改。生成命令：node scripts/split-schema.mjs',
    `// 来源：${meta.authority}（sha256 ${meta.sha256}）`,
    '// 迁移代码从这里读 DDL，避免运行时依赖 docs/ 目录（打包后 docs 不进产物）。',
    '',
    'export const P1_SCHEMA_SQL = `' + sql + '`',
    '',
    'export const P1_SCHEMA_META = {',
    metaLines,
    '} as const',
    '',
    'export type P1SchemaMeta = typeof P1_SCHEMA_META',
    '',
  ].join('\n')
}

function renderKnowledgeSql(statements, meta) {
  const keptCounts = counts(statements)
  const header = [
    '-- ⚠️ 自动生成，请勿手改。',
    `-- 来源（权威）：${meta.authority}`,
    `-- 权威文件 sha256：${meta.sha256}`,
    `-- 生成命令：node scripts/split-schema.mjs`,
    `-- 内容：v2 知识 ${keptCounts.table} 表 / ${keptCounts.index} 索引 / ${keptCounts.trigger} 触发器 / ${keptCounts.insert} 种子语句`,
    '-- 分期依据：权威 DDL 里 [P2] 且表名属于知识子集的表；v1 已建的 41 张 P1 表不重复。',
    '',
  ]
  const body = []
  statements.forEach((stmt) => {
    if (stmt.trivia.length) {
      const trivia = stmt.trivia.filter((line, i2, arr) => !(line === '' && arr[i2 - 1] === ''))
      if (trivia.length) body.push(trivia.join('\n').trim())
    }
    body.push(stmt.text)
    body.push('')
  })
  return `${header.join('\n')}${body.join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderKnowledgeTs(sql, meta) {
  if (sql.includes('`') || sql.includes('${')) {
    throw new Error('DDL 里出现了反引号或 ${，无法安全内联进模板字符串')
  }
  const m = meta.knowledgeCounts
  const metaLines = [
    `  authority: ${JSON.stringify(meta.authority)},`,
    `  authoritySha256: ${JSON.stringify(meta.sha256)},`,
    `  tables: ${m.table},`,
    `  tableNames: ${JSON.stringify(meta.knowledgeTableNames)} as const,`,
  ].join('\n')
  return [
    '// ⚠️ 自动生成，请勿手改。生成命令：node scripts/split-schema.mjs',
    `// 来源：${meta.authority}（sha256 ${meta.sha256}）`,
    '// v2 迁移：只含知识四张表；其余 P2/壳表仍按分期后置。',
    '',
    'export const KNOWLEDGE_SCHEMA_SQL = `' + sql + '`',
    '',
    'export const KNOWLEDGE_SCHEMA_META = {',
    metaLines,
    '} as const',
    '',
    'export type KnowledgeSchemaMeta = typeof KNOWLEDGE_SCHEMA_META',
    '',
  ].join('\n')
}

export function build() {
  const authority = AUTHORITY_REL
  const text = readFileSync(path.join(ROOT, AUTHORITY_REL), 'utf8')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const classified = classify(parseSchema(text))

  const kept = classified.filter((s) => s.phase === P1)
  const p2Tables = classified.filter((s) => s.phase === 'P2' && /^CREATE TABLE\b/.test(s.text)).length
  const shellTables = classified.filter((s) => s.phase === '壳' && /^CREATE TABLE\b/.test(s.text)).length
  const tableNames = kept
    .filter((stmt) => /^CREATE TABLE\b/.test(stmt.text))
    .map((stmt) => /^CREATE TABLE\s+(\w+)/.exec(stmt.text)[1])
  const knowledgeStatements = classified.filter(
    (stmt) => /^CREATE TABLE\b/.test(stmt.text) && KNOWLEDGE_TABLE_NAMES.includes(tableOf(stmt)),
  )
  if (knowledgeStatements.length !== KNOWLEDGE_TABLE_NAMES.length) {
    throw new Error(`知识表应有 ${KNOWLEDGE_TABLE_NAMES.length} 张，实际 ${knowledgeStatements.length}`)
  }
  const knowledgeTableNames = knowledgeStatements.map((stmt) => tableOf(stmt))
  const meta = {
    authority,
    sha256,
    counts: counts(kept),
    p2Tables,
    shellTables,
    tableNames,
    knowledgeTableNames,
    knowledgeCounts: counts(knowledgeStatements),
  }

  if (meta.counts.table !== 41) {
    throw new Error(`P1 表数量应为 41，实际 ${meta.counts.table}（权威文件的 [P1] 标记可能被改动）`)
  }
  if (meta.counts.table + p2Tables + shellTables !== 57) {
    throw new Error(`分期表数合计应为 57，实际 ${meta.counts.table + p2Tables + shellTables}`)
  }

  const sql = renderSql(classified, meta)
  const ts = renderTs(sql, meta)
  const sql2 = renderKnowledgeSql(knowledgeStatements, meta)
  const ts2 = renderKnowledgeTs(sql2, meta)
  return {
    sql,
    ts,
    sql2,
    ts2,
    meta,
    paths: {
      sql: path.join(ROOT, OUT_SQL_REL),
      ts: path.join(ROOT, OUT_TS_REL),
      sql2: path.join(ROOT, OUT_SQL2_REL),
      ts2: path.join(ROOT, OUT_TS2_REL),
    },
  }
}

function main() {
  const checkOnly = process.argv.includes('--check')
  execFileSync(process.execPath, [path.join(ROOT,'src/store/schema/generate-projects.mjs'), ...(checkOnly ? ['--check'] : [])], {stdio:'inherit'})
  const { sql, ts, sql2, ts2, meta, paths } = build()
  const summary = `v1 = P1 ${meta.counts.table} 表 / ${meta.counts.index} 索引 / ${meta.counts.trigger} 触发器 / ${meta.counts.insert} 种子；v2 = 知识 ${meta.knowledgeCounts.table} 表；v3 = 项目生命周期/活动/技能绑定 7 表；其余 P2 ${meta.p2Tables - meta.knowledgeCounts.table - 7} 表、壳 ${meta.shellTables} 表后置`

  if (checkOnly) {
    const problems = []
    for (const [label, rel, expected] of [
      ['SQL', OUT_SQL_REL, sql],
      ['TS', OUT_TS_REL, ts],
      ['SQL', OUT_SQL2_REL, sql2],
      ['TS', OUT_TS2_REL, ts2],
    ]) {
      const abs = path.join(ROOT, rel)
      if (!existsSync(abs)) problems.push(`${label} 缺失：${rel}`)
      else if (readFileSync(abs, 'utf8') !== expected) problems.push(`${label} 已过期：${rel}`)
    }
    if (problems.length) {
      console.error('生成物不是最新：')
      for (const p of problems) console.error(`  - ${p}`)
      console.error('请运行：node scripts/split-schema.mjs')
      process.exit(1)
    }
    console.log(`✅ 生成物与权威 DDL 一致（${summary}）`)
    return
  }

  mkdirSync(path.dirname(paths.sql), { recursive: true })
  writeFileSync(paths.sql, sql)
  writeFileSync(paths.ts, ts)
  writeFileSync(paths.sql2, sql2)
  writeFileSync(paths.ts2, ts2)
  console.log(`✅ 已生成 ${OUT_SQL_REL} / ${OUT_TS_REL} / ${OUT_SQL2_REL} / ${OUT_TS2_REL}`)
  console.log(`   ${summary}`)
  console.log(`   权威 sha256 ${meta.sha256}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
