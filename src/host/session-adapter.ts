/** Real DSH agent lifecycle. Business rows only hold host session references; no transcript IO. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { HamsError } from '../domain/errors.ts'
import type { HamsService } from '../service/hams.ts'
import type { CommandContext, CommandReceipt, RunRow, ThreadRow, WorkItemRow } from '../service/types.ts'
import { CAPABILITY, requireCapability, requireHuman, resolvePrincipal } from '../service/permissions.ts'
import { TOOL_NAMES } from '../service/tools.ts'
import { HAMS_BOT_PRESET } from './bot-preset.ts'

export interface HostAgent {
  session: { id: string }
  status?: string
  followup(message: unknown): void
  cancel(cause: { kind: 'user' }, options: { keepInbox: true }): unknown
}
export interface HostAgentHandle { agent: HostAgent; dispose(): unknown | Promise<unknown> }
export interface HostAgents {
  create(options: { sessionId: string; meta: Record<string, unknown>; agentOptions: Record<string, unknown>; setup?: unknown }): Promise<HostAgentHandle>
  resume(options: { resumeSessionId: string; agentOptions: Record<string, unknown>; setup?: unknown }): Promise<HostAgentHandle>
}
export interface BotConfig { memberId: string; memberName: string; version: number; agentPreset: string; model: string | null; prompt: string }
export interface SessionAdapterOptions {
  db: DatabaseSync
  service: HamsService
  agents: HostAgents
  dataDir: string
  /** SDK createUserMessage, injected so tests never import/start the host runtime. */
  createUserMessage(input: { content: { type: 'text'; text: string }[]; source: { kind: 'user' } }): unknown
  /** Must resolve/mount the named preset, installModelSelection, and bind configured model. */
  compose(config: BotConfig): Promise<{ agentOptions: Record<string, unknown>; setup?: unknown; agentPreset?: string | null }>
  /** 成员配置里没写 preset 时的兜底（HAMS 自带 hams-bot）。 */
  defaultPreset?: string
  now?: () => number
  timeZone?: string
  sessionId?: () => string
}
export interface RunFacts {
  stateAndEpoch: unknown
  evidenceAndHashes: unknown
  taskAndCriteria: unknown
  approvalsAndBlockers: unknown
  budgetAndCapabilities: unknown
}

/** Only the SDK-owned Agent session is trusted. Flat sessionId and model arguments are ignored. */
export function hostToolContext(exec: unknown): { sessionId: string; callId?: string } {
  const value = exec as { agent?: { session?: { id?: unknown } }; callId?: unknown } | undefined
  const id = value?.agent?.session?.id
  return { sessionId: typeof id === 'string' ? id : '', ...(typeof value?.callId === 'string' ? { callId: value.callId } : {}) }
}

export function buildRunFacts(db: DatabaseSync, runId: string, now = Date.now(), timeZone = 'Asia/Shanghai'): RunFacts {
  const run = db.prepare('SELECT * FROM task_run WHERE id=?').get(runId) as RunRow | undefined
  if (!run) throw new HamsError('STATE_INVALID', `运行不存在：${runId}`)
  const item = db.prepare('SELECT * FROM work_item WHERE id=?').get(run.work_item_id) as WorkItemRow
  const template = item.template_version_id ? db.prepare('SELECT * FROM work_template_version WHERE id=?').get(item.template_version_id) : null
  // 配了别的宿主 preset 时人设不由 hams-bot 提供，把提示词塞进事实快照，保证这一轮看得到。
  const version = db.prepare('SELECT prompt, agent_preset FROM member_version WHERE member_id=? AND version=?').get(run.member_id, run.member_version) as { prompt: string | null; agent_preset: string | null } | undefined
  const botPrompt = version && version.agent_preset && version.agent_preset !== HAMS_BOT_PRESET ? String(version.prompt || '').trim() : ''
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  const utc = new Date(`${date}T00:00:00Z`)
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7))
  const week = utc.toISOString().slice(0, 10)
  const budgets = item.project_id ? db.prepare(`SELECT period_kind,period_start,metric,used,limit_value,
    MAX(0,limit_value-used) AS remaining FROM project_budget WHERE project_id=?
    AND ((period_kind='day' AND period_start=?) OR (period_kind='week' AND period_start=?)) ORDER BY period_kind,metric`).all(item.project_id, date, week) : []
  return {
    stateAndEpoch: { workItemId: item.id, status: item.status, revision: item.revision, executionEpoch: item.execution_epoch, fence: run.fence, runtimeEpoch: run.runtime_epoch },
    evidenceAndHashes: { evidenceSetHash: item.evidence_set_hash, evidence: db.prepare("SELECT id,kind,ref,content_hash,observed_at,source FROM evidence WHERE work_item_id=? AND status='active' ORDER BY id").all(item.id) },
    taskAndCriteria: { runId, trigger: run.trigger, checkId: run.check_id, title: item.title, memberVersion: run.member_version, templateVersion: template ?? null, ...(botPrompt ? { botPrompt } : {}) },
    approvalsAndBlockers: { blockedReason: item.blocked_reason, approvals: db.prepare("SELECT id,status,reason_text,expires_at FROM approval WHERE subject_kind='work_item_close' AND subject_id=? AND status='pending' ORDER BY id").all(item.id) },
    budgetAndCapabilities: {
      budgets,
      permissions: db.prepare('SELECT capability,scope FROM member_permission WHERE member_id=? ORDER BY capability,scope').all(run.member_id),
      // 政策白名单为空 ≠ 没有工具：HAMS 工具是全局注册的，真实可用。把两者分开写，避免 bot 误判「tools 为空所以干不了」。
      toolPolicy: db.prepare('SELECT tool_name FROM member_tool_policy WHERE member_id=? AND enabled=1 ORDER BY tool_name').all(run.member_id),
      hamsTools: [...TOOL_NAMES],
      toolPolicyNote: 'toolPolicy 是额外白名单；hamsTools 一定可用。宿主另有全局工具（如 working_directory）。',
    },
  }
}

export class HamsSessionAdapter {
  private options: SessionAdapterOptions
  private handles = new Map<string, Promise<HostAgentHandle>>()
  private locks = new Map<string, Promise<unknown>>()
  private delivered = new Set<string>()
  private closed = false
  constructor(options: SessionAdapterOptions) { this.options = options }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.closed) throw new HamsError('HOST_CAPABILITY_MISSING', '会话适配器已停止')
      return fn()
    })
    this.locks.set(key, next)
    void next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key) }).catch(() => {})
    return next
  }
  private thread(workItemId: string): ThreadRow | undefined {
    return this.options.db.prepare("SELECT * FROM work_item_thread WHERE work_item_id=? AND status IN ('active','pending_rotate') ORDER BY generation DESC LIMIT 1").get(workItemId) as ThreadRow | undefined
  }
  private config(memberId: string, version?: number): BotConfig {
    const row = this.options.db.prepare(`SELECT v.*,m.status,m.kind,m.name FROM member_version v JOIN member m ON m.id=v.member_id WHERE v.member_id=? AND v.version=${version === undefined ? 'm.current_version' : '?'}`).get(...(version === undefined ? [memberId] : [memberId, version])) as { version: number; agent_preset: string; model: string | null; prompt: string | null; name: string; kind: string; status: string } | undefined
    if (!row || row.kind !== 'bot' || row.status !== 'active') throw new HamsError('HOST_CAPABILITY_MISSING', 'bot 没有有效且已发布的宿主 preset')
    return { memberId, memberName: row.name, version: row.version, agentPreset: row.agent_preset || this.options.defaultPreset || '', model: row.model, prompt: row.prompt || '' }
  }
  private needsRotation(thread: ThreadRow): boolean {
    return thread.status === 'pending_rotate' || Boolean(this.options.db.prepare("SELECT 1 FROM member_version WHERE member_id=? AND version>? AND change_class='major'").get(thread.member_id, thread.member_version))
  }
  /** 宿主调用加超时：预设挂载/建会话卡住时不能让派发器永远停在 dispatching=true。 */
  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HamsError('HOST_CAPABILITY_MISSING', `${label}超时（${ms}ms）`, { nextStep: '检查宿主 agents 服务与 bot preset 是否可用；必要时重启 DSH' })), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async open(config: BotConfig, existing?: string, cwdKey?: string): Promise<HostAgentHandle> {
    if (existing && this.handles.has(existing)) return this.handles.get(existing)!
    const id = existing ?? (this.options.sessionId ?? (() => `session-${randomUUID()}`))()
    if (!id.trim() || this.handles.has(id)) throw new HamsError('STATE_INVALID', '宿主会话 id 重复或为空')
    const pending = (async () => {
      const composition = await this.withTimeout(this.options.compose(config), 20_000, '组合 bot 预设')
      const { agentPreset: composedPreset, ...rest } = composition
      const presetId = composedPreset ?? config.agentPreset
      // 一个 bot 可能同时是多个工作项的负责人：工作项各占一个子目录，不和别的任务混在一起。
      const cwd = path.resolve(this.options.dataDir, 'bots', config.memberId, 'work', String(cwdKey || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'default')
      const base = path.resolve(this.options.dataDir, 'bots') + path.sep
      if (!cwd.startsWith(base)) throw new HamsError('POLICY_DENIED', 'bot 工作目录越界')
      await mkdir(cwd, { recursive: true })
      const opening = existing
        ? this.options.agents.resume({ resumeSessionId: id, ...rest })
        : this.options.agents.create({ sessionId: id, meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) }, ...rest })
      let handle: HostAgentHandle
      try {
        handle = await this.withTimeout(opening, 45_000, '宿主创建/恢复会话')
      } catch (error) {
        // 超时后宿主仍可能把会话建出来；一旦回来就释放，避免留下不可见的活句柄。
        void opening.then((late) => late.dispose()).catch(() => {})
        throw error
      }
      if (handle.agent.session.id !== id) { await handle.dispose(); throw new HamsError('HOST_CAPABILITY_MISSING', '宿主返回的会话身份与请求不一致') }
      return handle
    })()
    this.handles.set(id, pending)
    try { return await pending } catch (error) { this.handles.delete(id); throw error }
  }
  async release(sessionId: string): Promise<void> {
    const pending = this.handles.get(sessionId)
    if (!pending) return
    // Keep the entry until disposal completes: another open must not race the writer teardown.
    try { await (await pending).dispose() } finally { this.handles.delete(sessionId) }
  }
  async cancel(sessionId: string): Promise<{ accepted: true }> {
    const thread = this.options.db.prepare('SELECT * FROM work_item_thread WHERE session_id=?').get(sessionId) as ThreadRow | undefined
    if (!thread) throw new HamsError('POLICY_DENIED', '会话未绑定 HAMS 工作项')
    const handle = await this.open(this.config(thread.member_id, thread.member_version), sessionId, thread.work_item_id)
    await handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }
  async claim(ctx: CommandContext, input: { workItemId: string }): Promise<CommandReceipt> {
    return this.serial(input.workItemId, async () => {
      const { service } = this.options
      const item = service.getWorkItem(ctx, input.workItemId)
      if (item.status !== 'ready') throw new HamsError('STATE_INVALID', '只有 ready 的工作项可以认领')
      const principal = resolvePrincipal(this.options.db, ctx.principalId, this.now())
      // 系统派发替被指派的 bot 认领：execute 就够（与 service.claim 的 system 分支一致）。
      if (ctx.channel === 'system' && !principal.capabilities.has(CAPABILITY.workItemClaim)) {
        requireCapability(principal, CAPABILITY.workItemExecute)
      } else {
        requireCapability(principal, CAPABILITY.workItemClaim)
      }
      const thread = this.thread(item.id)
      const fresh = !thread || this.needsRotation(thread) || thread.member_id !== ctx.principalId
      const handle = await this.open(this.config(ctx.principalId, fresh ? undefined : thread!.member_version), fresh ? undefined : thread!.session_id, item.id)
      try {
        const receipt = service.claim(ctx, { workItemId: item.id, sessionId: handle.agent.session.id })
        if (thread && thread.session_id !== handle.agent.session.id) await this.release(thread.session_id)
        return receipt
      } catch (error) { if (fresh) await this.release(handle.agent.session.id); throw error }
    })
  }
  async startRun(runId: string, text = ''): Promise<{ sessionId: string; runId: string; accepted: true }> {
    const run = this.options.db.prepare('SELECT * FROM task_run WHERE id=?').get(runId) as RunRow | undefined
    if (!run) throw new HamsError('STATE_INVALID', `运行不存在：${runId}`)
    return this.serial(run.work_item_id, () => this.start(runId, text))
  }
  private async start(runId: string, text: string) {
    const { db, service } = this.options
    const run = db.prepare('SELECT * FROM task_run WHERE id=?').get(runId) as RunRow
    let thread = db.prepare('SELECT * FROM work_item_thread WHERE id=?').get(run.thread_id) as ThreadRow
    if (this.delivered.has(runId)) return { sessionId: thread.session_id, runId, accepted: true as const }
    if (run.status !== 'queued') throw new HamsError('STATE_INVALID', '只能投递 queued 运行；结果不明时不自动重发')
    const rotate = this.needsRotation(thread)
    const oldId = thread.session_id
    const handle = await this.open(this.config(run.member_id, rotate ? undefined : thread.member_version), rotate ? undefined : oldId, run.work_item_id)
    try {
      service.startRun({ principalId: run.member_id, channel: 'system', correlationId: `host-start:${runId}` }, { runId, sessionId: handle.agent.session.id })
      thread = this.thread(run.work_item_id)!
      const facts = buildRunFacts(db, runId, this.now(), this.options.timeZone)
      handle.agent.followup(this.options.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `HAMS 数据库事实快照；本轮以此为准。\n${JSON.stringify(facts)}\n本轮指令：${text || '推进本轮任务，并通过 HAMS 工具提交结果或阻塞。'}` }] }))
      this.delivered.add(runId)
      if (rotate) await this.release(oldId)
      return { sessionId: thread.session_id, runId, accepted: true as const }
    } catch (error) {
      // Admission may have partially succeeded. Never label a host delivery failure as success/retry it blindly.
      db.prepare("UPDATE task_run SET status='unknown',finished_at=?,error_kind='host_delivery_unknown' WHERE id=? AND status='running'").run(this.now(), runId)
      if (rotate && this.thread(run.work_item_id)?.session_id !== handle.agent.session.id) await this.release(handle.agent.session.id)
      throw error
    }
  }
  async rotateThread(ctx: CommandContext, input: { workItemId: string; reason?: string }): Promise<CommandReceipt> {
    return this.serial(input.workItemId, async () => {
      const item = this.options.service.getWorkItem(ctx, input.workItemId)
      this.authorize(ctx)
      if (!item.allowedActions.includes('rotateThread') || !item.assignee_id) throw new HamsError('STATE_INVALID', '当前工作项不能换新会话')
      const old = this.thread(item.id)
      const handle = await this.open(this.config(item.assignee_id), undefined, item.id)
      try {
        const result = this.options.service.rotateThread(ctx, { ...input, sessionId: handle.agent.session.id })
        if (old) await this.release(old.session_id)
        return result
      } catch (error) { await this.release(handle.agent.session.id); throw error }
    })
  }
  async instruct(ctx: CommandContext, input: { workItemId: string; text: string }): Promise<unknown> {
    return this.serial(input.workItemId, async () => {
      this.authorize(ctx)
      if (!input.text?.trim()) throw new HamsError('STATE_INVALID', '追加指令不能为空')
      const item = this.options.service.getWorkItem(ctx, input.workItemId)
      if (['completed','cancelled','failed','paused'].includes(item.status)) throw new HamsError('STATE_INVALID', '当前工作项不接受追加指令')
      const run = this.options.db.prepare("SELECT * FROM task_run WHERE work_item_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(item.id) as RunRow | undefined
      if (!run) throw new HamsError('STATE_INVALID', '没有待执行或正在运行的轮次；请先重试或等待复查')
      if (run.status === 'queued') return this.start(run.id, input.text)
      const thread = this.thread(item.id)
      if (!thread || thread.status !== 'active') throw new HamsError('STATE_INVALID', '当前会话已等待换代')
      const handle = await this.open(this.config(thread.member_id, thread.member_version), thread.session_id, item.id)
      handle.agent.followup(this.options.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `HAMS 最新事实：\n${JSON.stringify(buildRunFacts(this.options.db, run.id, this.now(), this.options.timeZone))}\n追加指令：${input.text}` }] }))
      return { sessionId: thread.session_id, runId: run.id, accepted: true }
    })
  }
  /**
   * 指派型任务：ready + 有 bot 负责人 + 没有排队/在跑的轮次 → 替它认领并投递这一轮。
   * 这是「bot 给 bot 分派任务」的落地点：协调 bot 只负责指派，真正的执行在被指派 bot 自己的会话里。
   */
  async dispatchAssignments(limit = 10): Promise<{ started: number; errors: string[] }> {
    const rows = this.options.db
      .prepare(
        `SELECT i.id, i.assignee_id FROM work_item i JOIN member m ON m.id = i.assignee_id
          WHERE i.status = 'ready' AND m.kind = 'bot' AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM task_run r WHERE r.work_item_id = i.id AND r.status IN ('queued','running'))
          ORDER BY i.updated_at LIMIT ?`,
      )
      .all(limit) as { id: string; assignee_id: string }[]
    const report = { started: 0, errors: [] as string[] }
    for (const row of rows) {
      try {
        const receipt = await this.claim({ principalId: row.assignee_id, channel: 'system', correlationId: `assign:${row.id}` }, { workItemId: row.id })
        const runId = receipt.detail && typeof receipt.detail === 'object' ? (receipt.detail as { runId?: string }).runId : undefined
        if (runId) await this.startRun(runId)
        report.started++
      } catch (error) {
        report.errors.push(`${row.id}: ${this.errorText(error)}`)
      }
    }
    return report
  }

  private errorText(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) return `${(error as { code?: string }).code}: ${(error as { message?: string }).message ?? ''}`
    return String(error)
  }

  /** Call after each business tick. No recovery of unknown/running deliveries. */
  async dispatchQueued(limit = 20): Promise<{ started: number; errors: string[] }> {
    const rows = this.options.db.prepare("SELECT id FROM task_run WHERE status='queued' ORDER BY created_at LIMIT ?").all(limit) as { id: string }[]
    const report = { started: 0, errors: [] as string[] }
    for (const row of rows) try { await this.startRun(row.id); report.started++ } catch (error) { report.errors.push(`${row.id}: ${String(error)}`) }
    return report
  }
  private authorize(ctx: CommandContext) {
    const principal = resolvePrincipal(this.options.db, ctx.principalId, this.now())
    requireHuman(principal); requireCapability(principal, CAPABILITY.workItemManage)
    if (ctx.channel !== 'ui') throw new HamsError('POLICY_DENIED', '人工会话操作只接受 UI 通道')
  }
  private now() { return (this.options.now ?? Date.now)() }
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.locks.values()])
    for (const id of [...this.handles.keys()]) await this.release(id)
  }
}
