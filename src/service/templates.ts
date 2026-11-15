/**
 * 起步模板与旧样例清理。
 *
 * 2026-11-15 起，空库不再造「电池告警追踪」这个示例模板，改为一条与真实使用
 * 方式一致的通用模板：**研究与交付推进**——交付物一份（doc）+ 过程记录一份（log），
 * 三天后复查，owner 审批 72 小时、不自动关单。理由有两条：
 *
 * 1. 电池资产运营是设计期的首个场景，不是当前工作；把示例写进用户库会让人以为
 *    系统里已经有业务数据。
 * 2. 通用模板能覆盖研究、开发、数据运维三类工作项，建单后都能走到「申请关单」，
 *    不会出现「模板是别人业务的、自己的单关不掉」。
 *
 * 旧库升级时由工作区画像的 `cleanupTemplates` 调用 `removeTemplateIfUnused`：
 * 只有模板确实存在、且没有任何工作项引用它的版本时才删除，历史单据不受影响。
 */
import type { DatabaseSync } from 'node:sqlite'

export const STARTER_TEMPLATE = {
  id: 'tpl-research-delivery',
  versionId: 'tpl-research-delivery-v1',
  key: 'research_delivery',
  name: '研究与交付推进',
  domain: '研究',
  category: '研究推进',
  /** 交付物一份 + 过程记录一份；720 小时是上限，不是要求每天都补。 */
  requiredEvidence: [
    { kind: 'doc', min_count: 1, max_age_hours: 720 },
    { kind: 'log', min_count: 1, max_age_hours: 720 },
  ],
  checkPolicy: { mode: 'after_hours', hours: 72 },
  reviewPolicy: { approver: 'owner', expires_hours: 72, auto_close: false },
} as const

/**
 * 空库首次启动建一次起步模板，并记在 hams_meta。只补默认、不覆盖：
 * 只要库里已有模板（或元数据已记），就不再造。
 */
export function ensureStarterTemplate(db: DatabaseSync, publishedBy: string, now = Date.now()): string | null {
  const seeded = db.prepare("SELECT value FROM hams_meta WHERE key = 'starter_template_at'").get() as
    | { value: string }
    | undefined
  if (seeded) return null
  const existing = db.prepare('SELECT id FROM work_template LIMIT 1').get() as { id: string } | undefined

  db.exec('BEGIN IMMEDIATE')
  try {
    if (!existing) {
      upsertTemplate(db, publishedBy, now, STARTER_TEMPLATE)
    }
    db.prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES ('starter_template_at', ?)").run(String(now))
    db.exec('COMMIT')
    return existing ? null : STARTER_TEMPLATE.versionId
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

export interface TemplateDefinition {
  id: string
  versionId: string
  key: string
  name: string
  domain: string
  category: string
  requiredEvidence: readonly { kind: string; min_count: number; max_age_hours?: number }[]
  checkPolicy: Record<string, unknown>
  reviewPolicy: Record<string, unknown>
}

/** 幂等：按 key 找模板与版本；已存在就直接用已发布版本。 */
export function upsertTemplate(
  db: DatabaseSync,
  publishedBy: string,
  now: number,
  definition: TemplateDefinition,
): string {
  const existing = db.prepare('SELECT * FROM work_template WHERE key = ?').get(definition.key) as
    | { id: string; published_version_id: string | null }
    | undefined
  if (existing?.published_version_id) return existing.published_version_id

  const templateId = existing?.id ?? definition.id
  if (!existing) {
    db.prepare('INSERT INTO work_template (id, key, name, domain, category) VALUES (?, ?, ?, ?, ?)').run(
      templateId,
      definition.key,
      definition.name,
      definition.domain,
      definition.category,
    )
  }
  const versionId = definition.versionId
  db.prepare(
    `INSERT INTO work_template_version
       (id, template_id, version, required_evidence_json, validator_key, validator_params_json,
        check_policy_json, review_policy_json, misfire_policy, status, published_by, published_at)
     VALUES (?, ?, 1, ?, NULL, '{}', ?, ?, 'each', 'published', ?, ?)`,
  ).run(
    versionId,
    templateId,
    JSON.stringify(definition.requiredEvidence),
    JSON.stringify(definition.checkPolicy),
    JSON.stringify(definition.reviewPolicy),
    publishedBy,
    now,
  )
  db.prepare('UPDATE work_template SET published_version_id = ? WHERE id = ?').run(versionId, templateId)
  return versionId
}

/**
 * 删除一个旧示例模板：只在**没有任何工作项引用它的版本**时执行。
 * 返回 true 表示确实删了。
 */
export function removeTemplateIfUnused(db: DatabaseSync, templateIdOrKey: string): boolean {
  const template = db
    .prepare('SELECT id, published_version_id FROM work_template WHERE id = ? OR key = ?')
    .get(templateIdOrKey, templateIdOrKey) as { id: string; published_version_id: string | null } | undefined
  if (!template) return false
  const versions = db.prepare('SELECT id FROM work_template_version WHERE template_id = ?').all(template.id) as {
    id: string
  }[]
  if (!versions.length) {
    db.prepare('DELETE FROM work_template WHERE id = ?').run(template.id)
    return true
  }
  const placeholders = versions.map(() => '?').join(',')
  const versionIds = versions.map((version) => version.id) as never[]
  for (const table of ['work_item', 'work_item_check', 'schedule']) {
    const referenced = db
      .prepare(`SELECT 1 AS ok FROM ${table} WHERE template_version_id IN (${placeholders}) LIMIT 1`)
      .get(...versionIds) as { ok: number } | undefined
    if (referenced) return false
  }
  db.prepare('UPDATE work_template SET published_version_id = NULL WHERE id = ?').run(template.id)
  db.prepare('DELETE FROM work_template_version WHERE template_id = ?').run(template.id)
  db.prepare('DELETE FROM work_template WHERE id = ?').run(template.id)
  return true
}
