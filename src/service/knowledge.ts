/**
 * 知识：读模型 + 真实数据接入（M6）。
 *
 * 三类资产对应三张表，来源都是**本机真实数据**，不是样例：
 *
 * | 类别 | 表 | 真实来源 |
 * |---|---|---|
 * | 文档 | `kb_doc` | 面板内撰写的 Markdown（`<dataDir>/knowledge/docs/*.md`）与显式导入的本地文件（不复制，存绝对路径） |
 * | 技能 | `kb_skill` / `kb_skill_version` | 宿主已安装的技能目录（默认 `$DSH_HOME/skills/<name>/SKILL.md`），按内容哈希去重 |
 * | 数据表 | `kb_table` | HAMS 自己的业务表：同步时登记列结构，详情页按需读实时行数 |
 *
 * 三条边界：
 * 1. **技能同步是镜像，不是授权**：把宿主已装技能登记成「已发布版本」，`published_by`
 *    记的是触发同步的人；真正改技能内容仍要回到宿主目录，HAMS 不在这里写宿主文件。
 * 2. 导入的文档只读：`source_kind='file'` 时改内容要重新导入，避免面板写出与源文件不一致的副本。
 * 3. 扫描有硬上限（目录深度、文件数、单文件字节数），并且跳过隐藏目录与依赖目录；
 *    技能目录只读 `SKILL.md`，不递归读技能里的其他文件。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { stateInvalid } from '../domain/errors.ts'
import type { IdFactory } from '../domain/ids.ts'

const MAX_PREVIEW_CHARS = 16_000
const MAX_DOC_BYTES = 512 * 1024
const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_FILES = 500

/** 同步进 kb_table 的业务表；白名单是为了不把 sqlite_* 与临时表登记成「知识」。 */
export const KNOWLEDGE_TABLE_SOURCES = [
  'work_item',
  'project',
  'member',
  'evidence',
  'work_template',
  'task_run',
  'approval',
  'proposal',
  'work_item_check',
  'metric_observation',
  'asset',
  'audit_log',
] as const

const SKIP_DIRS = new Set(['node_modules', '_build', '.git', 'dist', '.venv', 'venv', '__pycache__', '.cache'])
const DENY_PATH_FRAGMENTS = ['/.dsh/sessions', '/.ssh', '/.aws', '/.gnupg', '/Library/Keychains']

export interface KnowledgeOptions {
  /** HAMS 数据目录（`$DSH_HOME/hams`）；面板撰写的文档写在这里。 */
  dataDir: string
  /** 真实技能目录；默认空数组时同步会报「未配置技能源」，不会静默成功。 */
  skillDirs?: string[]
}

export interface KnowledgeCounts {
  docs: number
  skills: number
  tables: number
}

export interface KnowledgeDocItem {
  kind: 'doc'
  id: string
  title: string
  subtitle: string
  status: string
  source_kind: string
  revision: number
  bytes: number
  updated_at: number
  owner_id: string
  owner_name: string | null
  path: string
}

export interface KnowledgeSkillItem {
  kind: 'skill'
  id: string
  name: string
  subtitle: string
  version: string | null
  content_hash: string | null
  published_at: number | null
  usage_count: number
  path: string | null
  /** 本轮同步时原始文件是否还在（不在也能读历史版本，值只表示镜像源缺失）。 */
  present: boolean
  created_at: number
}

export interface KnowledgeTableItem {
  kind: 'table'
  id: string
  name: string
  subtitle: string
  source_kind: string
  source_ref: string | null
  columns: number
  row_count: number | null
  updated_at: number
}

export type KnowledgeItem = KnowledgeDocItem | KnowledgeSkillItem | KnowledgeTableItem

export interface DocDetail extends KnowledgeDocItem {
  present: boolean
  changed: boolean
  content: string
  truncated: boolean
  file_bytes: number | null
}

export interface SkillDetail extends KnowledgeSkillItem {
  description: string | null
  when_to_use: string | null
  content: string
  truncated: boolean
  versions: {
    id: string
    version: string
    status: string
    content_hash: string
    published_by: string | null
    published_at: number | null
  }[]
}

export interface TableDetail extends KnowledgeTableItem {
  columns_detail: { name: string; type: string; notnull: number; pk: number }[]
  live: boolean
}

export interface KnowledgeListResult {
  items: KnowledgeItem[]
  counts: KnowledgeCounts
  sources: { skill_dirs: string[]; docs_dir: string; tables: number }
}

export interface SyncReport {
  at: number
  skills: { roots: number; scanned: number; created: number; updated: number; unchanged: number; missing: number; errors: string[] }
  tables: { created: number; updated: number; unchanged: number; errors: string[] }
}

export interface ImportReport {
  at: number
  dir: string
  scanned: number
  imported: number
  updated: number
  skipped: number
  errors: { path: string; message: string }[]
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function clampPreview(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_PREVIEW_CHARS) return { content: text, truncated: false }
  return { content: `${text.slice(0, MAX_PREVIEW_CHARS)}\n\n…（已截断，共 ${text.length} 字符）`, truncated: true }
}

/** 只解析顶层 `key: value` 的 frontmatter；嵌套结构原样留在正文，不假装是 YAML 解析器。 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const block = text.slice(3, end)
  const meta: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[match[1]] = value
  }
  const after = text.slice(end + 4)
  return { meta, body: after.replace(/^\r?\n/, '') }
}

function titleOfFile(text: string, fallback: string): string {
  const { meta, body } = parseFrontmatter(text)
  if (meta.title && meta.title.trim()) return meta.title.trim()
  const heading = /^#\s+(.+)$/m.exec(body)
  if (heading) return heading[1].trim()
  return fallback.replace(/\.(md|markdown)$/i, '')
}

function isDeniedPath(target: string): boolean {
  const normalized = target.replace(/\\/g, '/')
  return DENY_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2))
  return input
}

function slug(name: string, fallbackSeed: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii) return ascii.slice(0, 40)
  return `s-${sha256(fallbackSeed).slice(0, 8)}`
}

function columnList(db: DatabaseSync, table: string): { name: string; type: string; notnull: number; pk: number }[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string
    type: string
    notnull: number
    pk: number
  }[]).map((row) => ({ name: row.name, type: row.type, notnull: Number(row.notnull), pk: Number(row.pk) }))
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { ok: number }
      | undefined,
  )
}

export class KnowledgeService {
  private db: DatabaseSync
  private now: () => number
  private ids: IdFactory
  private dataDir: string
  private skillDirs: string[]

  constructor(options: { db: DatabaseSync; now: () => number; idFactory: IdFactory } & KnowledgeOptions) {
    this.db = options.db
    this.now = options.now
    this.ids = options.idFactory
    this.dataDir = path.resolve(options.dataDir)
    this.skillDirs = (options.skillDirs ?? []).map((dir) => path.resolve(expandHome(dir)))
  }

  get docsDir(): string {
    return path.join(this.dataDir, 'knowledge', 'docs')
  }

  getSkillsDirs(): string[] {
    return [...this.skillDirs]
  }

  // ───────────────────────── 读 ─────────────────────────

  list(filter: { kind?: string; q?: string; limit?: number } = {}): KnowledgeListResult {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
    const docs = this.listDocs()
    const skills = this.listSkills()
    const tables = this.listTables()
    const counts: KnowledgeCounts = { docs: docs.length, skills: skills.length, tables: tables.length }
    let items: KnowledgeItem[] = []
    if (!filter.kind || filter.kind === 'doc') items.push(...docs)
    if (!filter.kind || filter.kind === 'skill') items.push(...skills)
    if (!filter.kind || filter.kind === 'table') items.push(...tables)
    const q = (filter.q ?? '').trim().toLowerCase()
    if (q) {
      items = items.filter((item) => {
        const name = 'name' in item ? item.name : ''
        const title = 'title' in item ? item.title : ''
        return `${item.id} ${name} ${title} ${item.subtitle}`.toLowerCase().includes(q)
      })
    }
    items.sort((a, b) => {
      const ta = a.kind === 'doc' ? a.updated_at : a.kind === 'skill' ? (a.published_at ?? a.created_at) : a.updated_at
      const tb = b.kind === 'doc' ? b.updated_at : b.kind === 'skill' ? (b.published_at ?? b.created_at) : b.updated_at
      return tb - ta
    })
    return {
      items: items.slice(0, limit),
      counts,
      sources: { skill_dirs: this.getSkillsDirs(), docs_dir: this.docsDir, tables: tables.length },
    }
  }

  private listDocs(): KnowledgeDocItem[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, m.name AS owner_name FROM kb_doc d
           LEFT JOIN member m ON m.id = d.owner_id
          ORDER BY d.updated_at DESC`,
      )
      .all() as {
      id: string
      title: string
      body_ref: string
      revision: number
      owner_id: string
      owner_name: string | null
      source_kind: string
      bytes: number
      status: string
      updated_at: number
    }[]
    return rows.map((row) => ({
      kind: 'doc' as const,
      id: row.id,
      title: row.title,
      subtitle: row.source_kind === 'file' ? row.body_ref : 'HAMS 内撰写',
      status: row.status,
      source_kind: row.source_kind,
      revision: Number(row.revision),
      bytes: Number(row.bytes),
      updated_at: Number(row.updated_at),
      owner_id: row.owner_id,
      owner_name: row.owner_name,
      path: row.body_ref,
    }))
  }

  private listSkills(): KnowledgeSkillItem[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, v.version AS version, v.content_hash AS content_hash, v.published_at AS published_at,
                v.manifest_json AS manifest_json
           FROM kb_skill s
           LEFT JOIN kb_skill_version v ON v.id = s.published_version_id
          ORDER BY COALESCE(v.published_at, s.created_at) DESC`,
      )
      .all() as {
      id: string
      name: string
      domain: string | null
      published_version_id: string | null
      usage_count: number
      created_at: number
      version: string | null
      content_hash: string | null
      published_at: number | null
      manifest_json: string | null
    }[]
    return rows.map((row) => {
      const manifest = this.parseManifest(row.manifest_json)
      const filePath = typeof manifest.path === 'string' ? manifest.path : null
      return {
        kind: 'skill' as const,
        id: row.id,
        name: row.name,
        subtitle: typeof manifest.description === 'string' ? manifest.description : (row.domain ?? ''),
        version: row.version,
        content_hash: row.content_hash,
        published_at: row.published_at === null ? null : Number(row.published_at),
        usage_count: Number(row.usage_count),
        path: filePath,
        present: Boolean(filePath && existsSync(filePath)),
        created_at: Number(row.created_at),
      }
    })
  }

  private listTables(): KnowledgeTableItem[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_table ORDER BY name')
      .all() as {
      id: string
      name: string
      source_kind: string
      source_ref: string | null
      schema_json: string
      field_map_status: string
      updated_at: number
    }[]
    return rows.map((row) => {
      const schema = this.parseSchema(row.schema_json)
      return {
        kind: 'table' as const,
        id: row.id,
        name: row.name,
        subtitle: `${row.source_kind}${row.source_ref ? ` · ${row.source_ref}` : ''}`,
        source_kind: row.source_kind,
        source_ref: row.source_ref,
        columns: schema.columns.length,
        row_count: this.liveRowCount(row.source_kind, row.source_ref),
        updated_at: Number(row.updated_at),
      }
    })
  }

  get(kind: string, id: string): KnowledgeItem | DocDetail | SkillDetail | TableDetail {
    if (kind === 'doc') return this.getDoc(id)
    if (kind === 'skill') return this.getSkill(id)
    if (kind === 'table') return this.getTable(id)
    throw stateInvalid('知识类型只能是 doc / skill / table')
  }

  getDoc(id: string): DocDetail {
    const row = this.db.prepare('SELECT * FROM kb_doc WHERE id = ?').get(id) as
      | {
          id: string
          title: string
          body_ref: string
          revision: number
          owner_id: string
          source_kind: string
          content_hash: string
          bytes: number
          status: string
          updated_at: number
        }
      | undefined
    if (!row) throw stateInvalid(`文档不存在：${id}`)
    const owner = this.db.prepare('SELECT name FROM member WHERE id = ?').get(row.owner_id) as
      | { name: string }
      | undefined
    const file = this.readFileSafe(row.body_ref)
    const currentHash = file.ok ? sha256(file.text) : ''
    const changed = Boolean(file.ok && row.content_hash && currentHash !== row.content_hash)
    // 预览只给正文：frontmatter 里的 title/revision 已经单独返回，重复显示会让人误以为要编辑元数据。
    const bodyText = file.ok ? parseFrontmatter(file.text).body : ''
    const preview = clampPreview(file.ok ? bodyText : '（源文件暂时读不到；先确认路径或重新导入）')
    return {
      kind: 'doc',
      id: row.id,
      title: row.title,
      subtitle: row.source_kind === 'file' ? row.body_ref : 'HAMS 内撰写',
      status: row.status,
      source_kind: row.source_kind,
      revision: Number(row.revision),
      bytes: Number(row.bytes),
      updated_at: Number(row.updated_at),
      owner_id: row.owner_id,
      owner_name: owner?.name ?? null,
      path: row.body_ref,
      present: file.ok,
      changed,
      content: preview.content,
      truncated: preview.truncated,
      file_bytes: file.ok ? Buffer.byteLength(file.text, 'utf8') : null,
    }
  }

  getSkill(id: string): SkillDetail {
    const skill = this.listSkills().find((item) => item.id === id)
    if (!skill) throw stateInvalid(`技能不存在：${id}`)
    const versionRow = this.db
      .prepare('SELECT * FROM kb_skill_version WHERE id = (SELECT published_version_id FROM kb_skill WHERE id = ?)')
      .get(id) as { manifest_json: string } | undefined
    const manifest = this.parseManifest(versionRow?.manifest_json ?? null)
    const preview = skill.path ? this.readFileSafe(skill.path) : { ok: false, text: '' }
    const bodyText = preview.ok ? parseFrontmatter(preview.text).body : ''
    const content = clampPreview(preview.ok ? bodyText : '（技能源文件不在磁盘上了；历史版本仍保留）')
    const versions = this.db
      .prepare(
        `SELECT id, version, status, content_hash, published_by, published_at
           FROM kb_skill_version WHERE skill_id = ? ORDER BY published_at DESC, rowid DESC LIMIT 10`,
      )
      .all(id) as {
      id: string
      version: string
      status: string
      content_hash: string
      published_by: string | null
      published_at: number | null
    }[]
    return {
      ...skill,
      description: typeof manifest.description === 'string' ? manifest.description : null,
      when_to_use: typeof manifest.whenToUse === 'string' ? manifest.whenToUse : null,
      content: content.content,
      truncated: content.truncated,
      versions: versions.map((item) => ({
        ...item,
        published_at: item.published_at === null ? null : Number(item.published_at),
      })),
    }
  }

  getTable(id: string): TableDetail {
    const row = this.db.prepare('SELECT * FROM kb_table WHERE id = ?').get(id) as
      | {
          id: string
          name: string
          source_kind: string
          source_ref: string | null
          schema_json: string
          field_map_status: string
          updated_at: number
        }
      | undefined
    if (!row) throw stateInvalid(`数据表不存在：${id}`)
    const schema = this.parseSchema(row.schema_json)
    return {
      kind: 'table',
      id: row.id,
      name: row.name,
      subtitle: `${row.source_kind}${row.source_ref ? ` · ${row.source_ref}` : ''}`,
      source_kind: row.source_kind,
      source_ref: row.source_ref,
      columns: schema.columns.length,
      row_count: this.liveRowCount(row.source_kind, row.source_ref),
      updated_at: Number(row.updated_at),
      columns_detail: schema.columns,
      live: this.isLiveLocalTable(row.source_kind, row.source_ref),
    }
  }

  // ───────────────────────── 同步（真实来源） ─────────────────────────

  sync(actorId: string): SyncReport {
    const at = this.now()
    const report: SyncReport = {
      at,
      skills: { roots: this.skillDirs.length, scanned: 0, created: 0, updated: 0, unchanged: 0, missing: 0, errors: [] },
      tables: { created: 0, updated: 0, unchanged: 0, errors: [] },
    }
    if (!this.skillDirs.length) {
      report.skills.errors.push('没有配置技能目录（默认应为 $DSH_HOME/skills）')
    }
    for (const root of this.skillDirs) {
      if (!existsSync(root)) {
        report.skills.errors.push(`技能目录不存在：${root}`)
        continue
      }
      let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch (error) {
        report.skills.errors.push(`读不了技能目录 ${root}：${(error as Error).message}`)
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue
        const file = path.join(root, entry.name, 'SKILL.md')
        if (!existsSync(file)) continue
        try {
          const before = this.db.prepare('SELECT id FROM kb_skill WHERE name = ?').get(entry.name) as
            | { id: string }
            | undefined
          const result = this.syncSkillFile(actorId, file, entry.name, before?.id)
          report.skills.scanned += 1
          if (result === 'created') report.skills.created += 1
          else if (result === 'updated') report.skills.updated += 1
          else report.skills.unchanged += 1
        } catch (error) {
          report.skills.errors.push(`${file}：${(error as Error).message}`)
        }
      }
    }
    report.skills.missing = this.countMissingSkills()

    for (const table of KNOWLEDGE_TABLE_SOURCES) {
      try {
        if (!tableExists(this.db, table)) continue
        const outcome = this.syncTable(table, at)
        if (outcome === 'created') report.tables.created += 1
        else if (outcome === 'updated') report.tables.updated += 1
        else report.tables.unchanged += 1
      } catch (error) {
        report.tables.errors.push(`${table}：${(error as Error).message}`)
      }
    }
    return report
  }

  private syncSkillFile(
    actorId: string,
    file: string,
    dirName: string,
    existingId: string | undefined,
  ): 'created' | 'updated' | 'unchanged' {
    const text = readFileSync(file, 'utf8')
    const hash = sha256(text)
    const { meta } = parseFrontmatter(text)
    const name = (meta.name || dirName).trim()
    const skill = existingId
      ? (this.db.prepare('SELECT * FROM kb_skill WHERE id = ?').get(existingId) as
          | { id: string; name: string; published_version_id: string | null }
          | undefined)
      : undefined
    const now = this.now()
    const manifest = JSON.stringify({
      source: 'host-skills',
      name,
      description: meta.description ?? '',
      whenToUse: meta.whenToUse ?? '',
      path: file,
      root: path.dirname(path.dirname(file)),
      bytes: Buffer.byteLength(text, 'utf8'),
      mtime: statSync(file).mtimeMs,
      syncedAt: now,
    })

    if (skill?.published_version_id) {
      const published = this.db
        .prepare('SELECT content_hash FROM kb_skill_version WHERE id = ?')
        .get(skill.published_version_id) as { content_hash: string } | undefined
      if (published && published.content_hash === hash) return 'unchanged'
    }

    let id = skill?.id
    let created = false
    if (!id) {
      const byName = this.db.prepare('SELECT id FROM kb_skill WHERE name = ?').get(name) as { id: string } | undefined
      if (byName) id = byName.id
    }
    if (!id) {
      id = `ks-${slug(name, file)}`
      if (this.db.prepare('SELECT 1 FROM kb_skill WHERE id = ?').get(id)) id = `ks-${slug(name, file)}-${hash.slice(0, 6)}`
      this.db.prepare('INSERT INTO kb_skill (id, name, domain, published_version_id, usage_count, created_at) VALUES (?, ?, ?, NULL, 0, ?)').run(
        id,
        name,
        meta.domain ?? null,
        now,
      )
      created = true
    }

    this.db.prepare("UPDATE kb_skill_version SET status = 'retired' WHERE skill_id = ? AND status = 'published'").run(id)
    let version = `sync-${hash.slice(0, 12)}`
    const clash = this.db.prepare('SELECT 1 FROM kb_skill_version WHERE skill_id = ? AND version = ?').get(id, version)
    if (clash) version = `${version}-${now.toString(36)}`
    const versionId = this.ids()
    this.db.prepare(
      `INSERT INTO kb_skill_version
         (id, skill_id, version, manifest_json, content_hash, status, authored_by, published_by, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
    ).run(versionId, id, version, manifest, hash, actorId, actorId, now)
    this.db.prepare('UPDATE kb_skill SET published_version_id = ?, name = ?, domain = ? WHERE id = ?').run(
      versionId,
      name,
      meta.domain ?? null,
      id,
    )
    return created ? 'created' : 'updated'
  }

  private countMissingSkills(): number {
    const rows = this.db
      .prepare(
        `SELECT v.manifest_json FROM kb_skill s
           JOIN kb_skill_version v ON v.id = s.published_version_id`,
      )
      .all() as { manifest_json: string }[]
    let missing = 0
    for (const row of rows) {
      const manifest = this.parseManifest(row.manifest_json)
      if (typeof manifest.path === 'string' && !existsSync(manifest.path)) missing += 1
    }
    return missing
  }

  private syncTable(table: string, at: number): 'created' | 'updated' | 'unchanged' {
    const columns = columnList(this.db, table)
    const schema = JSON.stringify({ table, columns })
    const id = `kt-${table}`
    const existing = this.db.prepare('SELECT * FROM kb_table WHERE id = ?').get(id) as
      | { id: string; schema_json: string; source_ref: string | null }
      | undefined
    if (!existing) {
      this.db.prepare(
        `INSERT INTO kb_table (id, name, source_kind, source_ref, schema_json, field_map_status, updated_at)
         VALUES (?, ?, 'local', ?, ?, 'ok', ?)`,
      ).run(id, `HAMS 业务表 · ${table}`, `hams:${table}`, schema, at)
      return 'created'
    }
    if (existing.schema_json !== schema || existing.source_ref !== `hams:${table}`) {
      this.db
        .prepare("UPDATE kb_table SET schema_json = ?, source_ref = ?, updated_at = ? WHERE id = ?")
        .run(schema, `hams:${table}`, at, id)
      return 'updated'
    }
    return 'unchanged'
  }

  // ───────────────────────── 写：文档 ─────────────────────────

  createDoc(actorId: string, input: { title: string; body: string; status?: string }): { id: string; revision: number; path: string } {
    const title = String(input.title ?? '').trim()
    if (!title) throw stateInvalid('标题不能为空')
    if (title.length > 120) throw stateInvalid('标题超过 120 字')
    const body = typeof input.body === 'string' ? input.body : ''
    if (!body.trim()) throw stateInvalid('正文不能为空')
    if (Buffer.byteLength(body, 'utf8') > MAX_DOC_BYTES) throw stateInvalid(`正文超过 ${MAX_DOC_BYTES / 1024} KB`)
    const status = input.status === 'published' ? 'published' : 'draft'
    const id = this.ids()
    const now = this.now()
    const file = path.join(this.docsDir, `${id}.md`)
    mkdirSync(this.docsDir, { recursive: true })
    const content = this.docFileContent({ title, body, ownerId: actorId, createdAt: now, revision: 1 })
    writeFileSync(file, content, 'utf8')
    this.db.prepare(
      `INSERT INTO kb_doc (id, title, body_ref, revision, owner_id, source_kind, content_hash, bytes, status, updated_at)
       VALUES (?, ?, ?, 1, ?, 'hams', ?, ?, ?, ?)`,
    ).run(id, title, file, actorId, sha256(content), Buffer.byteLength(content, 'utf8'), status, now)
    return { id, revision: 1, path: file }
  }

  updateDoc(
    actorId: string,
    docId: string,
    input: { title?: string; body: string; expectedRevision?: number },
    allowForeign: boolean,
  ): { id: string; revision: number; path: string } {
    const row = this.db.prepare('SELECT * FROM kb_doc WHERE id = ?').get(docId) as
      | {
          id: string
          title: string
          body_ref: string
          revision: number
          owner_id: string
          source_kind: string
        }
      | undefined
    if (!row) throw stateInvalid(`文档不存在：${docId}`)
    if (row.source_kind !== 'hams') throw stateInvalid('导入的文件是只读镜像，请修改源文件后重新导入')
    if (row.owner_id !== actorId && !allowForeign) throw stateInvalid('只有作者或有成员管理权限的人能改这篇文档')
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== Number(row.revision)) {
      throw stateInvalid(`修订号已变：期望 ${input.expectedRevision}，当前 ${row.revision}`, '刷新后比较两版内容再提交')
    }
    const title = input.title === undefined ? row.title : String(input.title).trim()
    if (!title) throw stateInvalid('标题不能为空')
    const body = typeof input.body === 'string' ? input.body : ''
    if (!body.trim()) throw stateInvalid('正文不能为空')
    if (Buffer.byteLength(body, 'utf8') > MAX_DOC_BYTES) throw stateInvalid(`正文超过 ${MAX_DOC_BYTES / 1024} KB`)

    const now = this.now()
    const revision = Number(row.revision) + 1
    if (existsSync(row.body_ref)) {
      copyFileSync(row.body_ref, path.join(this.docsDir, `${docId}.v${row.revision}.md`))
    }
    const content = this.docFileContent({ title, body, ownerId: row.owner_id, createdAt: now, revision })
    mkdirSync(this.docsDir, { recursive: true })
    writeFileSync(row.body_ref, content, 'utf8')
    this.db.prepare(
      `UPDATE kb_doc SET title = ?, content_hash = ?, bytes = ?, revision = ?, updated_at = ? WHERE id = ?`,
    ).run(title, sha256(content), Buffer.byteLength(content, 'utf8'), revision, now, docId)
    return { id: docId, revision, path: row.body_ref }
  }

  private docFileContent(input: { title: string; body: string; ownerId: string; createdAt: number; revision: number }): string {
    const stamp = new Date(input.createdAt).toISOString()
    return [
      '---',
      `title: ${JSON.stringify(input.title)}`,
      `owner: ${input.ownerId}`,
      `revision: ${input.revision}`,
      `updated: ${stamp}`,
      '---',
      '',
      input.body.replace(/\r\n/g, '\n').trimEnd(),
      '',
    ].join('\n')
  }

  publishDoc(actorId: string, docId: string, allowForeign: boolean): { id: string; status: string } {
    const row = this.db.prepare('SELECT id, owner_id, status FROM kb_doc WHERE id = ?').get(docId) as
      | { id: string; owner_id: string; status: string }
      | undefined
    if (!row) throw stateInvalid(`文档不存在：${docId}`)
    if (row.owner_id !== actorId && !allowForeign) throw stateInvalid('只有作者或有成员管理权限的人能发布这篇文档')
    if (row.status === 'archived') throw stateInvalid('已归档的文档不能直接发布')
    if (row.status !== 'published') {
      this.db.prepare("UPDATE kb_doc SET status = 'published', updated_at = ? WHERE id = ?").run(this.now(), docId)
    }
    return { id: docId, status: 'published' }
  }

  /** 导入单个本机文件（工作区画像用）；返回 created / updated / skipped。 */
  importFile(
    actorId: string,
    file: string,
    options: { title?: string; status?: 'draft' | 'published' } = {},
  ): 'created' | 'updated' | 'skipped' {
    const target = path.resolve(expandHome(file))
    if (isDeniedPath(target)) throw stateInvalid('这个路径不在允许导入的范围里（会话记录、密钥目录不读）')
    if (!existsSync(target)) throw stateInvalid(`文件不存在：${target}`)
    if (!statSync(target).isFile()) throw stateInvalid(`不是文件：${target}`)
    return this.upsertImportedFile(actorId, target, options)
  }

  private upsertImportedFile(
    actorId: string,
    file: string,
    options: { title?: string; status?: 'draft' | 'published' } = {},
  ): 'created' | 'updated' | 'skipped' {
    const size = statSync(file).size
    if (size > MAX_IMPORT_BYTES) throw stateInvalid(`超过 ${MAX_IMPORT_BYTES / 1024 / 1024} MB，跳过`)
    const text = readFileSync(file, 'utf8')
    const hash = sha256(text)
    const existing = this.db.prepare('SELECT * FROM kb_doc WHERE body_ref = ?').get(file) as
      | { id: string; content_hash: string; title: string }
      | undefined
    if (existing) {
      if (existing.content_hash === hash) return 'skipped'
      this.db
        .prepare(
          `UPDATE kb_doc SET title = ?, content_hash = ?, bytes = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          options.title ?? titleOfFile(text, path.basename(file)),
          hash,
          Buffer.byteLength(text, 'utf8'),
          this.now(),
          existing.id,
        )
      return 'updated'
    }
    const id = this.ids()
    const now = this.now()
    this.db.prepare(
      `INSERT INTO kb_doc (id, title, body_ref, revision, owner_id, source_kind, content_hash, bytes, status, updated_at)
       VALUES (?, ?, ?, 1, ?, 'file', ?, ?, ?, ?)`,
    ).run(
      id,
      options.title ?? titleOfFile(text, path.basename(file)),
      file,
      actorId,
      hash,
      Buffer.byteLength(text, 'utf8'),
      options.status ?? 'published',
      now,
    )
    return 'created'
  }

  importDocs(
    actorId: string,
    input: { dir: string; recursive?: boolean; maxFiles?: number },
  ): ImportReport {
    const raw = String(input.dir ?? '').trim()
    if (!raw) throw stateInvalid('导入目录不能为空')
    const dir = path.resolve(expandHome(raw))
    if (isDeniedPath(dir)) throw stateInvalid('这个目录不在允许导入的范围里（会话记录、密钥目录不读）')
    if (!existsSync(dir)) throw stateInvalid(`目录不存在：${dir}`)
    if (!statSync(dir).isDirectory()) throw stateInvalid(`不是目录：${dir}`)

    const recursive = input.recursive !== false
    const maxFiles = Math.min(Math.max(Number(input.maxFiles ?? 200), 1), MAX_IMPORT_FILES)
    const report: ImportReport = { at: this.now(), dir, scanned: 0, imported: 0, updated: 0, skipped: 0, errors: [] }
    const files: string[] = []
    const walk = (current: string, depth: number): void => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch (error) {
        report.errors.push({ path: current, message: (error as Error).message })
        return
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) return
        const name = entry.name
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
        const full = path.join(current, name)
        if (entry.isDirectory()) {
          if (recursive && depth < 4) walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (!/\.(md|markdown)$/i.test(name)) continue
        files.push(full)
      }
    }
    walk(dir, 0)

    for (const file of files) {
      report.scanned += 1
      try {
        const outcome = this.upsertImportedFile(actorId, file)
        if (outcome === 'created') report.imported += 1
        else if (outcome === 'updated') report.updated += 1
        else report.skipped += 1
      } catch (error) {
        report.errors.push({ path: file, message: (error as Error).message })
      }
    }
    return report
  }

  // ───────────────────────── 内部 ─────────────────────────

  private readFileSafe(file: string): { ok: boolean; text: string } {
    try {
      if (!file || !existsSync(file)) return { ok: false, text: '' }
      const stat = statSync(file)
      if (!stat.isFile()) return { ok: false, text: '' }
      return { ok: true, text: readFileSync(file, 'utf8') }
    } catch {
      return { ok: false, text: '' }
    }
  }

  private parseManifest(raw: string | null): Record<string, unknown> {
    if (!raw) return {}
    try {
      const value = JSON.parse(raw) as unknown
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private parseSchema(raw: string): { columns: { name: string; type: string; notnull: number; pk: number }[] } {
    try {
      const value = JSON.parse(raw) as { columns?: unknown }
      return {
        columns: Array.isArray(value.columns)
          ? (value.columns as { name: string; type: string; notnull: number; pk: number }[])
          : [],
      }
    } catch {
      return { columns: [] }
    }
  }

  private isLiveLocalTable(sourceKind: string, sourceRef: string | null): boolean {
    if (sourceKind !== 'local' || !sourceRef?.startsWith('hams:')) return false
    const table = sourceRef.slice(5)
    return /^[a-z_][a-z0-9_]*$/.test(table) && tableExists(this.db, table)
  }

  private liveRowCount(sourceKind: string, sourceRef: string | null): number | null {
    if (!this.isLiveLocalTable(sourceKind, sourceRef)) return null
    const table = String(sourceRef).slice(5)
    try {
      return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c)
    } catch {
      return null
    }
  }
}
