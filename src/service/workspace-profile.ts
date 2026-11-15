/**
 * 工作区画像（workspace profile）：把「我现在在做的事」一次性灌进 HAMS。
 *
 * 为什么不是把项目写死在代码里：这些内容属于用户，不属于插件。画像是一个
 * 放在数据目录下的 JSON（默认 `$DSH_HOME/hams/workspace-profile.json`），
 * 记录当前工作区里真实存在的项目、角色、下一步和文档路径；代码只负责读它、
 * 校验它、幂等地落库，并在 `hams_meta` 里记内容哈希，避免每次启动重复写。
 *
 * 三条纪律：
 * 1. **只补缺失，不覆盖**：成员按名字、项目按名字、工作项按 `profile:<key>`
 *    去重、文档按绝对路径去重；已经有的不动，用户改过的内容不会被画像覆盖。
 * 2. **来源可追溯**：工作项带 `source` 链接到工作区里的真实文件，知识文档
 *    登记绝对路径与 sha256，不复制正文。
 * 3. **失败不阻断启动**：某一篇文档路径不在、某个成员名冲突，只记进报告的
 *    `errors`，其余内容照常落库；适配器只打日志，不让插件起不来。
 *
 * 画像里可以出现 `cleanupTemplates`，用于删除设计期留下的示例模板（例如
 * `tpl-battery-alert`）；删除前仍由 `removeTemplateIfUnused` 检查有没有单据在用。
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../store/db.ts'
import type { IdFactory } from '../domain/ids.ts'
import { insertMember, type CreateMemberInput } from './members.ts'
import { insertProject, type MetricInput } from './projects.ts'
import { insertWorkItem } from './work-item-create.ts'
import { KnowledgeService } from './knowledge.ts'
import { removeTemplateIfUnused, upsertTemplate, STARTER_TEMPLATE, type TemplateDefinition } from './templates.ts'
import { writeAudit, writeEvent } from './audit.ts'

const DAY = 86_400_000
const DEFAULT_DOC_STATUS = 'published' as const

export interface ProfileMember {
  key: string
  kind: 'human' | 'bot'
  name: string
  role?: string
  domain?: string
  responsibility?: string
  positionId?: string
  capabilities?: string[]
}

export interface ProfileMetric extends MetricInput {
  /** 画像里用指标名引用；落库后换成 metric_id。 */
  observations?: { value: number | null; sourceRef?: string }[]
}

export interface ProfileProject {
  key: string
  name: string
  type: 'one_off' | 'continuous'
  status?: 'draft' | 'active'
  goalText: string
  coordinatorKey?: string
  metrics?: ProfileMetric[]
}

export interface ProfileWorkItem {
  key: string
  projectKey?: string
  title: string
  domain: string
  category: string
  priority?: number
  dueInDays?: number
  source?: string
}

export interface ProfileDoc {
  path: string
  title?: string
}

export interface WorkspaceProfile {
  version: number
  generatedAt?: string
  workspaceRoot?: string
  template?: TemplateDefinition
  members?: ProfileMember[]
  projects?: ProfileProject[]
  workItems?: ProfileWorkItem[]
  docs?: ProfileDoc[]
  overview?: { title: string; body: string }
  cleanupTemplates?: string[]
}

export interface WorkspaceProfileReport {
  status: 'missing' | 'unchanged' | 'applied' | 'failed'
  file: string
  hash: string | null
  workspaceRoot: string | null
  created: {
    template: boolean
    members: number
    projects: number
    workItems: number
    docs: number
    observations: number
    skills: number
    tables: number
    removedTemplates: number
  }
  errors: string[]
  /** 不阻止记录哈希的告警（例如还没有技能目录）。 */
  warnings: string[]
}

function blankReport(file: string, status: WorkspaceProfileReport['status']): WorkspaceProfileReport {
  return {
    status,
    file,
    hash: null,
    workspaceRoot: null,
    created: {
      template: false,
      members: 0,
      projects: 0,
      workItems: 0,
      docs: 0,
      observations: 0,
      skills: 0,
      tables: 0,
      removedTemplates: 0,
    },
    errors: [],
    warnings: [],
  }
}

export function defaultProfilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'workspace-profile.json')
}

function readProfile(file: string): { profile: WorkspaceProfile; hash: string; raw: string } {
  const raw = readFileSync(file, 'utf8')
  const hash = createHash('sha256').update(raw).digest('hex')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`画像不是合法 JSON：${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('画像必须是 JSON 对象')
  const profile = parsed as WorkspaceProfile
  if (profile.version !== 1) throw new Error(`画像版本不支持：${String(profile.version)}，当前只支持 1`)
  if (profile.template && !profile.template.key) throw new Error('template.key 不能为空')
  return { profile, hash, raw }
}

export interface ApplyWorkspaceProfileOptions {
  db: DatabaseSync
  dataDir: string
  operatorId: string
  now?: number
  idFactory: IdFactory
  file?: string
  /** 覆盖画像里的 workspaceRoot（测试或换机器时用）。 */
  workspaceRoot?: string
  /** 知识屏的真实技能目录；不传就只同步业务表。 */
  skillDirs?: string[]
}

/**
 * 读取并应用工作区画像。整个应用过程在一个 `BEGIN IMMEDIATE` 里；
 * 任何一类内容出错只记 error，不中断其它类别；最后写审计与哈希。
 */
export function applyWorkspaceProfile(options: ApplyWorkspaceProfileOptions): WorkspaceProfileReport {
  const now = options.now ?? Date.now()
  const file = path.resolve(options.file ?? defaultProfilePath(options.dataDir))
  if (!existsSync(file)) return blankReport(file, 'missing')

  let loaded: { profile: WorkspaceProfile; hash: string }
  try {
    loaded = readProfile(file)
  } catch (error) {
    const report = blankReport(file, 'failed')
    report.errors.push((error as Error).message)
    return report
  }
  const { profile, hash } = loaded
  const workspaceRoot = path.resolve(options.workspaceRoot ?? profile.workspaceRoot ?? process.cwd())
  const prior = options.db
    .prepare("SELECT value FROM hams_meta WHERE key = 'workspace_profile_sha256'")
    .get() as { value: string } | undefined
  const report = blankReport(file, 'applied')
  report.hash = hash
  report.workspaceRoot = workspaceRoot
  if (prior?.value === hash) {
    report.status = 'unchanged'
    return report
  }

  const knowledge = new KnowledgeService({
    db: options.db,
    now: () => now,
    idFactory: options.idFactory,
    dataDir: options.dataDir,
    skillDirs: options.skillDirs,
  })

  try {
    transaction(options.db, () => {
      const templateKey = (profile.template ?? STARTER_TEMPLATE).key
      const templateBefore = options.db
        .prepare('SELECT published_version_id FROM work_template WHERE key = ?')
        .get(templateKey) as { published_version_id: string | null } | undefined
      const templateVersionId = upsertTemplate(
        options.db,
        options.operatorId,
        now,
        profile.template ?? STARTER_TEMPLATE,
      )
      report.created.template = !templateBefore?.published_version_id

      // 1) 成员：按名字去重；bot 责任人固定为本机操作者。
      const memberIds = new Map<string, string>()
      for (const member of profile.members ?? []) {
        const existing = options.db.prepare('SELECT id FROM member WHERE name = ?').get(member.name) as
          | { id: string }
          | undefined
        if (existing) {
          memberIds.set(member.key, existing.id)
          continue
        }
        try {
          const input: CreateMemberInput = {
            kind: member.kind,
            name: member.name,
            role: member.role,
            domain: member.domain,
            responsibility: member.responsibility,
            positionId: member.positionId,
            ownerHumanId: member.kind === 'bot' ? options.operatorId : undefined,
            capabilities: member.capabilities,
          }
          const created = insertMember(options.db, options.idFactory, now, options.operatorId, input)
          memberIds.set(member.key, created.id)
          report.created.members += 1
        } catch (error) {
          report.errors.push(`成员「${member.name}」：${(error as Error).message}`)
        }
      }

      // 2) 项目：按名字去重；指标随目标版本一起建，读数按名称回填。
      const projectIds = new Map<string, string>()
      for (const project of profile.projects ?? []) {
        const existing = options.db.prepare('SELECT id FROM project WHERE name = ? AND deleted_at IS NULL').get(project.name) as
          | { id: string }
          | undefined
        if (existing) {
          projectIds.set(project.key, existing.id)
          continue
        }
        try {
          const metrics = (project.metrics ?? []).map((metric) => ({
            name: metric.name,
            direction: metric.direction,
            targetValue: metric.targetValue,
            targetMax: metric.targetMax,
            unit: metric.unit,
            windowKind: metric.windowKind,
            definitionText: metric.definitionText,
            sourceKind: metric.sourceKind,
          }))
          const created = insertProject(options.db, options.idFactory, now, options.operatorId, {
            name: project.name,
            type: project.type,
            goalText: project.goalText,
            coordinatorId: project.coordinatorKey ? memberIds.get(project.coordinatorKey) ?? null : null,
            metrics,
            publish: project.status !== 'draft',
          })
          projectIds.set(project.key, created.id)
          report.created.projects += 1

          for (const metric of project.metrics ?? []) {
            const metricRow = options.db
              .prepare('SELECT id FROM project_metric WHERE project_id = ? AND name = ?')
              .get(created.id, metric.name) as { id: string } | undefined
            if (!metricRow) continue
            for (const observation of metric.observations ?? []) {
              const exists = options.db
                .prepare('SELECT 1 AS ok FROM metric_observation WHERE metric_id = ? AND source_ref = ? LIMIT 1')
                .get(metricRow.id, observation.sourceRef ?? '') as { ok: number } | undefined
              if (exists) continue
              options.db
                .prepare(
                  `INSERT INTO metric_observation
                     (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  options.idFactory(),
                  metricRow.id,
                  now,
                  now,
                  now,
                  observation.value,
                  observation.sourceRef ?? null,
                  now,
                )
              report.created.observations += 1
            }
          }
        } catch (error) {
          report.errors.push(`项目「${project.name}」：${(error as Error).message}`)
        }
      }

      // 3) 工作项：按 profile:<key> 去重；负责人是本机操作者，绑通用模板。
      for (const item of profile.workItems ?? []) {
        const dedupeKey = `profile:${item.key}`
        const existing = options.db.prepare('SELECT id FROM work_item WHERE dedupe_key = ?').get(dedupeKey) as
          | { id: string }
          | undefined
        if (existing) continue
        try {
          const projectId = item.projectKey ? projectIds.get(item.projectKey) ?? null : null
          const inserted = insertWorkItem(
            { db: options.db, ids: options.idFactory, now: () => now, timeZone: 'Asia/Shanghai' },
            {
              domain: item.domain,
              category: item.category,
              title: item.title,
              ownerHumanId: options.operatorId,
              projectId,
              templateVersionId,
              dedupeKey,
              priority: item.priority,
              dueAt: now + (item.dueInDays ?? 7) * DAY,
              createdBy: options.operatorId,
              actorKind: 'human',
            },
          )
          if (item.source) {
            writeEvent(options.db, options.idFactory(), {
              workItemId: inserted.id,
              kind: 'profile_source',
              actorId: options.operatorId,
              actorKind: 'human',
              payload: { source: item.source },
              revision: inserted.revision,
              executionEpoch: inserted.execution_epoch,
              at: now,
            })
          }
          report.created.workItems += 1
        } catch (error) {
          report.errors.push(`工作项「${item.title}」：${(error as Error).message}`)
        }
      }

      // 4) 文档：登记绝对路径 + 内容哈希，不复制正文。
      for (const doc of profile.docs ?? []) {
        const absolute = path.isAbsolute(doc.path) ? doc.path : path.join(workspaceRoot, doc.path)
        if (!existsSync(absolute)) {
          report.errors.push(`文档不存在：${absolute}`)
          continue
        }
        try {
          const outcome = knowledge.importFile(options.operatorId, absolute, {
            title: doc.title,
            status: DEFAULT_DOC_STATUS,
          })
          if (outcome !== 'skipped') report.created.docs += 1
        } catch (error) {
          report.errors.push(`文档「${doc.title ?? doc.path}」：${(error as Error).message}`)
        }
      }

      // 5) 画像自带的总览：面板内撰写，不进源文件。
      if (profile.overview?.title && profile.overview?.body) {
        const exists = options.db
          .prepare("SELECT 1 AS ok FROM kb_doc WHERE title = ? AND source_kind = 'hams' LIMIT 1")
          .get(profile.overview.title) as { ok: number } | undefined
        if (!exists) {
          try {
            knowledge.createDoc(options.operatorId, {
              title: profile.overview.title,
              body: profile.overview.body,
              status: 'draft',
            })
            report.created.docs += 1
          } catch (error) {
            report.errors.push(`总览文档：${(error as Error).message}`)
          }
        }
      }

      // 6) 真实技能与业务表结构：与知识屏「同步真实数据」同一条路径。
      try {
        const sync = knowledge.sync(options.operatorId)
        report.created.skills = sync.skills.created + sync.skills.updated
        report.created.tables = sync.tables.created + sync.tables.updated
        report.warnings.push(...sync.skills.errors.slice(0, 5))
        report.warnings.push(...sync.tables.errors.slice(0, 5))
      } catch (error) {
        report.warnings.push(`知识同步：${(error as Error).message}`)
      }

      // 7) 清理设计期示例模板（有单据引用时保留）。
      for (const legacy of profile.cleanupTemplates ?? []) {
        if (removeTemplateIfUnused(options.db, legacy)) report.created.removedTemplates += 1
      }

      writeAudit(options.db, options.idFactory(), {
        actorId: 'system',
        actorKind: 'system',
        channel: 'system',
        action: 'workspace/profileApplied',
        subjectKind: 'workspace_profile',
        subjectId: hash,
        after: { file, workspaceRoot, created: report.created, errors: report.errors.length },
        correlationId: `profile-${hash.slice(0, 12)}`,
        at: now,
      })

      // 有错时不记哈希：下次启动会再试一次；已落库的内容按去重键跳过，不会重复。
      if (!report.errors.length) {
        options.db
          .prepare(
            `INSERT INTO hams_meta (key, value) VALUES ('workspace_profile_sha256', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(hash)
        options.db
          .prepare(
            `INSERT INTO hams_meta (key, value) VALUES ('workspace_profile_applied_at', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(String(now))
      }
    })
  } catch (error) {
    report.status = 'failed'
    report.errors.push((error as Error).message)
  }
  return report
}
