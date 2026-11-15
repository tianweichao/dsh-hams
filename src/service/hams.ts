/**
 * HAMS 领域命令层（M3 最小闭环）。
 *
 * 只做「一条闭环」需要的命令，但每条命令都落在 backend-design §7 的事务边界里：
 *
 *   T1 建任务（告警入站）      ingestAlert
 *   T4 提议采纳并落单          propose → decideProposal
 *   T2 认领                    claim（bot）/ accept（人）
 *   T3 运行开始 / 结束          startRun / submitResult
 *   T8 追加证据                appendEvidence
 *   T6 审批请求                requestClosure
 *   T7 / T5 审批决定与关单      decideApproval
 *   T9 暂停 / 恢复 / 取消等     pause / resume / cancel / reopen / retry
 *   复查判定                    evaluateCheck
 *
 * 纪律：
 * - 一个命令 = 一个 `BEGIN IMMEDIATE` 事务；内部 `*Tx` 方法假定事务已开，不再开事务；
 * - 主体只从 `ctx.principalId` 解析，参数里没有 memberId 可以伪造；
 * - 业务失败抛 `HamsError`（带 15 类错误码之一），调用方（HTTP / 工具）负责转成回执；
 * - 所有写命令都写事件、变更游标与审计；审计与业务行同事务，失败一起回滚。
 *
 * 还没做的：tick 调度、租约心跳回收、outbox 派发、recover() 对账（M4），
 * 以及 HTTP 进站校验与工具注册（M5）。
 */
import type { DatabaseSync } from 'node:sqlite'
import * as lifecycle from './project-lifecycle.ts'
import { publishConfig, memberActivity, type PublishConfigInput } from './member-config.ts'
import { createHash } from 'node:crypto'
import { HamsError, denied, evidenceIncomplete, stateInvalid } from '../domain/errors.ts'
import { createIdFactory, type IdFactory } from '../domain/ids.ts'
import {
  buildCriteriaSnapshot,
  evidenceSetHash,
  parseEvidenceRequirements,
  type CriteriaSnapshot,
  type EvidenceSnapshotRow,
} from '../domain/evidence.ts'
import {
  nextCheckAt,
  parseCheckPolicy,
  parseReviewPolicy,
  type CheckPolicy,
  type ReviewPolicy,
} from '../domain/check.ts'
import { CAPABILITY, requireBot, requireCapability, requireHuman, resolvePrincipal } from './permissions.ts'
import {
  clearProjectDraft,
  getProject as queryProject,
  insertProject as insertProjectRow,
  listProjects as queryProjects,
  recordObservation as insertObservation,
  saveProjectDraft as persistProjectDraft,
  setProjectStatus as applyProjectStatus,
  softDeleteProject,
  type CreateProjectInput,
  type ObservationInput,
  type ProjectDetail,
  type ProjectSummary,
  type SaveDraftInput,
} from './projects.ts'
import { ensureDefaultAnalystInProject } from './defaults.ts'
import {
  createMemory,
  listMemberMemories as queryMemberMemories,
  listProjectMemories as queryProjectMemories,
  updateMemory,
  type CreateMemoryInput,
} from './memory.ts'
import {
  getMember as queryMember,
  insertMember as insertMemberRow,
  listMembers as queryMembers,
  listPositions as queryPositions,
  setMemberStatus as applyMemberStatus,
  type CreateMemberInput,
  type MemberDetail,
  type MemberSummary,
  type PositionSummary,
} from './members.ts'
import {
  KnowledgeService,
  type DocDetail,
  type ImportReport,
  type KnowledgeItem,
  type KnowledgeListResult,
  type SkillDetail,
  type SyncReport,
  type TableDetail,
} from './knowledge.ts'
import { insertWorkItem, type WorkItemFactory } from './work-item-create.ts'
import { writeAudit, writeChange, writeEvent } from './audit.ts'
import { hashPayload, loadReceipt, receiptScopeKey, saveReceipt } from './receipts.ts'
import type {
  ApprovalRow,
  CheckRow,
  CommandContext,
  CommandReceipt,
  EvidenceRow,
  Principal,
  ProposalRow,
  RunRow,
  TemplateRow,
  TemplateVersionRow,
  ThreadRow,
  WorkItemRow,
} from './types.ts'

const TERMINAL_ITEM_STATUSES = ['completed', 'failed', 'cancelled'] as const
// 与库里的部分唯一索引 uq_wi_dedupe 保持同一判据：只排除 completed / cancelled。
// 漏掉 failed 会让「按 dedupe 查不到、插入又被索引拒绝」变成 SQLITE_ERROR。
const OPEN_ITEM_STATUSES = [
  'ready',
  'active',
  'waiting_check',
  'waiting_review',
  'blocked',
  'paused',
  'failed',
] as const

export interface HamsServiceOptions {
  db: DatabaseSync
  now?: () => number
  runtimeEpoch?: number
  idFactory?: IdFactory
  /** 预算按哪个时区切日/周（项目本身还没有时区列，先用部署时区）。 */
  timeZone?: string
  /** 具名判据验证器的注册表；找不到就失败关闭。 */
  validators?: Record<string, Validator>
  /**
   * 知识屏的真实数据源。`dataDir` 是 HAMS 数据目录（面板撰写的文档落在其下）；
   * `skillDirs` 默认由宿主适配器填成 `$DSH_HOME/skills`，测试里可指向临时目录。
   */
  knowledge?: { dataDir: string; skillDirs?: string[] }
}

export type Validator = (input: {
  workItem: WorkItemRow
  evidence: EvidenceRow[]
  params: Record<string, unknown>
  now: number
}) => { passed: boolean; detail?: unknown }

export interface IngestAlertInput {
  connector: string
  externalEventId: string
  eventType: string
  severity?: number
  occurredAt: number
  payloadRef: string
  payloadHash?: string
  asset: { externalSystem: string; externalId: string; displayName: string; kind?: string }
  workItem: {
    domain: string
    category: string
    title: string
    projectId?: string | null
    ownerHumanId: string
    templateVersionId?: string | null
    dedupeKey: string
    priority?: number
    dueAt?: number | null
  }
}

export interface CreateWorkItemTxInput {
  domain: string
  category: string
  title: string
  ownerHumanId: string
  projectId?: string | null
  templateVersionId?: string | null
  assetId?: string | null
  dedupeKey?: string | null
  priority?: number
  dueAt?: number | null
  createdBy: string
}

export interface CreateWorkItemCommandInput {
  domain: string
  category: string
  title: string
  ownerHumanId?: string
  projectId?: string | null
  templateVersionId?: string | null
  assetId?: string | null
  dedupeKey?: string | null
  priority?: number
  dueAt?: number | null
}

export interface ProposeInput {
  kind: 'create_task' | 'upgrade_task' | 'permission_request' | 'scope_change' | 'knowledge_change'
  subjectKey: string
  dedupeKey: string
  deciderId: string
  title: string
  body: string
  rationale: { evidence: unknown[]; expectedEffect?: string; cost?: unknown }
  impact?: Record<string, unknown>
  projectId?: string | null
  workItemId?: string | null
  expiresAt?: number | null
}

export interface DecideProposalInput {
  proposalId: string
  decision: 'accept' | 'reject'
  note: string
  workItem?: {
    domain: string
    category: string
    title: string
    ownerHumanId: string
    projectId?: string | null
    templateVersionId?: string | null
    assetId?: string | null
    dueAt?: number | null
  }
}

export interface ClaimInput {
  workItemId: string
  /** 宿主会话 id；新建线程时必填，复用现有 active 线程时忽略。 */
  sessionId?: string
  leaseMinutes?: number
}

export interface AppendEvidenceInput {
  workItemId: string
  kind: string
  ref: string
  observedAt: number
  contentHash?: string
  source?: string
  runId?: string | null
  onBehalfOf?: string | null
  supersedesId?: string | null
}

export interface RequestClosureInput {
  workItemId: string
  reason: string
}

export interface DecideApprovalInput {
  approvalId: string
  decision: 'approve' | 'reject' | 'return'
  note?: string
}

export interface EvaluateCheckInput {
  checkId: string
}

export interface SubmitResultInput {
  runId: string
  summary: string
}

export class HamsService {
  private db: DatabaseSync
  private now: () => number
  private runtimeEpoch: number
  private id: IdFactory
  private timeZone: string
  private validators: Record<string, Validator>
  private knowledgeService: KnowledgeService | null

  constructor(options: HamsServiceOptions) {
    this.db = options.db
    this.now = options.now ?? (() => Date.now())
    this.id = options.idFactory ?? createIdFactory(this.now)
    this.timeZone = options.timeZone ?? 'Asia/Shanghai'
    this.validators = options.validators ?? {}
    this.runtimeEpoch = options.runtimeEpoch ?? this.readRuntimeEpoch()
    this.knowledgeService = options.knowledge?.dataDir
      ? new KnowledgeService({
          db: this.db,
          now: this.now,
          idFactory: this.id,
          dataDir: options.knowledge.dataDir,
          skillDirs: options.knowledge.skillDirs,
        })
      : null
  }

  // ───────────────────────── 读 ─────────────────────────

  whoami(ctx: CommandContext): { principal: Omit<Principal, 'capabilities'>; capabilities: string[] } {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const { capabilities, ...rest } = principal
    return { principal: rest, capabilities: [...capabilities].sort() }
  }

  getWorkItem(ctx: CommandContext, workItemId: string) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const item = this.workItemOrThrow(workItemId)
    const all = (table: string) => this.db.prepare(`SELECT * FROM ${table} WHERE work_item_id=? ORDER BY rowid`).all(item.id)
    const threads = all('work_item_thread') as ThreadRow[]
    const thread = threads.find(t => t.status === 'active' || t.status === 'pending_rotate') ?? null
    const templateVersion = this.templateVersionTx(item.template_version_id)
    return { ...item, allowedActions: this.allowedActions(principal, item),
      events: all('work_item_event'), evidence: all('evidence'), runs: all('task_run'),
      approvals: this.db.prepare("SELECT * FROM approval WHERE subject_id=? AND subject_kind='work_item_close' ORDER BY created_at DESC").all(item.id),
      checks: all('work_item_check'), threads, thread, current_thread: thread, templateVersion,
      criteriaSnapshot: templateVersion ? { templateVersionId: templateVersion.id, requiredEvidence: JSON.parse(templateVersion.required_evidence_json), validatorKey: templateVersion.validator_key, validatorParams: JSON.parse(templateVersion.validator_params_json), checkPolicy: JSON.parse(templateVersion.check_policy_json), reviewPolicy: JSON.parse(templateVersion.review_policy_json) } : null,
      canEvaluateCheck: principal.capabilities.has(CAPABILITY.checkEvaluate) && item.status !== 'paused',
    }
  }

  listWorkItems(
    ctx: CommandContext,
    filter: { status?: string; assigneeId?: string; ownerId?: string; projectId?: string; domain?: string; limit?: number } = {},
  ): WorkItemRow[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.assigneeId) {
      clauses.push('assignee_id = ?')
      params.push(filter.assigneeId)
    }
    if (filter.ownerId) {
      clauses.push('owner_human_id = ?')
      params.push(filter.ownerId)
    }
    for (const [field,column] of [['projectId','project_id'],['domain','domain']] as const) {
      if (filter[field]) { clauses.push(`${column} = ?`); params.push(filter[field]) }
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM work_item ${where} ORDER BY updated_at DESC LIMIT ${limit}`)
      .all(...(params as never[])) as WorkItemRow[]
  }

  listApprovals(ctx: CommandContext, filter: { approverId?: string; status?: string } = {}): ApprovalRow[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.approverId) {
      clauses.push('approver_id = ?')
      params.push(filter.approverId)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM approval ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...(params as never[])) as ApprovalRow[]
  }

  /** 诊断页 / ops/health 用：只读计数，不触发任何写。 */
  health(ctx: CommandContext): {
    schemaVersion: number
    runtimeEpoch: number
    now: number
    counts: {
      workItems: number
      openWorkItems: number
      pendingApprovals: number
      activeRuns: number
      dueChecks: number
      leases: number
    }
  } {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const count = (sql: string, ...params: (string | number)[]): number =>
      Number((this.db.prepare(sql).get(...params) as { c: number }).c)
    return {
      schemaVersion: Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      runtimeEpoch: this.runtimeEpoch,
      now: this.now(),
      counts: {
        workItems: count('SELECT COUNT(*) AS c FROM work_item'),
        openWorkItems: count("SELECT COUNT(*) AS c FROM work_item WHERE status NOT IN ('completed','cancelled')"),
        pendingApprovals: count("SELECT COUNT(*) AS c FROM approval WHERE status = 'pending'"),
        activeRuns: count("SELECT COUNT(*) AS c FROM task_run WHERE status IN ('queued','running')"),
        dueChecks: count("SELECT COUNT(*) AS c FROM work_item_check WHERE status = 'scheduled' AND planned_due_at <= ?", this.now()),
        leases: count('SELECT COUNT(*) AS c FROM lease'),
      },
    }
  }

  listChecks(ctx: CommandContext, workItemId: string): CheckRow[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    return this.db
      .prepare('SELECT * FROM work_item_check WHERE work_item_id = ? ORDER BY generation DESC')
      .all(workItemId) as CheckRow[]
  }

  /**
   * 模板目录（只读）：建单要绑一个**已发布**的判据版本，否则申请关单会被拒。
   *
   * 只返回已发布版本；草稿/退役版本对界面没有意义（建单也选不了）。
   * 没有模板时返回空数组，界面要显式提示「先配模板」，而不是让人建出关不掉单。
   */
  listTemplates(ctx: CommandContext, filter: { domain?: string } = {}): (TemplateRow & {
    version: number | null
    version_status: string | null
    required_evidence_json: string | null
    check_policy_json: string | null
    review_policy_json: string | null
  })[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const where = filter.domain ? 'WHERE t.domain = ?' : ''
    const params: unknown[] = filter.domain ? [filter.domain] : []
    return this.db
      .prepare(
        `SELECT t.id, t.key, t.name, t.domain, t.category, t.published_version_id,
                v.version, v.status AS version_status, v.required_evidence_json,
                v.check_policy_json, v.review_policy_json
           FROM work_template t
           LEFT JOIN work_template_version v ON v.id = t.published_version_id
           ${where}
          ORDER BY t.name`,
      )
      .all(...(params as never[])) as never
  }

  listProposals(
    ctx: CommandContext,
    filter: { deciderId?: string; status?: string; limit?: number } = {},
  ): ProposalRow[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.deciderId) {
      clauses.push('decider_id = ?')
      params.push(filter.deciderId)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    for (const [field,column] of [['projectId','project_id'],['domain','domain']] as const) {
      if (filter[field]) { clauses.push(`${column} = ?`); params.push(filter[field]) }
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    return this.db
      .prepare(`SELECT * FROM proposal ${where} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(...(params as never[])) as ProposalRow[]
  }

  /**
   * 总览读模型（画板 ①）：待我把关、到期复查、执行与异常、状态计数。
   * 只读、不写审计；界面用「快照 + changes/since 游标」增量刷新。
   */
  overview(ctx: CommandContext): {
    principalId: string
    generatedAt: number
    counts: { byStatus: Record<string, number>; myOpen: number; attention: number; activeRuns: number }
    approvals: ApprovalRow[]
    proposals: ProposalRow[]
    reviews: Record<string, any>[]
    dueChecks: (CheckRow & { title: string })[]
    attention: { id: string; workItemId: string | null; reason: string; detail: string; createdAt: number }[]
    executions: { runId: string; workItemId: string; title: string; status: string; memberId: string; startedAt: number | null }[]
    latestChangeSeq: number
  } {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const at = this.now()
    const byStatusRows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM work_item GROUP BY status')
      .all() as { status: string; c: number }[]
    const byStatus: Record<string, number> = {}
    for (const row of byStatusRows) byStatus[row.status] = Number(row.c)

    const myOpen = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM work_item
              WHERE (owner_human_id = ? OR assignee_id = ?) AND status NOT IN ('completed','cancelled')`,
          )
          .get(principal.memberId, principal.memberId) as { c: number }
      ).c,
    )

    const approvals = this.db
      .prepare(
        `SELECT * FROM approval WHERE approver_id = ? AND status = 'pending'
          ORDER BY expires_at LIMIT 50`,
      )
      .all(principal.memberId) as ApprovalRow[]

    const proposals = this.db
      .prepare(
        `SELECT * FROM proposal WHERE decider_id = ? AND status = 'open'
          ORDER BY created_at LIMIT 50`,
      )
      .all(principal.memberId) as ProposalRow[]

    const dueChecks = this.db
      .prepare(
        `SELECT c.*, w.title AS title FROM work_item_check c
           JOIN work_item w ON w.id = c.work_item_id
          WHERE c.status = 'scheduled' AND c.planned_due_at <= ?
            AND (w.owner_human_id = ? OR w.assignee_id = ?)
          ORDER BY c.planned_due_at LIMIT 50`,
      )
      .all(at, principal.memberId, principal.memberId) as (CheckRow & { title: string })[]

    const attention = this.db
      .prepare(
        `SELECT id, work_item_id AS workItemId, reason, detail, created_at AS createdAt
           FROM attention_item WHERE to_member_id = ? AND resolved_at IS NULL
          ORDER BY created_at DESC LIMIT 50`,
      )
      .all(principal.memberId) as { id: string; workItemId: string | null; reason: string; detail: string; createdAt: number }[]

    const executions = this.db
      .prepare(
        `SELECT r.id AS runId, r.work_item_id AS workItemId, w.title AS title, r.status AS status,
                r.member_id AS memberId, r.started_at AS startedAt
           FROM task_run r JOIN work_item w ON w.id = r.work_item_id
          WHERE r.status IN ('queued','running')
            AND (w.owner_human_id = ? OR w.assignee_id = ?)
          ORDER BY r.created_at DESC LIMIT 50`,
      )
      .all(principal.memberId, principal.memberId) as {
      runId: string
      workItemId: string
      title: string
      status: string
      memberId: string
      startedAt: number | null
    }[]

    const latestChangeSeq = Number(
      (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').get() as { seq: number }).seq,
    )

    return {
      principalId: principal.memberId,
      generatedAt: at,
      counts: {
        byStatus,
        myOpen,
        attention: attention.length,
        activeRuns: Number(
          (this.db.prepare("SELECT COUNT(*) AS c FROM task_run WHERE status IN ('queued','running')").get() as { c: number }).c,
        ),
      },
      approvals,
      proposals,
      reviews: this.db.prepare("SELECT r.*, r.project_id AS projectId, p.name AS projectName FROM project_review r JOIN project p ON p.id=r.project_id WHERE r.status='awaiting_confirm' AND r.confirmer_id=? ORDER BY r.period_end DESC").all(principal.memberId),
      dueChecks,
      attention,
      executions,
      latestChangeSeq,
    }
  }

  /**
   * 变更游标（画板 ㉑ 第 6 格）：只读 change_log；游标超出保留期返回 CURSOR_EXPIRED。
   * 保留期暂按「最早一条的 seq - 1」判断：有人归档/清理过旧行就算过期。
   */
  changesSince(
    ctx: CommandContext,
    input: { cursor?: number; limit?: number } = {},
  ): {
    cursor: number
    nextCursor: number
    latestCursor: number
    hasMore: boolean
    items: { seq: number; objectKind: string; objectId: string; revision: number; changeKind: string; createdAt: number }[]
  } {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const cursor = Math.max(0, Math.floor(input.cursor ?? 0))
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500)
    const bounds = this.db
      .prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM change_log')
      .get() as { minSeq: number | null; maxSeq: number | null }
    const minSeq = bounds.minSeq === null ? 0 : Number(bounds.minSeq)
    const latestCursor = bounds.maxSeq === null ? 0 : Number(bounds.maxSeq)
    if (minSeq > 0 && cursor < minSeq - 1) {
      throw new HamsError('CURSOR_EXPIRED', `游标 ${cursor} 早于保留期（最早 ${minSeq}），请重新拉取快照`, {
        nextStep: '重新获取 overview/get 快照后再用新游标增量',
      })
    }
    const rows = this.db
      .prepare(
        `SELECT seq, object_kind AS objectKind, object_id AS objectId, revision,
                change_kind AS changeKind, created_at AS createdAt
           FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(cursor, limit) as {
      seq: number
      objectKind: string
      objectId: string
      revision: number
      changeKind: string
      createdAt: number
    }[]
    const nextCursor = rows.length ? Number(rows[rows.length - 1].seq) : cursor
    return {
      cursor,
      nextCursor,
      latestCursor,
      hasMore: nextCursor < latestCursor,
      items: rows.map((row) => ({ ...row, seq: Number(row.seq), revision: Number(row.revision) })),
    }
  }

  // ───────────────────────── 人工建单 ─────────────────────────

  createWorkItem(ctx: CommandContext, input: CreateWorkItemCommandInput): CommandReceipt {
    return this.command(ctx, 'workItem/create', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.workItemCreate)
      if (principal.kind === 'bot') throw denied('bot 建单必须走提议，不能直接建单')
      const ownerHumanId = input.ownerHumanId ?? principal.memberId
      if (input.dedupeKey) {
        const open = this.findOpenByDedupeKey(input.dedupeKey)
        if (open) {
          const auditId = this.audit(ctx, principal, {
            action: 'workItem/create',
            subjectKind: 'work_item',
            subjectId: open.id,
            after: { duplicate: true, dedupeKey: input.dedupeKey },
          })
          return this.receipt(ctx, {
            status: 'accepted',
            objectId: open.id,
            objectRevision: open.revision,
            executionEpoch: open.execution_epoch,
            auditId,
            detail: { duplicate: true, dedupeKey: input.dedupeKey },
          })
        }
      }
      const item = this.createWorkItemTx(ctx, principal, {
        domain: input.domain,
        category: input.category,
        title: input.title,
        ownerHumanId,
        projectId: input.projectId ?? null,
        templateVersionId: input.templateVersionId ?? null,
        assetId: input.assetId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        createdBy: principal.memberId,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'workItem/create',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { title: item.title, dedupeKey: item.dedupe_key },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.execution_epoch,
        auditId,
        detail: { dedupeKey: item.dedupe_key },
      })
    })
  }

  // ───────────────────────── T1 建任务 ─────────────────────────

  ingestAlert(ctx: CommandContext, input: IngestAlertInput): CommandReceipt {
    return this.command(ctx, 'work_item/ingestAlert', input, () => {
      const principal = this.principal(ctx)
      if (principal.kind !== 'system') requireCapability(principal, CAPABILITY.connectorIngest)
      const at = this.now()

      const existingEvent = this.db
        .prepare('SELECT * FROM event_inbox WHERE connector = ? AND external_event_id = ?')
        .get(input.connector, input.externalEventId) as
        | { id: string; work_item_id: string | null; disposition: string }
        | undefined
      if (existingEvent) {
        const existingItem = existingEvent.work_item_id ? this.workItemOrThrow(existingEvent.work_item_id) : null
        const auditId = this.audit(ctx, principal, {
          action: 'work_item/ingestAlert',
          subjectKind: 'event_inbox',
          subjectId: existingEvent.id,
          after: { disposition: existingEvent.disposition, duplicate: true },
        })
        return this.receipt(ctx, {
          status: 'accepted',
          objectId: existingItem?.id,
          objectRevision: existingItem?.revision,
          executionEpoch: existingItem?.execution_epoch,
          auditId,
          detail: { duplicate: true, disposition: existingEvent.disposition, eventId: existingEvent.id },
        })
      }

      const eventId = this.id()
      const assetId = this.upsertAsset(input.asset)
      this.db
        .prepare(
          `INSERT INTO event_inbox
             (id, connector, external_event_id, asset_id, event_type, severity, payload_ref, payload_hash,
              occurred_at, received_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
        )
        .run(
          eventId,
          input.connector,
          input.externalEventId,
          assetId,
          input.eventType,
          input.severity ?? 0,
          input.payloadRef,
          input.payloadHash ?? createHash('sha256').update(`${input.connector}:${input.externalEventId}`).digest('hex'),
          input.occurredAt,
          at,
        )

      const open = this.findOpenByDedupeKey(input.workItem.dedupeKey)
      if (open) {
        this.db
          .prepare("UPDATE event_inbox SET work_item_id = ?, disposition = 'attached' WHERE id = ?")
          .run(open.id, eventId)
        const auditId = this.audit(ctx, principal, {
          action: 'work_item/ingestAlert',
          subjectKind: 'work_item',
          subjectId: open.id,
          after: { disposition: 'attached', eventId },
        })
        return this.receipt(ctx, {
          status: 'accepted',
          objectId: open.id,
          objectRevision: open.revision,
          executionEpoch: open.execution_epoch,
          auditId,
          detail: { duplicate: true, disposition: 'attached', eventId },
        })
      }

      const item = this.createWorkItemTx(ctx, principal, {
        ...input.workItem,
        assetId,
        createdBy: principal.memberId,
      })
      this.db.prepare("UPDATE event_inbox SET work_item_id = ?, disposition = 'created' WHERE id = ?").run(item.id, eventId)
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/ingestAlert',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { eventId, dedupeKey: input.workItem.dedupeKey },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.executionEpoch,
        auditId,
        detail: { eventId, disposition: 'created' },
      })
    })
  }

  // ───────────────────────── T4 提议 → 采纳落单 ─────────────────────────

  propose(ctx: CommandContext, input: ProposeInput): CommandReceipt {
    return this.command(ctx, 'proposal/propose', input, () => {
      const principal = this.principal(ctx)
      requireBot(principal)
      requireCapability(principal, CAPABILITY.proposalCreate)
      if (!Array.isArray(input.rationale?.evidence) || input.rationale.evidence.length === 0) {
        throw denied('提议必须给出理由与证据；rationale.evidence 不能为空')
      }
      const decider = this.memberOrThrow(input.deciderId)
      if (decider.kind !== 'human') throw denied('提议只能由人决定；deciderId 必须是人')
      const at = this.now()

      const open = this.db
        .prepare(
          `SELECT * FROM proposal WHERE subject_key = ? AND kind = ? AND dedupe_key = ? AND status = 'open'`,
        )
        .get(input.subjectKey, input.kind, input.dedupeKey) as ProposalRow | undefined
      if (open) {
        this.db
          .prepare('UPDATE proposal SET duplicate_count = duplicate_count + 1, revision = revision + 1 WHERE id = ?')
          .run(open.id)
        writeChange(this.db, {
          objectKind: 'proposal',
          objectId: open.id,
          revision: open.revision + 1,
          changeKind: 'duplicate_proposal',
          at,
        })
        const auditId = this.audit(ctx, principal, {
          action: 'proposal/propose',
          subjectKind: 'proposal',
          subjectId: open.id,
          after: { duplicate: true, duplicateCount: open.duplicate_count + 1 },
        })
        return this.receipt(ctx, {
          status: 'accepted',
          objectId: open.id,
          auditId,
          detail: { duplicate: true, duplicateCount: open.duplicate_count + 1 },
        })
      }

      const proposalId = this.id()
      this.db
        .prepare(
          `INSERT INTO proposal
             (id, subject_key, project_id, work_item_id, kind, dedupe_key, proposed_by, decider_id, title, body,
              rationale_json, impact_json, status, duplicate_count, snoozed_until, expires_at, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, NULL, ?, 1, ?)`,
        )
        .run(
          proposalId,
          input.subjectKey,
          input.projectId ?? null,
          input.workItemId ?? null,
          input.kind,
          input.dedupeKey,
          principal.memberId,
          input.deciderId,
          input.title,
          input.body,
          JSON.stringify(input.rationale),
          JSON.stringify(input.impact ?? {}),
          input.expiresAt ?? null,
          at,
        )
      writeChange(this.db, { objectKind: 'proposal', objectId: proposalId, revision: 1, changeKind: 'proposal_created', at })
      const auditId = this.audit(ctx, principal, {
        action: 'proposal/propose',
        subjectKind: 'proposal',
        subjectId: proposalId,
        after: { kind: input.kind, title: input.title },
      })
      return this.receipt(ctx, { status: 'applied', objectId: proposalId, auditId })
    })
  }

  decideProposal(ctx: CommandContext, input: DecideProposalInput): CommandReceipt {
    return this.command(ctx, 'proposal/decide', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.proposalDecide)
      if (ctx.channel !== 'ui') throw denied('提议只能由人通过UI决定')
      const at = this.now()
      const proposal = this.db.prepare('SELECT * FROM proposal WHERE id = ?').get(input.proposalId) as ProposalRow | undefined
      if (!proposal) throw stateInvalid(`提议不存在：${input.proposalId}`)
      if (proposal.status !== 'open') throw stateInvalid(`提议已是终态：${proposal.status}`)
      if (proposal.decider_id !== principal.memberId) {
        throw denied('只有提议上写明的决定人可以决定')
      }
      if (input.decision === 'reject' && input.note.trim().length === 0) {
        throw stateInvalid('驳回必须写明原因')
      }

      this.db
        .prepare(
          `INSERT INTO decision (id, proposal_id, decided_by, decision, channel, note, created_at)
           VALUES (?, ?, ?, ?, 'ui', ?, ?)`,
        )
        .run(this.id(), proposal.id, principal.memberId, input.decision, input.note, at)

      let workItem: WorkItemRow | null = null
      if (input.decision === 'accept' && proposal.kind === 'create_task') {
        if (!input.workItem) throw stateInvalid('采纳提议必须给出要建的工作项内容')
        const existing = this.findOpenByDedupeKey(proposal.dedupe_key)
        workItem = existing ?? this.createWorkItemTx(ctx, principal, {
          ...input.workItem,
          dedupeKey: proposal.dedupe_key,
          createdBy: principal.memberId,
        })
        this.db
          .prepare(
            "UPDATE proposal SET status = 'accepted', result_work_item_id = ?, revision = revision + 1 WHERE id = ?",
          )
          .run(workItem.id, proposal.id)
      } else {
        if (input.workItem) throw stateInvalid('非创建任务提议不能附带建单内容；变更须通过对应受权命令执行')
        this.db.prepare('UPDATE proposal SET status = ?, revision = revision + 1 WHERE id = ?').run(input.decision === 'accept' ? 'accepted' : 'rejected', proposal.id)
      }

      writeChange(this.db, {
        objectKind: 'proposal',
        objectId: proposal.id,
        revision: proposal.revision + 1,
        changeKind: `proposal_${input.decision === 'accept' ? 'accepted' : 'rejected'}`,
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'proposal/decide',
        subjectKind: 'proposal',
        subjectId: proposal.id,
        after: { decision: input.decision, note: input.note, workItemId: workItem?.id ?? null },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: workItem?.id ?? proposal.id,
        objectRevision: workItem?.revision,
        executionEpoch: workItem?.execution_epoch,
        auditId,
        detail: { proposalId: proposal.id, decision: input.decision, workItemId: workItem?.id ?? null },
      })
    })
  }

  // ───────────────────────── T2 认领 ─────────────────────────

  claim(ctx: CommandContext, input: ClaimInput): CommandReceipt {
    return this.command(ctx, 'work_item/claim', input, () => {
      const principal = this.principal(ctx)
      requireBot(principal)
      // 系统派发替被指派的 bot 认领时，work_item.execute 就够：指派本身已经是人的动作，
      // 而种子里的执行 bot 不一定同时拿到 claim（例如数据巡检只有 execute）。
      if (ctx.channel === 'system') {
        const canClaim = principal.capabilities instanceof Set ? principal.capabilities.has(CAPABILITY.workItemClaim) : false
        if (!canClaim) requireCapability(principal, CAPABILITY.workItemExecute)
      } else {
        requireCapability(principal, CAPABILITY.workItemClaim)
      }
      const at = this.now()
      const before = this.workItemOrThrow(input.workItemId)
      if (before.status !== 'ready') {
        throw stateInvalid(`只有 ready 的工作项可以认领，当前 ${before.status}`, '刷新后重试')
      }

      const leaseMinutes = Math.min(Math.max(input.leaseMinutes ?? 10, 1), 120)
      const updated = this.db
        .prepare(
          `UPDATE work_item
              SET status = 'active', assignee_id = ?, revision = revision + 1,
                  execution_epoch = execution_epoch + 1, fence_seq = fence_seq + 1, updated_at = ?
            WHERE id = ? AND status = 'ready'`,
        )
        .run(principal.memberId, at, input.workItemId)
      if (updated.changes !== 1) throw stateInvalid('认领竞争失败：工作项状态已变化')

      const current = this.workItemOrThrow(input.workItemId)
      const thread = this.ensureThreadTx(principal, current, input.sessionId)
      const runId = this.id()
      this.db
        .prepare(
          `INSERT INTO task_run
             (id, work_item_id, thread_id, check_id, member_id, member_version, skill_versions_json,
              execution_epoch, runtime_epoch, fence, trigger, attempt, status, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, '{}', ?, ?, ?, 'claim', 1, 'queued', ?)`,
        )
        .run(
          runId,
          current.id,
          thread.id,
          principal.memberId,
          thread.member_version,
          current.execution_epoch,
          this.runtimeEpoch,
          current.fence_seq,
          at,
        )
      const leaseUntil = at + leaseMinutes * 60_000
      this.db
        .prepare(
          `INSERT INTO lease (work_item_id, holder_member_id, run_id, fence, runtime_epoch, lease_until, renewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(current.id, principal.memberId, runId, current.fence_seq, this.runtimeEpoch, leaseUntil, at)

      writeEvent(this.db, this.id(), {
        workItemId: current.id,
        kind: 'work_item_claimed',
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { runId, threadId: thread.id, fence: current.fence_seq, executionEpoch: current.execution_epoch },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: current.id, revision: current.revision, changeKind: 'claimed', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/claim',
        subjectKind: 'work_item',
        subjectId: current.id,
        before: { status: before.status, assignee: before.assignee_id },
        after: { status: 'active', assignee: principal.memberId, runId, executionEpoch: current.execution_epoch },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: current.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { runId, threadId: thread.id, leaseUntil, fence: current.fence_seq },
      })
    })
  }

  /**
   * 指派：把一个 ready 的工作项交给某个在岗 bot（或人）。
   * 人要有 work_item.manage；bot 只能是该工作项所属项目的推进 bot（coordinator）——
   * 这就是「协调 bot 派活」的入口。真正开跑由会话适配器的派发器完成：它替被指派 bot 认领并投递一轮。
   */
  assignWorkItem(ctx: CommandContext, input: { workItemId: string; memberId: string }): CommandReceipt {
    return this.command(ctx, 'work_item/assign', input, () => {
      const principal = this.principal(ctx)
      const at = this.now()
      const before = this.workItemOrThrow(input.workItemId)
      const target = this.db
        .prepare('SELECT id, kind, name, status FROM member WHERE id = ?')
        .get(input.memberId) as { id: string; kind: string; name: string; status: string } | undefined
      if (!target) throw stateInvalid(`成员不存在：${input.memberId}`)
      if (target.status !== 'active') throw stateInvalid(`${target.name} 不在岗，不能接任务`)
      let allowed = false
      if (principal.kind === 'human') {
        requireCapability(principal, CAPABILITY.workItemManage)
        allowed = true
      } else {
        const coordinator = before.project_id
          ? (this.db.prepare('SELECT coordinator_id FROM project WHERE id = ?').get(before.project_id) as { coordinator_id: string | null } | undefined)?.coordinator_id
          : null
        allowed = Boolean(coordinator && coordinator === principal.memberId)
      }
      if (!allowed) throw denied('只有项目的推进 bot 或具备工单管理权限的人可以指派任务')
      if (before.status !== 'ready') throw stateInvalid(`只有待处理的工作项可以指派，当前 ${before.status}`)
      if (before.assignee_id === input.memberId) {
        return this.receipt(ctx, { status: 'noop', objectId: before.id, objectRevision: before.revision, executionEpoch: before.execution_epoch, detail: { memberId: target.id, alreadyAssigned: true } })
      }
      this.db
        .prepare('UPDATE work_item SET assignee_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(target.id, at, before.id)
      const after = this.workItemOrThrow(before.id)
      writeEvent(this.db, this.id(), {
        workItemId: after.id,
        kind: 'work_item_assigned',
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { memberId: target.id, memberName: target.name, previous: before.assignee_id },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: after.id, revision: after.revision, changeKind: 'assigned', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/assign',
        subjectKind: 'work_item',
        subjectId: after.id,
        before: { assignee: before.assignee_id },
        after: { assignee: target.id, revision: after.revision },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: after.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
        detail: { memberId: target.id, memberName: target.name },
      })
    })
  }

  accept(ctx: CommandContext, input: { workItemId: string; note?: string }): CommandReceipt {
    return this.command(ctx, 'work_item/accept', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.workItemAccept)
      const at = this.now()
      const before = this.workItemOrThrow(input.workItemId)
      if (before.status !== 'ready') throw stateInvalid(`只有 ready 的工作项可以接单，当前 ${before.status}`)
      this.db
        .prepare(
          `UPDATE work_item
              SET status = 'active', assignee_id = ?, revision = revision + 1,
                  execution_epoch = execution_epoch + 1, updated_at = ?
            WHERE id = ? AND status = 'ready'`,
        )
        .run(principal.memberId, at, input.workItemId)
      const current = this.workItemOrThrow(input.workItemId)
      writeEvent(this.db, this.id(), {
        workItemId: current.id,
        kind: 'work_item_accepted',
        actorId: principal.memberId,
        actorKind: 'human',
        payload: { note: input.note ?? '' },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: current.id, revision: current.revision, changeKind: 'accepted', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/accept',
        subjectKind: 'work_item',
        subjectId: current.id,
        before: { status: before.status },
        after: { status: 'active', assignee: principal.memberId, executionEpoch: current.execution_epoch },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: current.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
      })
    })
  }

  // ───────────────────────── T3 运行开始 / 结束 ─────────────────────────

  rotateThread(ctx: CommandContext,input:{workItemId:string;sessionId:string;reason?:string}):CommandReceipt {
    return this.command(ctx,'work_item/rotateThread',input,()=>{
      const principal=this.principal(ctx);requireHuman(principal);requireCapability(principal,CAPABILITY.workItemManage)
      if(ctx.channel!=='ui')throw denied('手动换新会话只能由人通过UI执行')
      const item=this.workItemOrThrow(input.workItemId),at=this.now()
      if((TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status))throw stateInvalid('终态工作项不能换新会话')
      if(this.db.prepare("SELECT id FROM task_run WHERE work_item_id=? AND status='running'").get(item.id))throw stateInvalid('运行中不能换新会话，请先等本轮结束')
      if(!item.assignee_id)throw stateInvalid('工作项尚未分配bot')
      const bot=resolvePrincipal(this.db,item.assignee_id,at);requireBot(bot)
      if(typeof input.sessionId!=='string'||!input.sessionId.trim())throw stateInvalid('新宿主会话id不能为空')
      if(this.db.prepare('SELECT id FROM work_item_thread WHERE session_id=?').get(input.sessionId))throw stateInvalid('新会话id已绑定，不能复用旧会话')
      this.closeThreadTx(item.id,input.reason??'manual_rotation',at)
      const thread=this.ensureThreadTx(bot,item,input.sessionId)
      const rewired=this.db.prepare("UPDATE task_run SET thread_id=?,member_version=? WHERE work_item_id=? AND status='queued'").run(thread.id,thread.member_version,item.id)
      this.db.prepare('UPDATE work_item SET revision=revision+1,updated_at=? WHERE id=?').run(at,item.id)
      const after=this.workItemOrThrow(item.id),detail={threadId:thread.id,generation:thread.generation,memberVersion:thread.member_version,sessionId:thread.session_id,rewiredRuns:Number(rewired.changes)}
      writeEvent(this.db,this.id(),{workItemId:item.id,kind:'thread_rotated',actorId:principal.memberId,actorKind:'human',payload:{...detail,reason:input.reason??'manual_rotation'},revision:after.revision,executionEpoch:after.execution_epoch,at})
      writeChange(this.db,{objectKind:'work_item',objectId:item.id,revision:after.revision,changeKind:'thread_rotated',at})
      const auditId=this.audit(ctx,principal,{action:'work_item/rotateThread',subjectKind:'work_item',subjectId:item.id,after:detail})
      return this.receipt(ctx,{status:'applied',objectId:item.id,objectRevision:after.revision,executionEpoch:after.execution_epoch,auditId,detail})
    })
  }

  startRun(ctx: CommandContext, input: { runId: string; sessionId?: string }): CommandReceipt {
    return this.command(ctx, 'run/start', input, () => {
      const principal = this.principal(ctx)
      requireBot(principal)
      requireCapability(principal, CAPABILITY.workItemExecute)
      const at = this.now()
      const run = this.runOrThrow(input.runId)
      if (run.member_id !== principal.memberId) throw denied('只能启动自己的运行')
      if (run.status !== 'queued') throw stateInvalid(`运行状态不是 queued：${run.status}`)
      const major = this.db.prepare("SELECT version FROM member_version WHERE member_id=? AND version>? AND change_class='major' ORDER BY version DESC LIMIT 1").get(principal.memberId,run.member_version)
      const boundThread = this.db.prepare('SELECT status FROM work_item_thread WHERE id=?').get(run.thread_id) as {status:string} | undefined
      if (major || boundThread?.status === 'pending_rotate') {
        const item = this.workItemOrThrow(run.work_item_id)
        const thread = this.ensureThreadTx(principal,item,input.sessionId)
        this.db.prepare('UPDATE task_run SET thread_id=?,member_version=? WHERE id=?').run(thread.id,thread.member_version,run.id)
        run.thread_id=thread.id;run.member_version=thread.member_version
      }
      const item = this.workItemOrThrow(run.work_item_id)
      if (item.execution_epoch !== run.execution_epoch) {
        throw new HamsError('EPOCH_STALE', '工作项执行代次已变，这次运行作废', { nextStep: '重新认领' })
      }
      const busy = this.db
        .prepare("SELECT COUNT(*) AS c FROM task_run WHERE member_id = ? AND status = 'running'")
        .get(principal.memberId) as { c: number }
      if (Number(busy.c) > 0) throw stateInvalid('该 bot 已有运行中的任务；同一 agent 同时只跑 1 个任务')

      this.db
        .prepare("UPDATE task_run SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(at, run.id)
      this.db
        .prepare('UPDATE work_item_thread SET turn_count = turn_count + 1 WHERE id = ?')
        .run(run.thread_id)
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'run_started',
        actorId: principal.memberId,
        actorKind: 'bot',
        payload: { runId: run.id, threadId: run.thread_id },
        revision: item.revision,
        executionEpoch: item.execution_epoch,
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'run/start',
        subjectKind: 'task_run',
        subjectId: run.id,
        before: { status: 'queued' },
        after: { status: 'running' },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: item.revision,
        executionEpoch: item.execution_epoch,
        auditId,
        detail: { runId: run.id },
      })
    })
  }

  submitResult(ctx: CommandContext, input: SubmitResultInput): CommandReceipt {
    return this.command(ctx, 'run/submitResult', input, () => {
      const principal = this.principal(ctx)
      requireBot(principal)
      requireCapability(principal, CAPABILITY.workItemExecute)
      const at = this.now()
      const run = this.runOrThrow(input.runId)
      if (run.member_id !== principal.memberId) throw denied('只能提交自己的运行结果')
      if (run.status !== 'running') throw stateInvalid(`运行状态不是 running：${run.status}`)
      const item = this.workItemOrThrow(run.work_item_id)
      if (item.execution_epoch !== run.execution_epoch) {
        throw new HamsError('EPOCH_STALE', '运行所属代次已过期', { nextStep: '丢弃这次结果，等新运行' })
      }

      // 到期复查起的运行（check_id 非空）只结束这一轮，不改工作项状态：
      // 判定由 evaluateCheck 做，工作项此时停在 waiting_check 是正常的。
      if (item.status !== 'active') {
        if (item.status === 'waiting_check' && run.check_id) {
          this.db
            .prepare("UPDATE task_run SET status = 'succeeded', finished_at = ?, result_summary = ? WHERE id = ? AND status = 'running'")
            .run(at, input.summary, run.id)
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: 'check_run_finished',
            actorId: principal.memberId,
            actorKind: 'bot',
            payload: { runId: run.id, checkId: run.check_id, summary: input.summary },
            revision: item.revision,
            executionEpoch: item.execution_epoch,
            at,
          })
          const auditId = this.audit(ctx, principal, {
            action: 'run/submitResult',
            subjectKind: 'task_run',
            subjectId: run.id,
            before: { status: 'running' },
            after: { status: 'succeeded', checkId: run.check_id },
          })
          return this.receipt(ctx, {
            status: 'applied',
            objectId: item.id,
            objectRevision: item.revision,
            executionEpoch: item.execution_epoch,
            auditId,
            detail: { runId: run.id, checkId: run.check_id, checkOnly: true },
          })
        }
        throw stateInvalid(`只有 active 的工作项可以提交结果，当前 ${item.status}`)
      }

      this.db
        .prepare("UPDATE task_run SET status = 'succeeded', finished_at = ?, result_summary = ? WHERE id = ? AND status = 'running'")
        .run(at, input.summary, run.id)

      const template = this.templateVersionTx(item.template_version_id)
      const checkPolicy = parseCheckPolicy(template?.check_policy_json)
      const plannedDueAt = nextCheckAt(checkPolicy, at)
      const generation = item.check_generation + 1
      const checkId = this.id()
      this.db
        .prepare(
          `INSERT INTO work_item_check
             (id, work_item_id, generation, execution_epoch, template_version_id, planned_due_at, status,
              evidence_set_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, '{}', ?)`,
        )
        .run(checkId, item.id, generation, item.execution_epoch, item.template_version_id, plannedDueAt, item.evidence_set_hash, at)
      this.db
        .prepare(
          `UPDATE work_item
              SET status = 'waiting_check', revision = revision + 1, check_generation = ?, next_action_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(generation, plannedDueAt, at, item.id)

      const current = this.workItemOrThrow(item.id)
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'result_submitted',
        actorId: principal.memberId,
        actorKind: 'bot',
        payload: { runId: run.id, summary: input.summary, checkId, plannedDueAt },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: current.revision, changeKind: 'result_submitted', at })
      writeChange(this.db, { objectKind: 'work_item_check', objectId: checkId, revision: 1, changeKind: 'check_scheduled', at })
      const auditId = this.audit(ctx, principal, {
        action: 'run/submitResult',
        subjectKind: 'task_run',
        subjectId: run.id,
        before: { status: 'running' },
        after: { status: 'succeeded', checkId, plannedDueAt },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { runId: run.id, checkId, plannedDueAt },
      })
    })
  }

  // ───────────────────────── T8 追加证据 ─────────────────────────

  appendEvidence(ctx: CommandContext, input: AppendEvidenceInput): CommandReceipt {
    return this.command(ctx, 'work_item/addEvidence', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.evidenceAppend)
      const at = this.now()
      const item = this.workItemOrThrow(input.workItemId)
      if (item.status === 'cancelled') throw stateInvalid('已取消的工作项不能再追加证据')

      if (input.supersedesId) {
        const old = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(input.supersedesId) as EvidenceRow | undefined
        if (!old || old.work_item_id !== item.id) throw stateInvalid('被替代的证据不存在或不属于该工作项')
        if (old.status !== 'active') throw stateInvalid(`被替代的证据状态不是 active：${old.status}`)
        this.db.prepare("UPDATE evidence SET status = 'superseded' WHERE id = ?").run(old.id)
      }

      const evidenceId = this.id()
      const contentHash =
        input.contentHash ?? createHash('sha256').update(`${input.kind}\u0000${input.ref}`).digest('hex')
      this.db
        .prepare(
          `INSERT INTO evidence
             (id, work_item_id, run_id, kind, ref, content_hash, source, observed_at, captured_at, captured_by,
              on_behalf_of, supersedes_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          evidenceId,
          item.id,
          input.runId ?? null,
          input.kind,
          input.ref,
          contentHash,
          input.source ?? '',
          input.observedAt,
          at,
          principal.memberId,
          input.onBehalfOf ?? null,
          input.supersedesId ?? null,
        )

      const newHash = evidenceSetHash(this.evidenceSnapshots(item.id))
      this.db
        .prepare('UPDATE work_item SET evidence_set_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(newHash, at, item.id)
      const current = this.workItemOrThrow(item.id)

      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'evidence_appended',
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { evidenceId, kind: input.kind, evidenceSetHash: newHash, supersedesId: input.supersedesId ?? null },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: current.revision, changeKind: 'evidence_appended', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/addEvidence',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { evidenceId, evidenceSetHash: newHash },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        auditId,
        detail: { evidenceId, evidenceSetHash: newHash },
      })
    })
  }

  // ───────────────────────── T6 审批请求 ─────────────────────────

  requestClosure(ctx: CommandContext, input: RequestClosureInput): CommandReceipt {
    return this.command(ctx, 'work_item/requestClosure', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.workItemRequestClosure)
      const at = this.now()
      const item = this.workItemOrThrow(input.workItemId)
      // waiting_review 也允许申请：审批过期 / 被撤回后「重新申请」不会改变工作项状态，
      // 只把修订号推进一格并换一张新的审批单（白名单里本来就没有 waiting_review→waiting_review 这条边）。
      if (!['active', 'waiting_check', 'blocked', 'waiting_review'].includes(item.status)) {
        throw stateInvalid(`当前状态不能申请关单：${item.status}`)
      }
      const template = this.templateVersionTx(item.template_version_id)
      if (!template) {
        throw evidenceIncomplete('工作项没有绑定模板版本，无法校验关单判据')
      }
      if (template.status !== 'published') throw stateInvalid(`判据版本未发布：${template.status}`)
      const requirements = parseEvidenceRequirements(template.required_evidence_json)
      const snapshot = buildCriteriaSnapshot(template.id, requirements, this.evidenceSnapshots(item.id), at)
      if (!snapshot.result.satisfied) {
        throw evidenceIncomplete('证据清单未满足，不能申请关单', snapshot.result.missing)
      }
      if (template.validator_key) {
        const validator = this.validators[template.validator_key]
        if (!validator) {
          throw new HamsError(
            'HOST_CAPABILITY_MISSING',
            `判据验证器未注册：${template.validator_key}`,
            { nextStep: '注册该验证器后再申请关单，或降级为人工判定' },
          )
        }
        const result = validator({
          workItem: item,
          evidence: this.evidenceRows(item.id),
          params: this.parseJsonObject(template.validator_params_json),
          now: at,
        })
        if (!result.passed) {
          throw evidenceIncomplete(`判据验证器 ${template.validator_key} 未通过`, result.detail ?? null)
        }
      }

      const pending = this.db
        .prepare(
          `SELECT id FROM approval WHERE subject_kind = 'work_item_close' AND subject_id = ? AND status = 'pending'`,
        )
        .get(item.id) as { id: string } | undefined
      if (pending) throw stateInvalid('该工作项已有一条待决审批', '等现有审批结束或失效后再申请')

      if (item.status === 'waiting_review') {
        this.db
          .prepare('UPDATE work_item SET revision = revision + 1, updated_at = ? WHERE id = ?')
          .run(at, item.id)
      } else {
        this.db
          .prepare(
            `UPDATE work_item
                SET status = 'waiting_review', resume_state = NULL, blocked_reason = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(at, item.id)
      }
      const current = this.workItemOrThrow(item.id)

      const reviewPolicy = parseReviewPolicy(template.review_policy_json)
      const approverId = this.resolveApproverTx(reviewPolicy, current, at)
      const approvalId = this.id()
      const expiresAt = at + reviewPolicy.expiresHours * 3_600_000
      this.db
        .prepare(
          `INSERT INTO approval
             (id, subject_kind, subject_id, subject_revision, execution_epoch, evidence_set_hash, criteria_ref,
              criteria_json, reason_text, requested_by, requested_channel, approver_id, status,
              decision_note, expires_at, created_at)
           VALUES (?, 'work_item_close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`,
        )
        .run(
          approvalId,
          item.id,
          current.revision,
          current.execution_epoch,
          current.evidence_set_hash,
          template.id,
          JSON.stringify(snapshot),
          input.reason,
          principal.memberId,
          this.requestChannel(ctx),
          approverId,
          expiresAt,
          at,
        )

      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'closure_requested',
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { approvalId, approverId, expiresAt, evidenceSetHash: current.evidence_set_hash },
        revision: current.revision,
        executionEpoch: current.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'approval', objectId: approvalId, revision: 1, changeKind: 'approval_requested', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/requestClosure',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { approvalId, approverId, expiresAt },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: current.revision,
        executionEpoch: current.execution_epoch,
        approvalId,
        auditId,
        detail: { approvalId, approverId, expiresAt, criteria: snapshot },
      })
    })
  }

  // ───────────────────────── T7 / T5 审批决定与关单 ─────────────────────────

  decideApproval(ctx: CommandContext, input: DecideApprovalInput): CommandReceipt {
    return this.command(ctx, 'approval/decide', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.approvalDecide)
      const at = this.now()
      const approval = this.approvalOrThrow(input.approvalId)
      if (approval.status !== 'pending') throw stateInvalid(`审批已是终态：${approval.status}`)
      if (approval.approver_id !== principal.memberId) {
        throw new HamsError('NOT_APPROVER', '只有申请时指定的审批人可以决定', { nextStep: '让指定审批人处理' })
      }
      if (at >= approval.expires_at) {
        throw new HamsError('APPROVAL_EXPIRED', '审批已过有效期', { nextStep: '重新申请' })
      }
      if (input.decision !== 'approve' && input.decision !== 'reject' && input.decision !== 'return') {
        throw stateInvalid(`未知审批决定：${String(input.decision)}`)
      }
      const note = input.note ?? ''
      if ((input.decision === 'reject' || input.decision === 'return') && note.trim().length === 0) {
        throw stateInvalid('驳回或退回必须写明原因')
      }

      const isCloseSubject = approval.subject_kind === 'work_item_close'
      const isTargetCheck = approval.subject_kind === 'target_change'
      let targetCheck: { id: string; target_id: string; status: string; submitted_by: string; approver_id: string | null } | null = null
      if (isTargetCheck) {
        targetCheck = this.db.prepare('SELECT id,target_id,status,submitted_by,approver_id FROM project_phase_target_check WHERE id = ?').get(approval.subject_id) as
          | { id: string; target_id: string; status: string; submitted_by: string; approver_id: string | null }
          | undefined ?? null
        if (!targetCheck) throw stateInvalid('检验记录不存在或已删除')
        if (targetCheck.status !== 'pending') throw stateInvalid(`这条检验已处理：${targetCheck.status}`)
      }
      let item: WorkItemRow | null = null
      if (isCloseSubject) {
        item = this.workItemOrThrow(approval.subject_id)
        if (item.status !== 'waiting_review') throw stateInvalid(`工作项不在待验收状态：${item.status}`)
        if (item.evidence_set_hash !== approval.evidence_set_hash) {
          throw new HamsError('EVIDENCE_CHANGED', '证据材料已变，这次审批的对象不再是最新版本', {
            nextStep: '按新材料重新申请',
          })
        }
        if (item.revision !== approval.subject_revision) {
          throw new HamsError('VERSION_CONFLICT', '对象修订号已变，审批作废', { nextStep: '刷新后重新申请' })
        }
        if (item.execution_epoch !== approval.execution_epoch) {
          throw new HamsError('EPOCH_STALE', '执行代次已变，这次审批不适用', { nextStep: '在新代次上重新处置' })
        }
      }

      const status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'returned'
      this.db
        .prepare(
          `UPDATE approval
              SET status = ?, decided_by = ?, decided_channel = 'ui', decision_note = ?, decided_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(status, principal.memberId, note, at, approval.id)

      if (isTargetCheck && targetCheck) {
        const nextStatus = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'pending'
        this.db
          .prepare('UPDATE project_phase_target_check SET status = ?, result = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
          .run(nextStatus, input.decision === 'approve' ? 'met' : input.decision === 'reject' ? 'missed' : 'unknown', principal.memberId, at, note, targetCheck.id)
      }
      let itemAfter: WorkItemRow | null = null
      if (isCloseSubject && item) {
        if (input.decision === 'approve') {
          this.db
            .prepare(
              `UPDATE work_item
                  SET status = 'completed', revision = revision + 1, updated_at = ?, completed_at = ?
                WHERE id = ? AND status = 'waiting_review'`,
            )
            .run(at, at, item.id)
          this.closeThreadTx(item.id, 'completed', at)
          this.db.prepare('DELETE FROM lease WHERE work_item_id = ?').run(item.id)
          itemAfter = this.workItemOrThrow(item.id)
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: 'work_item_closed',
            actorId: principal.memberId,
            actorKind: 'human',
            payload: { approvalId: approval.id, evidenceSetHash: item.evidence_set_hash },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at,
          })
          writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'closed', at })
        } else if (input.decision === 'reject') {
          this.db
            .prepare("UPDATE work_item SET status = 'active', revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(at, item.id)
          itemAfter = this.workItemOrThrow(item.id)
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: 'closure_rejected',
            actorId: principal.memberId,
            actorKind: 'human',
            payload: { approvalId: approval.id, note },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at,
          })
          writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'closure_rejected', at })
        } else {
          this.db
            .prepare(
              `UPDATE work_item
                  SET status = 'blocked', blocked_reason = 'needs_evidence', revision = revision + 1, updated_at = ?
                WHERE id = ?`,
            )
            .run(at, item.id)
          itemAfter = this.workItemOrThrow(item.id)
          writeEvent(this.db, this.id(), {
            workItemId: item.id,
            kind: 'closure_returned',
            actorId: principal.memberId,
            actorKind: 'human',
            payload: { approvalId: approval.id, note },
            revision: itemAfter.revision,
            executionEpoch: itemAfter.execution_epoch,
            at,
          })
          writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'closure_returned', at })
        }
      }

      writeChange(this.db, { objectKind: 'approval', objectId: approval.id, revision: 1, changeKind: `approval_${status}`, at })
      const auditId = this.audit(ctx, principal, {
        action: 'approval/decide',
        subjectKind: 'approval',
        subjectId: approval.id,
        before: { status: 'pending' },
        after: { status, note, workItemStatus: itemAfter?.status ?? null },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: itemAfter?.id ?? approval.subject_id,
        objectRevision: itemAfter?.revision,
        executionEpoch: itemAfter?.execution_epoch,
        approvalId: approval.id,
        auditId,
        detail: { approvalStatus: status, workItemStatus: itemAfter?.status ?? null },
      })
    })
  }

  // ───────────────────────── 复查判定 ─────────────────────────

  evaluateCheck(ctx: CommandContext, input: EvaluateCheckInput): CommandReceipt {
    return this.command(ctx, 'check/evaluate', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.checkEvaluate)
      const at = this.now()
      const check = this.checkOrThrow(input.checkId)
      if (!['scheduled', 'running'].includes(check.status)) {
        throw stateInvalid(`复查已是终态：${check.status}`)
      }
      const item = this.workItemOrThrow(check.work_item_id)
      if (item.execution_epoch !== check.execution_epoch) {
        throw new HamsError('EPOCH_STALE', '复查所属代次已过期', { nextStep: '按当前代次重新排复查' })
      }
      const template = this.templateVersionTx(check.template_version_id ?? item.template_version_id)
      const requirements = parseEvidenceRequirements(template?.required_evidence_json)
      const rows = this.evidenceRows(item.id)
      const snapshot = buildCriteriaSnapshot(
        template?.id ?? item.template_version_id,
        requirements,
        this.evidenceSnapshots(item.id),
        at,
      )
      let validatorResult: unknown = null
      let validatorPassed = true
      if (template?.validator_key) {
        const validator = this.validators[template.validator_key]
        if (!validator) {
          throw new HamsError('HOST_CAPABILITY_MISSING', `判据验证器未注册：${template.validator_key}`)
        }
        const result = validator({
          workItem: item,
          evidence: rows,
          params: this.parseJsonObject(template.validator_params_json),
          now: at,
        })
        validatorPassed = result.passed
        validatorResult = result.detail ?? null
      }

      const freshHash = evidenceSetHash(this.evidenceSnapshots(item.id))
      let verdict: 'passed' | 'failed' | 'unknown'
      if (!snapshot.result.satisfied) {
        const allKindsEmpty = snapshot.result.missing.every((missing) => missing.have === 0)
        verdict = allKindsEmpty ? 'unknown' : 'failed'
      } else {
        verdict = validatorPassed ? 'passed' : 'failed'
      }

      this.db
        .prepare(
          `UPDATE work_item_check
              SET status = ?, evidence_set_hash = ?, result_json = ?, evaluated_at = ?
            WHERE id = ?`,
        )
        .run(
          verdict,
          freshHash,
          JSON.stringify({ criteria: snapshot, validator: validatorResult, verdict }),
          at,
          check.id,
        )

      let itemAfter = item
      let autoClosed = false
      if (verdict === 'passed' && item.status === 'waiting_check' && item.close_requires_approval === 0) {
        // 状态白名单里没有 waiting_check → completed 这条边（自动关单只从 waiting_review 出发），
        // 所以在同一事务里先过 waiting_review 再关单；两步都写在白名单内，外部看不到中间态。
        this.db
          .prepare(
            "UPDATE work_item SET status = 'waiting_review', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'waiting_check'",
          )
          .run(at, item.id)
        this.db
          .prepare(
            `UPDATE work_item
                SET status = 'completed', revision = revision + 1, updated_at = ?, completed_at = ?
              WHERE id = ?`,
          )
          .run(at, at, item.id)
        this.closeThreadTx(item.id, 'completed', at)
        this.db.prepare('DELETE FROM lease WHERE work_item_id = ?').run(item.id)
        itemAfter = this.workItemOrThrow(item.id)
        autoClosed = true
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: 'work_item_auto_closed',
          actorId: 'system',
          actorKind: 'system',
          payload: { checkId: check.id, evidenceSetHash: freshHash },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at,
        })
        writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'auto_closed', at })
      } else if (verdict === 'failed' && item.status === 'waiting_check') {
        this.db
          .prepare("UPDATE work_item SET status = 'active', revision = revision + 1, next_action_at = NULL, updated_at = ? WHERE id = ?")
          .run(at, item.id)
        itemAfter = this.workItemOrThrow(item.id)
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: 'check_failed',
          actorId: principal.memberId,
          actorKind: principal.kind,
          payload: { checkId: check.id },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at,
        })
        writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'check_failed', at })
      } else if (verdict === 'unknown' && item.status === 'waiting_check') {
        this.db
          .prepare(
            `UPDATE work_item
                SET status = 'blocked', blocked_reason = 'data_source', revision = revision + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(at, item.id)
        itemAfter = this.workItemOrThrow(item.id)
        writeEvent(this.db, this.id(), {
          workItemId: item.id,
          kind: 'check_unknown',
          actorId: principal.memberId,
          actorKind: principal.kind,
          payload: { checkId: check.id },
          revision: itemAfter.revision,
          executionEpoch: itemAfter.execution_epoch,
          at,
        })
        writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: itemAfter.revision, changeKind: 'check_unknown', at })
      }

      writeChange(this.db, { objectKind: 'work_item_check', objectId: check.id, revision: 1, changeKind: `check_${verdict}`, at })
      const auditId = this.audit(ctx, principal, {
        action: 'check/evaluate',
        subjectKind: 'work_item_check',
        subjectId: check.id,
        before: { status: check.status },
        after: { status: verdict, evidenceSetHash: freshHash, autoClosed },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: itemAfter.id,
        objectRevision: itemAfter.revision,
        executionEpoch: itemAfter.execution_epoch,
        auditId,
        detail: { checkId: check.id, verdict, autoClosed, missing: snapshot.result.missing },
      })
    })
  }

  // ───────────────────────── T9 生命周期命令 ─────────────────────────

  pause(ctx: CommandContext, input: { workItemId: string; reason?: string }): CommandReceipt {
    return this.transitionCommand(ctx, 'work_item/pause', input, 'pause')
  }

  resume(ctx: CommandContext, input: { workItemId: string; reason?: string }): CommandReceipt {
    return this.transitionCommand(ctx, 'work_item/resume', input, 'resume')
  }

  cancel(ctx: CommandContext, input: { workItemId: string; reason?: string }): CommandReceipt {
    return this.transitionCommand(ctx, 'work_item/cancel', input, 'cancel')
  }

  reopen(ctx: CommandContext, input: { workItemId: string; reason?: string }): CommandReceipt {
    return this.transitionCommand(ctx, 'work_item/reopen', input, 'reopen')
  }

  retry(ctx: CommandContext, input: { workItemId: string; reason?: string }): CommandReceipt {
    return this.transitionCommand(ctx, 'work_item/retry', input, 'retry')
  }

  reportBlocker(
    ctx: CommandContext,
    input: { workItemId: string; category: string; note: string },
  ): CommandReceipt {
    return this.command(ctx, 'work_item/reportBlocker', input, () => {
      const principal = this.principal(ctx)
      if (principal.kind === 'bot') requireCapability(principal, CAPABILITY.workItemExecute)
      else requireCapability(principal, CAPABILITY.workItemManage)
      const at = this.now()
      const item = this.workItemOrThrow(input.workItemId)
      if (!['ready', 'active'].includes(item.status)) throw stateInvalid(`当前状态不能报阻塞：${item.status}`)
      const allowed = ['needs_evidence', 'external', 'dependency', 'permission', 'human_input', 'data_source']
      if (!allowed.includes(input.category)) throw stateInvalid(`未知阻塞原因：${input.category}`)
      this.db
        .prepare(
          `UPDATE work_item
              SET status = 'blocked', blocked_reason = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.category, at, item.id)
      // 报阻塞就结束本轮：否则 run 永远停在 running，界面一直显示「运行中」，也占着 uq_wi_active_run。
      const running = this.db
        .prepare("SELECT id FROM task_run WHERE work_item_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
        .get(item.id) as { id: string } | undefined
      if (running) {
        this.db
          .prepare("UPDATE task_run SET status = 'failed', finished_at = ?, error_kind = ? WHERE id = ? AND status = 'running'")
          .run(at, `blocked:${input.category}`, running.id)
        this.db.prepare('DELETE FROM lease WHERE run_id = ?').run(running.id)
      }
      const after = this.workItemOrThrow(item.id)
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'blocker_reported',
        actorId: principal.memberId,
        actorKind: principal.kind,
        payload: { category: input.category, note: input.note },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: after.revision, changeKind: 'blocked', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/reportBlocker',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { blockedReason: input.category, note: input.note },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
      })
    })
  }

  unblock(ctx: CommandContext, input: { workItemId: string; to?: 'ready' | 'active' }): CommandReceipt {
    return this.command(ctx, 'work_item/unblock', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.workItemManage)
      const at = this.now()
      const item = this.workItemOrThrow(input.workItemId)
      if (item.status !== 'blocked') throw stateInvalid(`只有 blocked 的工作项可以解除阻塞，当前 ${item.status}`)
      const to = input.to ?? 'ready'
      this.assertTransition(item.status, to)
      this.db
        .prepare(
          `UPDATE work_item
              SET status = ?, blocked_reason = NULL, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(to, at, item.id)
      const after = this.workItemOrThrow(item.id)
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: 'unblocked',
        actorId: principal.memberId,
        actorKind: 'human',
        payload: { to },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: after.revision, changeKind: 'unblocked', at })
      const auditId = this.audit(ctx, principal, {
        action: 'work_item/unblock',
        subjectKind: 'work_item',
        subjectId: item.id,
        after: { status: to },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
      })
    })
  }

  // ───────────────────────── 项目（M6） ─────────────────────────

  /**
   * 项目列表。数据来自 `project` 与它关联的工作项/指标，不是样例；
   * 空库就返回空数组，界面负责显示「建第一个项目」的引导。
   */
  listProjects(
    ctx: CommandContext,
    filter: { status?: string; type?: string; limit?: number } = {},
  ) {
    const principal=resolvePrincipal(this.db, ctx.principalId, this.now())
    return queryProjects(this.db, filter).map(project=>{
      const count=(sql:string)=>Number((this.db.prepare(sql).get(project.id,principal.memberId) as {n:number}).n)
      const pending_my_count=count("SELECT COUNT(*) AS n FROM proposal WHERE project_id=? AND decider_id=? AND status='open'")
        +count("SELECT COUNT(*) AS n FROM project_review WHERE project_id=? AND confirmer_id=? AND status='awaiting_confirm'")
        +count("SELECT COUNT(*) AS n FROM project_phase WHERE project_id=? AND confirmer_id=? AND status='awaiting_confirm'")
        +count("SELECT COUNT(*) AS n FROM approval a JOIN work_item w ON w.id=a.subject_id WHERE w.project_id=? AND a.approver_id=? AND a.status='pending' AND a.subject_kind='work_item_close'")
      return {...project,pending_my_count,needs_my_action:pending_my_count>0}
    })
  }

  getProjectDetail(ctx: CommandContext, projectId: string) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const detail = queryProject(this.db, projectId)
    const extra = lifecycle.projectLifecycleDetail(this.db, projectId)
    const actions = this.projectActions(principal, detail)
    if (principal.kind === 'human' && detail.status !== 'archived') {
      if (principal.capabilities.has('target.publish')) actions.push('publishTarget')
      if (principal.capabilities.has(CAPABILITY.projectManage)) {
        actions.push('createPhase','updatePhase','createReview')
        if (extra.phases.some(p => p.status === 'awaiting_confirm' && p.confirmer_id === principal.memberId)) actions.push('confirmPhase')
      }
      if (principal.capabilities.has('review.confirm') && extra.reviews.some(r => r.status === 'awaiting_confirm' && r.confirmer_id === principal.memberId)) actions.push('confirmReview')
    }
    const phases = extra.phases.map(p => ({...p,allowedActions: [
      ...(actions.includes('updatePhase') && p.status !== 'done' ? ['updatePhase'] : []),
      ...(actions.includes('confirmPhase') && p.status === 'awaiting_confirm' && p.confirmer_id === principal.memberId ? ['confirmPhase'] : []),
    ]}))
    const reviews = extra.reviews.map(r => ({...r,allowedActions: actions.includes('confirmReview') && r.status === 'awaiting_confirm' && r.confirmer_id === principal.memberId ? ['confirmReview'] : []}))
    return { ...detail, ...extra, phases, reviews, workItems: this.db.prepare('SELECT * FROM work_item WHERE project_id=? ORDER BY updated_at DESC,id').all(projectId), target_versions: detail.target_versions.map(v => ({...v, metrics: this.db.prepare('SELECT * FROM project_metric WHERE version_id=? ORDER BY name').all(v.id)})), allowedActions: actions }
  }

  createProject(ctx: CommandContext, input: CreateProjectInput): CommandReceipt {
    return this.command(ctx, 'project/create', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.projectCreate)
      const at = this.now()
      const created = insertProjectRow(this.db, this.id, at, principal.memberId, input)
      const detail = queryProject(this.db, created.id)
      writeChange(this.db, { objectKind: 'project', objectId: created.id, revision: 1, changeKind: 'created', at })
      const auditId = this.audit(ctx, principal, {
        action: 'project/create',
        subjectKind: 'project',
        subjectId: created.id,
        after: { name: detail.name, type: detail.type, status: detail.status, goal: detail.goal_text },
      })
      // 默认阶段与目标：发布的项目一建立就有可推进的骨架；草稿等发布时再补。
      if (detail.status !== 'draft') {
        lifecycle.ensureDefaultPlan(this.db, this.id, at, created.id)
        ensureDefaultAnalystInProject(this.db, created.id, detail.coordinator_id, principal.memberId, at)
      }
      return this.receipt(ctx, {
        status: 'applied',
        objectId: created.id,
        objectRevision: created.revision,
        auditId,
        detail: {
          targetVersionId: created.targetVersionId,
          metrics: detail.metrics.length,
          coordinatorId: detail.coordinator_id,
          status: detail.status,
        },
      })
    })
  }

  /**
   * 新建向导保存草稿：可只填名称，允许目标/指标为空。
   * 新建走 project.create 权限；续存自己的草稿也允许，改别人的草稿要 project.manage。
   */
  saveProjectDraft(ctx: CommandContext, input: SaveDraftInput): CommandReceipt {
    return this.command(ctx, 'project/saveDraft', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      const at = this.now()
      if (input.projectId) {
        const existing = this.db
          .prepare('SELECT owner_human_id, status FROM project WHERE id = ? AND deleted_at IS NULL')
          .get(input.projectId) as { owner_human_id: string; status: string } | undefined
        if (!existing) throw stateInvalid(`项目不存在：${input.projectId}`)
        if (existing.status !== 'draft') throw stateInvalid('只有草稿项目可以在新建向导里继续修改')
        if (existing.owner_human_id !== principal.memberId) requireCapability(principal, CAPABILITY.projectManage)
      } else {
        requireCapability(principal, CAPABILITY.projectCreate)
      }
      const saved = persistProjectDraft(this.db, this.id, at, principal.memberId, input)
      if (saved.created) {
        writeChange(this.db, { objectKind: 'project', objectId: saved.projectId, revision: saved.revision, changeKind: 'draft_created', at })
      }
      const auditId = this.audit(ctx, principal, {
        action: 'project/saveDraft',
        subjectKind: 'project',
        subjectId: saved.projectId,
        after: { created: saved.created, revision: saved.revision, step: saved.step },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: saved.projectId,
        objectRevision: saved.revision,
        auditId,
        detail: { created: saved.created, step: saved.step, savedAt: saved.savedAt },
      })
    })
  }

  /** 删除归档项目：软删，工作项解绑保留；只有具备 project.archive 的人能做。 */
  deleteProject(ctx: CommandContext, input: { projectId: string; reason?: string }): CommandReceipt {
    return this.command(ctx, 'project/delete', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, 'project.archive')
      const at = this.now()
      const deleted = softDeleteProject(this.db, at, principal.memberId, input.projectId)
      writeChange(this.db, {
        objectKind: 'project',
        objectId: deleted.id,
        revision: deleted.revision,
        changeKind: 'deleted',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'project/delete',
        subjectKind: 'project',
        subjectId: deleted.id,
        after: { detachedWorkItems: deleted.detachedWorkItems, reason: input.reason ?? null },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: deleted.id,
        objectRevision: deleted.revision,
        auditId,
        detail: { detachedWorkItems: deleted.detachedWorkItems },
      })
    })
  }

  // ───────────────────────── 项目记忆 ─────────────────────────

  listProjectMemories(
    ctx: CommandContext,
    filter: { projectId: string; status?: string; kind?: string; limit?: number },
  ) {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    return queryProjectMemories(this.db, filter)
  }

  /** 人在项目「记忆」页签手写一条；能力类可以指定同步给哪个 bot。 */
  createProjectMemory(
    ctx: CommandContext,
    input: { projectId: string; kind: string; title: string; body: string; memberId?: string | null },
  ): CommandReceipt {
    return this.command(ctx, 'project/memory/create', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.projectManage)
      const at = this.now()
      const created = createMemory(this.db, this.id, at, principal.memberId, {
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        origin: 'manual',
        memberId: input.memberId ?? null,
        sourceRef: 'manual',
      } satisfies CreateMemoryInput)
      writeChange(this.db, {
        objectKind: 'project',
        objectId: input.projectId,
        revision: 0,
        changeKind: 'memory.created',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'project/memory/create',
        subjectKind: 'project_memory',
        subjectId: created.memory.id,
        after: { kind: created.memory.kind, title: created.memory.title, syncedTo: created.syncedTo },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: created.memory.id,
        objectRevision: created.memory.revision,
        auditId,
        detail: { projectId: input.projectId, created: created.created, syncedTo: created.syncedTo },
      })
    })
  }

  /** 改标题/正文，或归档/恢复；能力类记忆同步更新 bot 的副本。 */
  updateProjectMemory(
    ctx: CommandContext,
    input: { memoryId: string; title?: string; body?: string; status?: string },
  ): CommandReceipt {
    return this.command(ctx, 'project/memory/update', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      const before = this.db
        .prepare('SELECT id, project_id, status, title FROM project_memory WHERE id = ?')
        .get(input.memoryId) as { id: string; project_id: string; status: string; title: string } | undefined
      if (!before) throw stateInvalid(`记忆不存在：${input.memoryId}`)
      requireCapability(principal, CAPABILITY.projectManage)
      const at = this.now()
      const updated = updateMemory(this.db, at, input)
      writeChange(this.db, {
        objectKind: 'project',
        objectId: before.project_id,
        revision: 0,
        changeKind: `memory.${updated.status}`,
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'project/memory/update',
        subjectKind: 'project_memory',
        subjectId: updated.id,
        before: { status: before.status, title: before.title },
        after: { status: updated.status, title: updated.title },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: updated.id,
        objectRevision: updated.revision,
        auditId,
        detail: { projectId: before.project_id, status: updated.status },
      })
    })
  }

  /** 项目状态机：发布目标（draft→active）、暂停/继续、归档。归档能力是人专属。 */
  updateProjectStatus(
    ctx: CommandContext,
    input: { projectId: string; status: string; reason?: string },
  ): CommandReceipt {
    return this.command(ctx, 'project/status', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      if (input.status === 'archived') requireCapability(principal, 'project.archive')
      else requireCapability(principal, CAPABILITY.projectManage)
      const at = this.now()
      const change = applyProjectStatus(this.db, this.id, at, principal.memberId, input.projectId, input.status)
      if (change.before === 'draft' && change.after === 'active') {
        // 从详情页「发布目标」发布草稿时，与向导发布走同一套收尾。
        clearProjectDraft(this.db, input.projectId)
        lifecycle.ensureDefaultPlan(this.db, this.id, at, input.projectId)
        const coordinator = (this.db.prepare('SELECT coordinator_id FROM project WHERE id = ?').get(input.projectId) as { coordinator_id: string | null }).coordinator_id
        ensureDefaultAnalystInProject(this.db, input.projectId, coordinator, principal.memberId, at)
      }
      writeChange(this.db, {
        objectKind: 'project',
        objectId: input.projectId,
        revision: change.revision,
        changeKind: `status:${change.after}`,
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'project/status',
        subjectKind: 'project',
        subjectId: input.projectId,
        before: { status: change.before },
        after: { status: change.after, reason: input.reason ?? null, targetVersionId: change.targetVersionId },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: input.projectId,
        objectRevision: change.revision,
        auditId,
        detail: { before: change.before, after: change.after, targetVersionId: change.targetVersionId },
      })
    })
  }

  tryProjectMetric(ctx: CommandContext, input: {projectId?: string;metric: import('./projects.ts').MetricInput}) {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    if (input.projectId) lifecycle.projectRow(this.db,input.projectId)
    return lifecycle.tryMetric(this.db,this.now(),input.projectId,input.metric)
  }

  publishProjectTarget(ctx:CommandContext,input:lifecycle.PublishTargetInput) {
    return this.projectCommand(ctx,'project/publishTarget',input,'target.publish',p => {
      const before=this.db.prepare('SELECT status,coordinator_id FROM project WHERE id=?').get(input.projectId) as {status:string;coordinator_id:string|null}
      const result = lifecycle.publishTarget(this.db,this.id,this.now(),p.memberId,input)
      if(before.status==='draft'){
        // 草稿第一次发布：向导草稿清掉，补齐默认阶段，并把数据分析 bot 拉进群。
        const at=this.now()
        clearProjectDraft(this.db,input.projectId)
        lifecycle.ensureDefaultPlan(this.db,this.id,at,input.projectId)
        ensureDefaultAnalystInProject(this.db,input.projectId,before.coordinator_id,p.memberId,at)
      }
      return result
    })
  }
  createProjectPhase(ctx:CommandContext,input:lifecycle.CreatePhaseInput) {
    return this.projectCommand(ctx,'project/createPhase',input,CAPABILITY.projectManage,p => lifecycle.createPhase(this.db,this.id,p.memberId,input))
  }
  updateProjectPhase(ctx:CommandContext,input:lifecycle.UpdatePhaseInput) {
    return this.projectCommand(ctx,'project/updatePhase',input,CAPABILITY.projectManage,p => lifecycle.updatePhase(this.db,this.now(),p.memberId,input))
  }
  updateProjectTarget(ctx:CommandContext,input:lifecycle.UpdateTargetInput) {
    return this.projectCommand(ctx,'project/updateTarget',input,CAPABILITY.projectManage,p => lifecycle.updatePhaseTarget(this.db,input))
  }
  addProjectTarget(ctx:CommandContext,input:{projectId:string;phaseId:string;description:string;detail?:string;targetValue?:number|null;metricId?:string;verifierHumanId?:string}) {
    return this.projectCommand(ctx,'project/addTarget',input,CAPABILITY.projectManage,() => lifecycle.addPhaseTarget(this.db,this.id,input))
  }
  submitProjectTargetCheck(ctx:CommandContext,input:lifecycle.SubmitTargetCheckInput) {
    return this.projectCommand(ctx,'project/submitTargetCheck',input,CAPABILITY.projectManage,p => {
      // 指定审批人必须是能批准的人类（避免指派一个没有审批能力的人让流程卡死）。
      const approver=resolvePrincipal(this.db,input.approverId,this.now())
      requireHuman(approver)
      requireCapability(approver,CAPABILITY.approvalDecide)
      return lifecycle.submitTargetCheck(this.db,this.id,this.now(),p.memberId,input)
    })
  }
  confirmProjectPhase(ctx:CommandContext,input:{projectId:string;phaseId:string;note?:string}) {
    return this.projectCommand(ctx,'project/confirmPhase',input,CAPABILITY.projectManage,p => lifecycle.confirmPhase(this.db,this.now(),p.memberId,input))
  }
  createProjectReview(ctx:CommandContext,input:lifecycle.CreateReviewInput) {
    return this.projectCommand(ctx,'project/createReview',input,CAPABILITY.projectManage,p => lifecycle.createReview(this.db,this.id,this.now(),p.memberId,input))
  }
  confirmProjectReview(ctx:CommandContext,input:{projectId:string;reviewId:string;note?:string}) {
    return this.projectCommand(ctx,'project/confirmReview',input,'review.confirm',p => lifecycle.confirmReview(this.db,this.now(),p.memberId,input))
  }
  private projectCommand(ctx:CommandContext,action:string,input:{projectId:string},capability:string,apply:(p:Principal)=>Record<string,unknown>) {
    return this.command(ctx,action,input,()=>{
      const p=this.principal(ctx)
      requireHuman(p); requireCapability(p,capability)
      if(ctx.channel!=='ui') throw denied('项目发布与人工确认只能通过UI通道')
      const project=lifecycle.projectRow(this.db,input.projectId)
      if(project.status==='archived') throw stateInvalid('归档项目不能修改')
      const result=apply(p),at=this.now(),revision=project.revision+1
      this.db.prepare('UPDATE project SET revision=?,updated_at=? WHERE id=?').run(revision,at,project.id)
      writeChange(this.db,{objectKind:'project',objectId:project.id,revision,changeKind:action.split('/')[1],at})
      const auditId=this.audit(ctx,p,{action,subjectKind:'project',subjectId:project.id,before:{revision:project.revision},after:{...input,...result}})
      return this.receipt(ctx,{status:'applied',objectId:project.id,objectRevision:revision,auditId,detail:result})
    })
  }

  /** 记一条指标读数；`value=null` 表示缺数（界面必须显示「未知」而不是达标）。 */
  recordMetric(ctx: CommandContext, input: ObservationInput): CommandReceipt {
    return this.command(ctx, 'project/recordMetric', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.metricRecord)
      const at = this.now()
      const observation = insertObservation(this.db, this.id, at, input)
      writeChange(this.db, {
        objectKind: 'project',
        objectId: input.projectId,
        revision: 0,
        changeKind: 'metric.observed',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'project/recordMetric',
        subjectKind: 'metric_observation',
        subjectId: observation.id,
        after: {
          projectId: input.projectId,
          metricId: observation.metricId,
          value: observation.value,
          windowStart: observation.windowStart,
          windowEnd: observation.windowEnd,
        },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: input.projectId,
        auditId,
        detail: { observationId: observation.id, metricId: observation.metricId },
      })
    })
  }

  private projectActions(principal: Principal, detail: ProjectDetail): string[] {
    const has = (capability: string): boolean =>
      principal.kind === 'system' || principal.capabilities.has(capability)
    const actions: string[] = []
    if (detail.status !== 'archived' && has(CAPABILITY.projectCreate)) actions.push('createWorkItem')
    if (principal.kind === 'human' && has(CAPABILITY.projectManage)) {
      if (detail.status === 'draft') actions.push('publish')
      if (detail.status === 'active') actions.push('pause')
      if (detail.status === 'paused') actions.push('resume')
    }
    if (principal.kind === 'human' && has('project.archive') && detail.status !== 'archived') actions.push('archive')
    // 草稿可以回到新建向导继续填；归档后可以删除（软删）。
    if (principal.kind === 'human' && has(CAPABILITY.projectCreate) && detail.status === 'draft') actions.push('continueDraft')
    if (principal.kind === 'human' && has('project.archive') && detail.status === 'archived') actions.push('delete')
    if (principal.kind === 'human' && has(CAPABILITY.projectManage) && detail.status !== 'archived') actions.push('manageMemory')
    return actions
  }

  // ───────────────────────── 人机成员（M6） ─────────────────────────

  listMembers(
    ctx: CommandContext,
    filter: { kind?: string; status?: string; limit?: number } = {},
  ): MemberSummary[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    return queryMembers(this.db, this.now(), filter)
  }

  getMemberDetail(ctx: CommandContext, memberId: string) {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const detail = queryMember(this.db, this.now(), memberId)
    const actions: string[] = []
    const canManage = principal.kind === 'human' && principal.capabilities.has('member.manage')
    if (canManage && memberId !== principal.memberId && detail.kind !== 'system') {
      if (detail.status === 'active') actions.push('pause', 'retire')
      if (detail.status === 'paused') actions.push('resume', 'retire')
      if (detail.status === 'retired') actions.push('resume')
    }
    if (canManage && detail.kind === 'bot' && detail.status !== 'retired') actions.push('publishConfig')
    const bot_versions = this.db.prepare('SELECT * FROM member_version WHERE member_id=? ORDER BY version DESC').all(memberId).map((v:any) => ({...v,memory_scope:JSON.parse(v.memory_scope_json),skills:this.db.prepare('SELECT * FROM member_version_skill WHERE member_version_id=?').all(v.id),responsibility:(this.db.prepare("SELECT after_json FROM audit_log WHERE subject_kind='member' AND subject_id=? AND action IN ('member/publishConfig','member/create') ORDER BY created_at DESC,rowid DESC").all(memberId) as any[]).map(a=>JSON.parse(a.after_json)).find(a=>a.versionId===v.id || a.version===v.version)?.responsibility ?? null}))
    return { ...detail, bot_versions, memories: queryMemberMemories(this.db, memberId), activity: memberActivity(this.db,this.now(),memberId,this.timeZone), allowedActions: actions }
  }

  listPositions(ctx: CommandContext): PositionSummary[] {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    return queryPositions(this.db)
  }

  createMember(ctx: CommandContext, input: CreateMemberInput): CommandReceipt {
    return this.command(ctx, 'member/create', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, 'member.manage')
      const at = this.now()
      const created = insertMemberRow(this.db, this.id, at, principal.memberId, input)
      writeChange(this.db, {
        objectKind: 'member',
        objectId: created.id,
        revision: created.version,
        changeKind: 'created',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'member/create',
        subjectKind: 'member',
        subjectId: created.id,
        after: { kind: created.kind, version: created.version, capabilities: created.capabilities, responsibility: input.responsibility ?? '', model: input.model ?? null, agentPreset: input.agentPreset ?? null, memoryScope: {} },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: created.id,
        objectRevision: created.version,
        auditId,
        detail: { kind: created.kind, capabilities: created.capabilities },
      })
    })
  }

  publishMemberConfig(ctx:CommandContext,input:PublishConfigInput) {
    return this.command(ctx,'member/publishConfig',input,()=>{
      const p=this.principal(ctx);requireHuman(p);requireCapability(p,'member.manage')
      if(ctx.channel!=='ui')throw denied('配置发布只能通过UI通道')
      const at=this.now(),result=publishConfig(this.db,this.id,at,p.memberId,input)
      writeChange(this.db,{objectKind:'member',objectId:input.memberId,revision:result.version,changeKind:'config_published',at})
      const auditId=this.audit(ctx,p,{action:'member/publishConfig',subjectKind:'member',subjectId:input.memberId,after:result})
      return this.receipt(ctx,{status:'applied',objectId:input.memberId,objectRevision:result.version,auditId,detail:result})
    })
  }

  updateMemberStatus(
    ctx: CommandContext,
    input: { memberId: string; status: string },
  ): CommandReceipt {
    return this.command(ctx, 'member/status', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, 'member.manage')
      const at = this.now()
      const change = applyMemberStatus(this.db, at, principal.memberId, input.memberId, input.status)
      writeChange(this.db, {
        objectKind: 'member',
        objectId: input.memberId,
        revision: 0,
        changeKind: `status:${change.after}`,
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'member/status',
        subjectKind: 'member',
        subjectId: input.memberId,
        before: { status: change.before },
        after: { status: change.after, closedPositions: change.closedPositions },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: input.memberId,
        auditId,
        detail: change,
      })
    })
  }

  // ───────────────────────── 知识（M6，真实来源） ─────────────────────────

  private knowledgeOrThrow(): KnowledgeService {
    if (!this.knowledgeService) {
      throw new HamsError('HOST_CAPABILITY_MISSING', '知识数据源未配置（缺少 dataDir）', {
        nextStep: '检查插件配置的 dataDir 是否为空',
      })
    }
    return this.knowledgeService
  }

  listKnowledge(
    ctx: CommandContext,
    filter: { kind?: string; q?: string; limit?: number } = {},
  ): KnowledgeListResult {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    return this.knowledgeOrThrow().list(filter)
  }

  getKnowledge(
    ctx: CommandContext,
    input: { kind: string; id: string },
  ): (KnowledgeItem | DocDetail | SkillDetail | TableDetail) & { allowedActions: string[] } {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const detail = this.knowledgeOrThrow().get(input.kind, input.id)
    const actions: string[] = []
    const canWrite = principal.kind === 'system' || principal.capabilities.has(CAPABILITY.knowledgeWrite)
    if (detail.kind === 'doc' && canWrite) {
      if ('source_kind' in detail && detail.source_kind === 'hams') actions.push('edit')
      if ('status' in detail && detail.status === 'draft') actions.push('publish')
    }
    if (detail.kind === 'skill' && principal.kind === 'human' && principal.capabilities.has(CAPABILITY.knowledgeSync)) {
      actions.push('sync')
    }
    return { ...detail, allowedActions: actions }
  }

  /** 技能镜像 + 业务表结构登记，来源都是本机真实数据；重复执行幂等。 */
  syncKnowledge(ctx: CommandContext): CommandReceipt {
    return this.command(ctx, 'knowledge/sync', {}, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.knowledgeSync)
      const at = this.now()
      const report: SyncReport = this.knowledgeOrThrow().sync(principal.memberId)
      writeChange(this.db, {
        objectKind: 'knowledge',
        objectId: 'sync',
        revision: 0,
        changeKind: 'synced',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'knowledge/sync',
        subjectKind: 'knowledge',
        subjectId: 'sync',
        after: {
          skills: { created: report.skills.created, updated: report.skills.updated, unchanged: report.skills.unchanged },
          tables: { created: report.tables.created, updated: report.tables.updated },
        },
      })
      return this.receipt(ctx, { status: 'applied', auditId, detail: { report } })
    })
  }

  /** 新建一律是草稿：发布必须走 `publishKnowledgeDoc`（人），避免 bot 或界面绕过发布关卡。 */
  createKnowledgeDoc(
    ctx: CommandContext,
    input: { title: string; body: string },
  ): CommandReceipt {
    return this.command(ctx, 'knowledge/createDoc', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.knowledgeWrite)
      const at = this.now()
      const created = this.knowledgeOrThrow().createDoc(principal.memberId, {
        title: input.title,
        body: input.body,
        status: 'draft',
      })
      writeChange(this.db, {
        objectKind: 'kb_doc',
        objectId: created.id,
        revision: created.revision,
        changeKind: 'created',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'knowledge/createDoc',
        subjectKind: 'kb_doc',
        subjectId: created.id,
        after: { title: input.title, revision: created.revision, path: created.path },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: created.id,
        objectRevision: created.revision,
        auditId,
        detail: { path: created.path },
      })
    })
  }

  updateKnowledgeDoc(
    ctx: CommandContext,
    input: { docId: string; title?: string; body: string; expectedRevision?: number },
  ): CommandReceipt {
    return this.command(ctx, 'knowledge/updateDoc', input, () => {
      const principal = this.principal(ctx)
      requireCapability(principal, CAPABILITY.knowledgeWrite)
      const allowForeign = principal.kind === 'system' || principal.capabilities.has('member.manage')
      const at = this.now()
      const updated = this.knowledgeOrThrow().updateDoc(
        principal.memberId,
        input.docId,
        { title: input.title, body: input.body, expectedRevision: input.expectedRevision },
        allowForeign,
      )
      writeChange(this.db, {
        objectKind: 'kb_doc',
        objectId: input.docId,
        revision: updated.revision,
        changeKind: 'updated',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'knowledge/updateDoc',
        subjectKind: 'kb_doc',
        subjectId: input.docId,
        after: { revision: updated.revision, title: input.title ?? null },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: input.docId,
        objectRevision: updated.revision,
        auditId,
        detail: { path: updated.path },
      })
    })
  }

  publishKnowledgeDoc(ctx: CommandContext, input: { docId: string }): CommandReceipt {
    return this.command(ctx, 'knowledge/publishDoc', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.knowledgeWrite)
      const allowForeign = principal.capabilities.has('member.manage')
      const at = this.now()
      const published = this.knowledgeOrThrow().publishDoc(principal.memberId, input.docId, allowForeign)
      writeChange(this.db, {
        objectKind: 'kb_doc',
        objectId: input.docId,
        revision: 0,
        changeKind: 'published',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'knowledge/publishDoc',
        subjectKind: 'kb_doc',
        subjectId: input.docId,
        after: { status: published.status },
      })
      return this.receipt(ctx, { status: 'applied', objectId: input.docId, auditId, detail: published })
    })
  }

  /** 导入本机目录里的 Markdown（只登记路径与哈希，不复制文件）。 */
  importKnowledgeDocs(
    ctx: CommandContext,
    input: { dir: string; recursive?: boolean; maxFiles?: number },
  ): CommandReceipt {
    return this.command(ctx, 'knowledge/importDocs', input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.knowledgeWrite)
      const at = this.now()
      const report: ImportReport = this.knowledgeOrThrow().importDocs(principal.memberId, input)
      writeChange(this.db, {
        objectKind: 'knowledge',
        objectId: report.dir,
        revision: 0,
        changeKind: 'imported',
        at,
      })
      const auditId = this.audit(ctx, principal, {
        action: 'knowledge/importDocs',
        subjectKind: 'knowledge',
        subjectId: report.dir,
        after: { scanned: report.scanned, imported: report.imported, updated: report.updated, skipped: report.skipped },
      })
      return this.receipt(ctx, { status: 'applied', auditId, detail: { report } })
    })
  }

  // ───────────────────────── 内部：事务边界与幂等 ─────────────────────────

  private command<T extends object>(
    ctx: CommandContext,
    action: string,
    payload: T,
    run: () => CommandReceipt,
  ): CommandReceipt {
    const payloadHash = hashPayload(payload)
    const scopeKey = ctx.idempotencyKey
      ? receiptScopeKey(ctx.principalId, action, ctx.idempotencyKey)
      : null

    if (this.db.isTransaction) throw new HamsError('STATE_INVALID', '命令不能在已有事务内执行')

    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (scopeKey) {
        const stored = loadReceipt(this.db, scopeKey)
        if (stored) {
          if (stored.payloadHash !== payloadHash) {
            throw new HamsError('IDEMPOTENCY_MISMATCH', '同一幂等键收到了不同载荷', {
              nextStep: '换一个幂等键重试',
            })
          }
          const receipt = JSON.parse(stored.receiptJson) as CommandReceipt
          this.db.exec('COMMIT')
          return receipt
        }
      }
      // Replay precedes optimistic locking: retrying a committed command must return its original receipt.
      const target = payload as Record<string, unknown>
      if (ctx.expectedRevision !== undefined) {
        let current: number | undefined
        if (typeof target.workItemId === 'string') current = this.workItemOrThrow(target.workItemId).revision
        else if (typeof target.projectId === 'string') current = lifecycle.projectRow(this.db,target.projectId).revision
        else if (typeof target.memberId === 'string') current = (this.db.prepare('SELECT current_version FROM member WHERE id=?').get(target.memberId) as {current_version:number}|undefined)?.current_version
        if (current !== undefined && current !== ctx.expectedRevision) throw new HamsError('VERSION_CONFLICT',`对象修订号已变：期望 ${ctx.expectedRevision}，当前 ${current}`)
      }
      const receipt = run()
      if (scopeKey) {
        saveReceipt(this.db, {
          scopeKey,
          commandId: ctx.correlationId,
          principalId: ctx.principalId,
          action,
          payloadHash,
          receiptJson: JSON.stringify(receipt),
          at: this.now(),
        })
      }
      this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private principal(ctx: CommandContext): Principal {
    return resolvePrincipal(this.db, ctx.principalId, this.now())
  }

  private receipt(
    ctx: CommandContext,
    input: {
      status: CommandReceipt['status']
      objectId?: string
      objectRevision?: number
      executionEpoch?: number
      approvalId?: string
      auditId: string
      detail?: Record<string, unknown>
    },
  ): CommandReceipt {
    return {
      ok: input.status !== 'rejected',
      status: input.status,
      objectId: input.objectId,
      objectRevision: input.objectRevision,
      executionEpoch: input.executionEpoch,
      approvalId: input.approvalId,
      auditId: input.auditId,
      correlationId: ctx.correlationId,
      detail: input.detail,
    }
  }

  private audit(
    ctx: CommandContext,
    principal: Principal,
    entry: {
      action: string
      subjectKind: string
      subjectId: string
      before?: unknown
      after?: unknown
    },
  ): string {
    const auditId = this.id()
    writeAudit(this.db, auditId, {
      actorId: principal.memberId,
      actorKind: principal.kind,
      onBehalfOf: ctx.onBehalfOf ?? null,
      channel: ctx.channel,
      authSubject: ctx.authSubject ?? null,
      hostPreset: ctx.hostPreset ?? null,
      action: entry.action,
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      before: entry.before,
      after: entry.after,
      correlationId: ctx.correlationId,
      at: this.now(),
    })
    return auditId
  }

  // ───────────────────────── 内部：工作项与关联行 ─────────────────────────

  private factory(): WorkItemFactory {
    return { db: this.db, ids: this.id, now: this.now, timeZone: this.timeZone }
  }

  private createWorkItemTx(
    _ctx: CommandContext,
    principal: Principal,
    input: CreateWorkItemTxInput,
  ): WorkItemRow {
    return insertWorkItem(this.factory(), {
      domain: input.domain,
      category: input.category,
      title: input.title,
      ownerHumanId: input.ownerHumanId,
      projectId: input.projectId ?? null,
      templateVersionId: input.templateVersionId ?? null,
      assetId: input.assetId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy,
      actorKind: principal.kind,
    })
  }

  private upsertAsset(input: { externalSystem: string; externalId: string; displayName: string; kind?: string }): string {
    const existing = this.db
      .prepare('SELECT id FROM asset WHERE external_system = ? AND external_id = ?')
      .get(input.externalSystem, input.externalId) as { id: string } | undefined
    if (existing) return existing.id
    const assetId = this.id()
    this.db
      .prepare(
        `INSERT INTO asset (id, external_system, external_id, kind, display_name) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(assetId, input.externalSystem, input.externalId, input.kind ?? 'battery', input.displayName)
    return assetId
  }

  private ensureThreadTx(principal: Principal, item: WorkItemRow, sessionId?: string): ThreadRow {
    const active = this.db
      .prepare(
        `SELECT * FROM work_item_thread
          WHERE work_item_id = ? AND member_id = ? AND status IN ('active','pending_rotate')
          ORDER BY generation DESC LIMIT 1`,
      )
      .get(item.id, principal.memberId) as ThreadRow | undefined
    if (active) {
      const major = this.db.prepare("SELECT version FROM member_version WHERE member_id=? AND version>? AND change_class='major' ORDER BY version DESC LIMIT 1").get(principal.memberId,active.member_version)
      if (!major && active.status === 'active') return active
      if (!sessionId || sessionId === active.session_id) throw new HamsError('HOST_CAPABILITY_MISSING','配置大改或会话达到换代条件，需要宿主创建新会话',{nextStep:'创建新会话后带新sessionId认领'})
      this.closeThreadTx(item.id,major?'config_major':'rotation',this.now())
    }
    if (!sessionId || !sessionId.trim()) {
      throw new HamsError('HOST_CAPABILITY_MISSING', '新建线程需要宿主会话 id', {
        nextStep: '先由宿主创建会话，再带着 sessionId 认领',
      })
    }
    const taken = this.db.prepare('SELECT work_item_id FROM work_item_thread WHERE session_id = ?').get(sessionId) as
      | { work_item_id: string }
      | undefined
    if (taken) throw stateInvalid(`会话已绑定到其它工作项：${sessionId}`)
    const maxGen = this.db
      .prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM work_item_thread WHERE work_item_id = ?')
      .get(item.id) as { g: number }
    const threadId = this.id()
    this.db
      .prepare(
        `INSERT INTO work_item_thread
           (id, work_item_id, generation, session_id, member_id, member_version, status, turn_count,
            rotate_after_turns, rotate_after_days, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 200, 30, ?)`,
      )
      .run(threadId, item.id, Number(maxGen.g) + 1, sessionId, principal.memberId, principal.currentVersion, this.now())
    return this.db.prepare('SELECT * FROM work_item_thread WHERE id = ?').get(threadId) as ThreadRow
  }

  private closeThreadTx(workItemId: string, reason: string, at: number): void {
    this.db
      .prepare(
        `UPDATE work_item_thread
            SET status = 'closed', closed_at = ?, close_reason = ?
          WHERE work_item_id = ? AND status IN ('active','pending_rotate')`,
      )
      .run(at, reason, workItemId)
  }

  private resolveApproverTx(policy: ReviewPolicy, item: WorkItemRow, at: number): string {
    if (policy.approver === 'owner') {
      const owner = this.memberOrThrow(item.owner_human_id)
      if (owner.kind !== 'human') throw denied('负责人不是人，无法作为审批人')
      return item.owner_human_id
    }
    const positionId = policy.approver.slice('position:'.length)
    const row = this.db
      .prepare(
        `SELECT mp.member_id AS member_id
           FROM member_position mp
           JOIN member m ON m.id = mp.member_id AND m.kind = 'human' AND m.status = 'active'
          WHERE mp.position_id = ? AND mp.starts_at <= ? AND (mp.ends_at IS NULL OR mp.ends_at > ?)
          ORDER BY mp.starts_at DESC LIMIT 1`,
      )
      .get(positionId, at, at) as { member_id: string } | undefined
    if (!row) throw denied(`岗位 ${positionId} 当前没有在岗的人，无法解析审批人`, '安排在岗人员或改用 owner 审批')
    return row.member_id
  }

  private requestChannel(ctx: CommandContext): 'tool' | 'ui' | 'system' {
    if (ctx.channel === 'tool') return 'tool'
    if (ctx.channel === 'ui') return 'ui'
    return 'system'
  }

  // ───────────────────────── 内部：生命周期通用 ─────────────────────────

  private transitionCommand(
    ctx: CommandContext,
    action: string,
    input: { workItemId: string; reason?: string },
    kind: 'pause' | 'resume' | 'cancel' | 'reopen' | 'retry',
  ): CommandReceipt {
    return this.command(ctx, action, input, () => {
      const principal = this.principal(ctx)
      requireHuman(principal)
      requireCapability(principal, CAPABILITY.workItemManage)
      const at = this.now()
      const item = this.workItemOrThrow(input.workItemId)

      let target: string
      let resumeState: string | null = null
      if (kind === 'pause') {
        if (item.status === 'paused') throw stateInvalid('工作项已经暂停')
        target = 'paused'
        resumeState = item.status
      } else if (kind === 'resume') {
        if (item.status !== 'paused' || !item.resume_state) throw stateInvalid('工作项不在暂停状态')
        target = item.resume_state
      } else if (kind === 'cancel') {
        target = 'cancelled'
      } else if (kind === 'reopen') {
        target = 'ready'
      } else {
        target = 'ready'
      }
      this.assertTransition(item.status, target)

      // 联动必须在升修订号之前做：否则 work_item 的修订号一变，pending 审批会先被
      // trg_wi_change_invalidates_approval 标成 invalidated，T9 要求的 withdrawn 就落不了地。
      const linkage = this.bumpEpochLinkageTx(item.id, at)

      this.db
        .prepare(
          `UPDATE work_item
              SET status = ?, resume_state = ?, revision = revision + 1, execution_epoch = execution_epoch + 1,
                  updated_at = ?${kind === 'reopen' ? ', completed_at = NULL' : ''}
            WHERE id = ?`,
        )
        .run(target, resumeState, at, item.id)
      let after = this.workItemOrThrow(item.id)
      if (kind === 'resume' && target === 'waiting_check') {
        const previous = this.db.prepare('SELECT * FROM work_item_check WHERE work_item_id=? ORDER BY generation DESC LIMIT 1').get(item.id) as CheckRow | undefined
        if (previous) {
          const generation = after.check_generation + 1, checkId = this.id()
          this.db.prepare("INSERT INTO work_item_check (id,work_item_id,generation,execution_epoch,template_version_id,planned_due_at,status,created_at) VALUES (?,?,?,?,?,?,'scheduled',?)").run(checkId,item.id,generation,after.execution_epoch,previous.template_version_id,previous.planned_due_at,at)
          this.db.prepare('UPDATE work_item SET check_generation=?,next_action_at=?,revision=revision+1 WHERE id=?').run(generation,Math.max(at,previous.planned_due_at),item.id)
          if (previous.planned_due_at <= at && after.assignee_id) {
            const thread = this.db.prepare("SELECT * FROM work_item_thread WHERE work_item_id=? AND member_id=? AND status='active' ORDER BY generation DESC LIMIT 1").get(item.id,after.assignee_id) as ThreadRow | undefined
            if (thread) {
              const fence=after.fence_seq+1, runId=this.id()
              this.db.prepare('UPDATE work_item SET fence_seq=?,revision=revision+1 WHERE id=?').run(fence,item.id)
              this.db.prepare("INSERT INTO task_run (id,work_item_id,thread_id,check_id,member_id,member_version,execution_epoch,runtime_epoch,fence,trigger,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'check','queued',?)").run(runId,item.id,thread.id,checkId,thread.member_id,thread.member_version,after.execution_epoch,this.runtimeEpoch,fence,at)
              this.db.prepare("UPDATE work_item_check SET status='running' WHERE id=?").run(checkId)
              writeChange(this.db,{objectKind:'task_run',objectId:runId,revision:1,changeKind:'check_run_queued',at})
            }
          }
        }
      }
      after = this.workItemOrThrow(item.id)
      writeEvent(this.db, this.id(), {
        workItemId: item.id,
        kind: `work_item_${kind}`,
        actorId: principal.memberId,
        actorKind: 'human',
        payload: { from: item.status, to: target, reason: input.reason ?? '', linkage },
        revision: after.revision,
        executionEpoch: after.execution_epoch,
        at,
      })
      writeChange(this.db, { objectKind: 'work_item', objectId: item.id, revision: after.revision, changeKind: kind, at })
      const auditId = this.audit(ctx, principal, {
        action,
        subjectKind: 'work_item',
        subjectId: item.id,
        before: { status: item.status, executionEpoch: item.execution_epoch },
        after: { status: target, executionEpoch: after.execution_epoch, linkage },
      })
      return this.receipt(ctx, {
        status: 'applied',
        objectId: item.id,
        objectRevision: after.revision,
        executionEpoch: after.execution_epoch,
        auditId,
        detail: { status: target, linkage },
      })
    })
  }

  /** T9 的「六件事」里与其它表联动的部分；epoch/revision 已在同一条 UPDATE 里升过。 */
  private bumpEpochLinkageTx(workItemId: string, at: number): Record<string, number> {
    const runs = this.db
      .prepare(
        `UPDATE task_run SET status = 'cancelled', finished_at = ?
          WHERE work_item_id = ? AND status IN ('queued','running')`,
      )
      .run(at, workItemId)
    const checks = this.db
      .prepare(
        `UPDATE work_item_check SET status = 'cancelled'
          WHERE work_item_id = ? AND status = 'scheduled'`,
      )
      .run(workItemId)
    const approvals = this.db
      .prepare(
        `UPDATE approval SET status = 'withdrawn'
          WHERE subject_id = ? AND subject_kind IN ('work_item_close','evidence_override','asset_disposal')
            AND status = 'pending'`,
      )
      .run(workItemId)
    const outbox = this.db
      .prepare(
        `UPDATE outbox SET status = 'cancelled'
          WHERE work_item_id = ? AND status = 'pending'`,
      )
      .run(workItemId)
    const leases = this.db.prepare('DELETE FROM lease WHERE work_item_id = ?').run(workItemId)
    return {
      cancelledRuns: Number(runs.changes),
      cancelledChecks: Number(checks.changes),
      withdrawnApprovals: Number(approvals.changes),
      cancelledOutbox: Number(outbox.changes),
      releasedLeases: Number(leases.changes),
    }
  }

  private assertTransition(from: string, to: string): void {
    const row = this.db
      .prepare('SELECT command FROM work_item_transition WHERE from_status = ? AND to_status = ?')
      .get(from, to) as { command: string } | undefined
    if (!row) throw stateInvalid(`状态转换不在白名单：${from} → ${to}`)
  }

  private allowedActions(principal: Principal, item: WorkItemRow): string[] {
    const actions: string[] = []
    const has = (capability: string): boolean => principal.kind === 'system' || principal.capabilities.has(capability)
    if (item.status === 'ready' && has(CAPABILITY.workItemAccept) && principal.kind === 'human') actions.push('accept')
    if (item.status === 'ready' && has(CAPABILITY.workItemClaim) && principal.kind === 'bot') actions.push('claim')
    if (item.status === 'waiting_review' && has(CAPABILITY.approvalDecide)) actions.push('decideApproval')
    if (['active', 'waiting_check', 'waiting_review', 'blocked'].includes(item.status) && has(CAPABILITY.workItemRequestClosure) && !this.db.prepare("SELECT id FROM approval WHERE subject_id=? AND subject_kind='work_item_close' AND status='pending' AND expires_at>? LIMIT 1").get(item.id,this.now())) {
      actions.push('requestClosure')
    }
    if (has(CAPABILITY.evidenceAppend)) actions.push('addEvidence')
    if (['ready','active'].includes(item.status) && has(principal.kind === 'bot' ? CAPABILITY.workItemExecute : CAPABILITY.workItemManage)) actions.push('reportBlocker')
    if (principal.kind === 'human' && has(CAPABILITY.workItemManage)) {
      if (!(TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status)) { actions.push('cancel'); if(item.status !== 'paused') actions.push('pause') }
      if (item.status === 'paused') actions.push('resume')
      if (item.status === 'completed') actions.push('reopen')
      if (item.status === 'failed') actions.push('retry')
      if (item.status === 'blocked') actions.push('unblock')
      if (!(TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status) && item.assignee_id && this.db.prepare("SELECT id FROM member WHERE id=? AND kind='bot' AND status='active'").get(item.assignee_id) && !this.db.prepare("SELECT id FROM task_run WHERE work_item_id=? AND status='running'").get(item.id)) actions.push('rotateThread')
    }
    return actions
  }

  // ───────────────────────── 内部：取行与工具 ─────────────────────────

  private workItemOrThrow(id: string): WorkItemRow {
    const row = this.db.prepare('SELECT * FROM work_item WHERE id = ?').get(id) as WorkItemRow | undefined
    if (!row) throw stateInvalid(`工作项不存在：${id}`)
    return row
  }

  private runOrThrow(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM task_run WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw stateInvalid(`运行不存在：${id}`)
    return row
  }

  private checkOrThrow(id: string): CheckRow {
    const row = this.db.prepare('SELECT * FROM work_item_check WHERE id = ?').get(id) as CheckRow | undefined
    if (!row) throw stateInvalid(`复查不存在：${id}`)
    return row
  }

  private approvalOrThrow(id: string): ApprovalRow {
    const row = this.db.prepare('SELECT * FROM approval WHERE id = ?').get(id) as ApprovalRow | undefined
    if (!row) throw stateInvalid(`审批不存在：${id}`)
    return row
  }

  private memberOrThrow(id: string): { kind: string; id: string } {
    const row = this.db.prepare('SELECT id, kind FROM member WHERE id = ?').get(id) as
      | { id: string; kind: string }
      | undefined
    if (!row) throw stateInvalid(`成员不存在：${id}`)
    return row
  }

  private templateVersionTx(id: string | null | undefined): TemplateVersionRow | null {
    if (!id) return null
    const row = this.db.prepare('SELECT * FROM work_template_version WHERE id = ?').get(id) as
      | TemplateVersionRow
      | undefined
    return row ?? null
  }

  private evidenceRows(workItemId: string): EvidenceRow[] {
    return this.db
      .prepare('SELECT * FROM evidence WHERE work_item_id = ? ORDER BY id')
      .all(workItemId) as EvidenceRow[]
  }

  /** 领域函数只认 camelCase 快照，避免把 snake_case 行直接喂给哈希（那样会全员 undefined）。 */
  private evidenceSnapshots(workItemId: string): EvidenceSnapshotRow[] {
    return this.evidenceRows(workItemId).map((row) => ({
      id: row.id,
      kind: row.kind,
      contentHash: row.content_hash,
      observedAt: row.observed_at,
      status: row.status,
    }))
  }

  private findOpenByDedupeKey(dedupeKey: string | null | undefined): WorkItemRow | null {
    if (!dedupeKey) return null
    const placeholders = OPEN_ITEM_STATUSES.map(() => '?').join(',')
    const row = this.db
      .prepare(`SELECT * FROM work_item WHERE dedupe_key = ? AND status IN (${placeholders}) LIMIT 1`)
      .get(dedupeKey, ...OPEN_ITEM_STATUSES) as WorkItemRow | undefined
    return row ?? null
  }

  private readRuntimeEpoch(): number {
    const row = this.db.prepare("SELECT value FROM hams_meta WHERE key = 'runtime_epoch'").get() as
      | { value: string }
      | undefined
    return Number(row?.value ?? 0)
  }

  private parseJsonObject(json: string | null | undefined): Record<string, unknown> {
    if (!json || !json.trim()) return {}
    try {
      const parsed = JSON.parse(json) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}

export type { CriteriaSnapshot }
