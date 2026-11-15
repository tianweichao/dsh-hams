/**
 * 对话：单聊（智能体）与群聊（项目）。
 *
 * 这一层只管「把谁放到哪个宿主会话里」以及线程指针的存取，不碰消息正文：
 * - 单聊 = 与某个 bot 的常驻会话；
 * - 群聊 = 项目推进 bot（coordinator）的常驻会话，群里其他人的工作进展由它查工作项来回答。
 *
 * 会话本身由宿主 `agents` 创建/恢复，消息从会话日志读（`sessionQuery`），
 * HAMS 库只存 `chat:<kind>:<id>` 这个指针，避免把聊天正文再抄一份。
 * 宿主没有 agent 服务时（只读实例 / sdk-minimal 之外的部署），
 * 所有对话接口返回 HOST_CAPABILITY_MISSING 和下一步，而不是假装成功。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { HamsError } from '../domain/errors.ts'
import { createIdFactory, type IdFactory } from '../domain/ids.ts'
import { CAPABILITY, requireCapability, resolvePrincipal } from './permissions.ts'
import type { CommandContext } from './types.ts'
import {
  createMemory,
  extractMemoryCandidates,
  MEMORY_KIND_LABEL,
  memberMemoryBlock,
  projectMemoryBlock,
  type MemoryKind,
} from './memory.ts'

export type ChatKind = 'member' | 'project'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
  /** 会话事件序号；群聊合并记录用它做水位，避免重复。 */
  seq?: number
}

export interface ChatPresetRow {
  id: string
  name?: string
  description?: string
  broken?: string
}

export interface ChatModelRow {
  provider: string
  model: string
  label?: string
}

/** 宿主侧能力：由 `src/host/chat-runtime.ts` 实现，测试里用假对象。 */
export interface ChatRuntime {
  readonly available: boolean
  readonly unavailableReason?: string
  ensure(input: {
    sessionId?: string
    key: string
    memberId: string
    memberName: string
    memberVersion: number
    agentPreset: string
    /** 成员版本里的提示词；hams-bot 用它生成 persona，别的 preset 用它写上下文。 */
    prompt?: string
    model: string | null
    title: string
    /** 首次建会话时注入的上下文（不显示在聊天记录里），告诉 bot 它是谁、在哪个项目里。 */
    context?: string
  }): Promise<{ sessionId: string }>
  send(sessionId: string, text: string): Promise<void>
  read(sessionId: string): Promise<{ messages: ChatMessage[]; running: boolean; error?: string }>
  /** 群聊里单个成员是否在跑（没有会话就 false）。 */
  status?(sessionId: string): Promise<{ running: boolean; error?: string }>
  /** 只看进程内存里的 agent 状态（不读会话日志）；团队页轮询用。 */
  liveStatus?(sessionId: string): { live: boolean; running: boolean }
  /** 宿主当前默认模型；bot 没配模型时用它，而不是建一个注定报错的会话。 */
  defaultModel?(): Promise<{ provider: string; model: string } | null>
  stop(sessionId: string): Promise<void>
  presets(): Promise<ChatPresetRow[]>
  models(): Promise<ChatModelRow[]>
  /** 会话目录（轻量 header），用来发现 bot 起的子代理；宿主没有就不做发现。 */
  listSessions?(): Promise<Array<{ id: string; parentSession?: string; origin?: string; createdAt: number; cwd?: string }>>
  /** 读一个会话的原始事件，用来取 `subagent/descriptor` 的 label。 */
  readSessionEvents?(sessionId: string): Promise<readonly unknown[]>
}

/** 任务识别器的输出：开新活 / 改已有工作项状态 / 什么都不做。 */
export type IntakeDecision =
  | { action: 'create'; title: string; reason?: string }
  | { action: 'update'; workItemId: string; status: 'paused' | 'active' | 'cancelled'; reason?: string }
  | { action: 'none'; reason?: string }

/** 识别器已经落地后的结果，用于给人类/bot 留可见记录。 */
export type IntakeOutcome =
  | { kind: 'create'; workItemId: string; title: string; created: boolean }
  | { kind: 'update'; workItemId: string; title: string; status: 'paused' | 'active' | 'cancelled'; changed: boolean }

/** 群聊/单聊的任务识别：由宿主侧接一个独立模型调用实现，ChatService 只等结果。 */
export interface WorkIntake {
  registerFromMessage(input: {
    projectId: string
    senderId: string
    text: string
    messageId: string
    mentionedMemberId: string | null
    /** 最近几条群聊/单聊，帮模型理解「这个/刚才」。 */
    recent?: string
  }): Promise<IntakeOutcome | null>
}

export interface ChatPeer {
  kind: ChatKind
  targetId: string
  title: string
  memberId: string
  memberName: string
  memberVersion: number
  agentPreset: string
  model: string | null
  /** 当前版本的人设提示词。 */
  prompt: string
}

export interface ChatThreadView extends ChatPeer {
  sessionId: string
  createdAt: number
  updatedAt: number
}

interface ThreadPointer {
  sessionId: string
  memberId: string
  memberVersion: number
  agentPreset: string
  model: string | null
  /** 建会话时冻结的提示词；读历史/恢复会话时用。 */
  prompt?: string
  at: number
}


export type TeamKind = 'coordinator' | 'member' | 'temp' | 'subagent'

export interface TeamMemberView {
  memberId: string
  name: string
  kind: TeamKind
  status: string
  brief: string
  sessionId: string | null
  running: boolean
}

export interface GroupMessageView {
  id: string
  authorKind: 'human' | 'bot' | 'system'
  authorId: string
  authorName: string
  text: string
  at: number
  kind: 'chat' | 'mention' | 'system'
  toMemberId: string | null
}

export interface GroupChatView {
  projectId: string
  title: string
  coordinator: TeamMemberView | null
  members: TeamMemberView[]
  messages: GroupMessageView[]
  running: boolean
  available: boolean
  reason?: string
  error?: string
}

const DEFAULT_BOT_PRESET = 'hams-bot'

/**
 * 成员配了别的宿主 preset 时，人设不由 hams-bot 提供，把提示词写进会话上下文；
 * 默认 hams-bot 由 `bot-preset.ts` 直接生成 persona，不再重复注入。
 */
function promptContextBlock(prompt: string | null | undefined, preset: string): string {
  const text = String(prompt || '').trim()
  if (!text || !preset || preset === DEFAULT_BOT_PRESET) return ''
  return `\n【你的设定（成员配置发布；与通用说明冲突时以这里为准）】\n${text}`
}

/** 子代理自己的任务提示词：第一条「创建之后、source=user」的消息。fork 继承的历史早于 createdAt，不会被误取。 */
function subagentTaskPrompt(events: readonly unknown[], createdAt: number): string {
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: string; time?: number; data?: { source?: { kind?: string }; content?: unknown } }
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    if (Number(event.time || 0) < Number(createdAt || 0)) continue
    const content = Array.isArray(event.data.content) ? event.data.content : []
    const text = content
      .filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text')
      .map((block) => String((block as { text?: unknown }).text ?? ''))
      .join('\n')
      .trim()
    if (text) return text.slice(0, 8192)
  }
  return ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class ChatService {
  private db: DatabaseSync
  private runtime: ChatRuntime
  private now: () => number
  private id: IdFactory

  private intake?: WorkIntake

  constructor(options: { db: DatabaseSync; runtime: ChatRuntime; now?: () => number; idFactory?: IdFactory; intake?: WorkIntake }) {
    this.db = options.db
    this.runtime = options.runtime
    this.now = options.now ?? (() => Date.now())
    this.id = options.idFactory ?? createIdFactory(this.now)
    this.intake = options.intake
  }

  get available(): boolean {
    return this.runtime.available
  }

  get reason(): string | undefined {
    return this.runtime.unavailableReason
  }

  private human(ctx: CommandContext): void {
    const row = this.db
      .prepare("SELECT kind FROM member WHERE id = ?")
      .get(ctx.principalId) as { kind: string } | undefined
    if (!row || row.kind !== 'human') {
      throw new HamsError('POLICY_DENIED', '只有人能发起对话；bot 之间不私下传话', {
        nextStep: 'bot 的协作通过工作项与提议，不通过对话',
      })
    }
  }

  /** 解析对话对象：单聊落到 bot 本人，群聊落到项目推进 bot。 */
  private peer(ctx: CommandContext, kind: ChatKind, targetId: string): ChatPeer {
    this.human(ctx)
    if (kind === 'project') {
      const project = this.db
        .prepare('SELECT id, name, coordinator_id, deleted_at FROM project WHERE id = ?')
        .get(targetId) as { id: string; name: string; coordinator_id: string | null; deleted_at: number | null } | undefined
      if (!project || project.deleted_at) throw new HamsError('STATE_INVALID', `项目不存在：${targetId}`, { nextStep: '刷新项目列表后重试' })
      if (!project.coordinator_id) {
        throw new HamsError('STATE_INVALID', '这个项目还没有推进 bot，群聊没有回答的人', {
          nextStep: '在项目详情里指定「推进 bot」（新建或编辑项目时可以选），再进群聊',
        })
      }
      return { ...this.bot(project.coordinator_id), kind, targetId, title: project.name }
    }
    const bot = this.bot(targetId)
    return { ...bot, kind: 'member', targetId, title: bot.memberName }
  }

  private bot(memberId: string): { memberId: string; memberName: string; memberVersion: number; agentPreset: string; model: string | null; prompt: string } {
    const member = this.db
      .prepare('SELECT id, name, status, kind, current_version FROM member WHERE id = ?')
      .get(memberId) as { id: string; name: string; status: string; kind: string; current_version: number } | undefined
    if (!member || member.kind !== 'bot') throw new HamsError('STATE_INVALID', `不是 bot 成员：${memberId}`)
    if (member.status !== 'active') {
      throw new HamsError('STATE_INVALID', `bot 当前不在岗（${member.status}），先恢复在岗再对话`, {
        nextStep: '在智能体详情里点「恢复在岗」',
      })
    }
    const version = Number(member.current_version || 0)
    const config = version
      ? (this.db
          .prepare('SELECT agent_preset, model, prompt FROM member_version WHERE member_id = ? AND version = ?')
          .get(memberId, version) as { agent_preset: string | null; model: string | null; prompt: string | null } | undefined)
      : undefined
    return {
      memberId,
      memberName: member.name,
      memberVersion: version,
      agentPreset: (config?.agent_preset || '').trim() || DEFAULT_BOT_PRESET,
      model: config?.model ?? null,
      prompt: config?.prompt || '',
    }
  }

  private pointer(kind: ChatKind, targetId: string): ThreadPointer | null {
    const row = this.db
      .prepare('SELECT value FROM hams_meta WHERE key = ?')
      .get(`chat:${kind}:${targetId}`) as { value: string } | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value) as ThreadPointer
      return parsed && typeof parsed.sessionId === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  private savePointer(kind: ChatKind, targetId: string, pointer: ThreadPointer): void {
    this.db
      .prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)")
      .run(`chat:${kind}:${targetId}`, JSON.stringify(pointer))
    // 反向索引：工具层凭 sessionId 认人，聊天会话也要能解析出是哪个 bot。
    this.db
      .prepare("INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)")
      .run(`chat:session:${pointer.sessionId}`, pointer.memberId)
  }

  private requireRuntime(): void {
    if (!this.runtime.available) {
      throw new HamsError('HOST_CAPABILITY_MISSING', this.runtime.unavailableReason || '宿主没有提供 agent 会话服务', {
        nextStep: '确认 DSH 运行时带 agents / sessionQuery 服务后重启插件；只读实例不能开对话',
      })
    }
  }

  /**
   * 打开（必要时创建）对话。配置版本、preset 或模型变了就换一个新会话，
   * 旧会话留在宿主里可查，但当前对话只跟最新配置走。
   */
  async open(ctx: CommandContext, input: { kind: ChatKind; targetId: string }): Promise<ChatThreadView> {
    const peer = this.peer(ctx, input.kind, input.targetId)
    this.requireRuntime()
    const existing = this.pointer(input.kind, input.targetId)
    // bot 没配模型就用宿主默认模型；两边都没有就明确拒绝，不要建一个「发了没反应」的会话。
    let model = peer.model
    if (!model) {
      const fallback = this.runtime.defaultModel ? await this.runtime.defaultModel() : null
      model = fallback ? `${fallback.provider}/${fallback.model}` : null
    }
    if (!model) {
      throw new HamsError('HOST_CAPABILITY_MISSING', `${peer.memberName} 没有配置模型，宿主也没有默认模型`, {
        nextStep: '在智能体「配置」里选一个模型并保存；或在宿主设置里指定默认模型',
      })
    }
    const sameConfig =
      existing &&
      existing.memberId === peer.memberId &&
      existing.memberVersion === peer.memberVersion &&
      existing.agentPreset === peer.agentPreset &&
      (existing.model || null) === model
    const context = (input.kind === 'project'
      ? `你在 HAMS 项目《${peer.title}》（projectId=${input.targetId}）的群聊里，是这个项目的推进 bot。`
        + '你可以用 hams_list_project_work 查这个项目的工作项进展，用 hams_assign_task 把 ready 工作项指派给其他 bot；'
        + '关单与审批只能由人做。用中文简短回答。'
        + (projectMemoryBlock(this.db, input.targetId) ? `\n${projectMemoryBlock(this.db, input.targetId)}` : '')
      : `你在 HAMS 里作为《${peer.memberName}》与人类单聊，身份是成员 ${peer.memberId}。`
        + '涉及工作项时用 HAMS 工具读写事实，不要编造状态；关单与审批只能由人做。用中文简短回答。'
        + (memberMemoryBlock(this.db, peer.memberId) ? `\n${memberMemoryBlock(this.db, peer.memberId)}` : ''))
      + promptContextBlock(peer.prompt, peer.agentPreset)
    const { sessionId } = await this.runtime.ensure({
      sessionId: sameConfig ? existing.sessionId : undefined,
      key: `chat:${input.kind}:${input.targetId}`,
      memberId: peer.memberId,
      memberName: peer.memberName,
      memberVersion: peer.memberVersion,
      agentPreset: peer.agentPreset,
      prompt: peer.prompt,
      model,
      title: input.kind === 'project' ? `项目群聊 · ${peer.title}` : `单聊 · ${peer.memberName}`,
      context,
    })
    const at = Date.now()
    const pointer: ThreadPointer = {
      sessionId,
      memberId: peer.memberId,
      memberVersion: peer.memberVersion,
      agentPreset: peer.agentPreset,
      model,
      prompt: peer.prompt,
      at,
    }
    if (!sameConfig || !existing) this.savePointer(input.kind, input.targetId, pointer)
    return { ...peer, model, sessionId, createdAt: existing?.at ?? at, updatedAt: at }
  }

  /** 单聊时反查这个 bot 唯一能代表的项目：优先它推进的项目，其次唯一参与的项目。 */
  private projectForBot(memberId: string): string | null {
    const coordinated = this.db
      .prepare("SELECT id FROM project WHERE coordinator_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY updated_at DESC")
      .all(memberId) as { id: string }[]
    if (coordinated.length === 1) return coordinated[0].id
    if (coordinated.length > 1) return null
    const joined = this.db
      .prepare(
        `SELECT p.id FROM project_participant pp JOIN project p ON p.id = pp.project_id
          WHERE pp.member_id = ? AND pp.removed_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
          ORDER BY pp.added_at DESC`,
      )
      .all(memberId) as { id: string }[]
    return joined.length === 1 ? joined[0].id : null
  }

  private intakeSystemText(outcome: IntakeOutcome): string {
    if (outcome.kind === 'create') return `已把这条消息登记为工作项《${outcome.title}》（${outcome.workItemId}）`
    const label = { paused: '暂停', active: '继续', cancelled: '取消' }[outcome.status] || outcome.status
    return `已把工作项《${outcome.title}》状态改为「${label}」`
  }

  private intakeNote(outcome: IntakeOutcome | null): string {
    if (!outcome) return ''
    if (outcome.kind === 'create') {
      return `【系统】人类这句话已经登记为工作项 ${outcome.workItemId}《${outcome.title}》${outcome.created ? '' : '（此前已存在，直接复用）'}；直接用它推进或派活，不要重复建单。\n\n`
    }
    return `【系统】人类这句话已经更新工作项 ${outcome.workItemId}《${outcome.title}》的状态${outcome.changed ? '' : '（此前已是该状态）'}；不要再重复处理。\n\n`
  }

  /** 人发出的一条消息是否要建单/改状态；返回要附加给 bot 的提示。 */
  private async intakeNoteFor(ctx: CommandContext, thread: ChatThreadView, text: string): Promise<string> {
    if (!this.intake) return ''
    const projectId = thread.kind === 'project' ? thread.targetId : this.projectForBot(thread.memberId)
    if (!projectId) return ''
    let recent = ''
    try {
      const view = await this.runtime.read(thread.sessionId)
      recent = view.messages
        .slice(-4)
        .map((message) => `${message.role}: ${message.text.slice(0, 200)}`)
        .join('\n')
    } catch {
      recent = ''
    }
    const result = await this.intake.registerFromMessage({
      projectId,
      senderId: ctx.principalId,
      text,
      messageId: `msg-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mentionedMemberId: null,
      recent,
    })
    return this.intakeNote(result)
  }

  async send(ctx: CommandContext, input: { kind: ChatKind; targetId: string; text: string }): Promise<{ sessionId: string; accepted: true }> {
    const text = String(input.text || '').trim()
    if (!text) throw new HamsError('STATE_INVALID', '消息不能为空')
    if (text.length > 8000) throw new HamsError('STATE_INVALID', '单条消息不能超过 8000 字')
    const thread = await this.open(ctx, { kind: input.kind, targetId: input.targetId })
    // 单聊里把 bot 从项目同步过来的能力记忆带进每一轮，不依赖会话首次创建的上下文。
    const memory = thread.kind === 'member' ? memberMemoryBlock(this.db, thread.memberId) : ''
    // 单聊/项目会话同样自动识别新活；识别结果作为系统提示附在这条消息前面。
    let intakeNote = ''
    try { intakeNote = await this.intakeNoteFor(ctx, thread, text) } catch { intakeNote = '' }
    const body = memory ? `${memory}\n\n${text}` : text
    await this.runtime.send(thread.sessionId, intakeNote ? `${intakeNote}${body}` : body)
    return { sessionId: thread.sessionId, accepted: true }
  }

  async read(ctx: CommandContext, input: { kind: ChatKind; targetId: string }): Promise<{ thread: ChatThreadView | null; messages: ChatMessage[]; running: boolean; available: boolean; reason?: string; error?: string }> {
    this.human(ctx)
    if (!this.runtime.available) {
      return { thread: null, messages: [], running: false, available: false, reason: this.runtime.unavailableReason || '宿主没有提供 agent 会话服务' }
    }
    const pointer = this.pointer(input.kind, input.targetId)
    if (!pointer) return { thread: null, messages: [], running: false, available: true }
    let peer: ChatPeer
    try {
      peer = this.peer(ctx, input.kind, input.targetId)
    } catch (error) {
      // 目标暂时不可用（bot 停岗 / 项目没推进 bot）：把已有消息照常返回，界面只显示提示。
      peer = {
        kind: input.kind,
        targetId: input.targetId,
        title: input.kind === 'project' ? '项目' : '智能体',
        memberId: pointer.memberId,
        memberName: '',
        memberVersion: pointer.memberVersion,
        agentPreset: pointer.agentPreset,
        model: pointer.model,
        prompt: pointer.prompt || '',
      }
    }
    const { messages, running, error } = await this.runtime.read(pointer.sessionId)
    return {
      thread: { ...peer, sessionId: pointer.sessionId, createdAt: pointer.at, updatedAt: pointer.at },
      messages,
      running,
      available: true,
      ...(error ? { error } : {}),
    }
  }

  async stop(ctx: CommandContext, input: { kind: ChatKind; targetId: string }): Promise<{ stopped: true }> {
    this.human(ctx)
    this.requireRuntime()
    const pointer = this.pointer(input.kind, input.targetId)
    if (!pointer) throw new HamsError('STATE_INVALID', '还没有对话可以停止')
    await this.runtime.stop(pointer.sessionId)
    return { stopped: true }
  }

  async presets(): Promise<ChatPresetRow[]> {
    if (!this.runtime.available) return []
    return this.runtime.presets()
  }

  async models(): Promise<ChatModelRow[]> {
    if (!this.runtime.available) return []
    return this.runtime.models()
  }

  // ───────────────────────── 项目群：团队与多 bot 群聊 ─────────────────────────

  private projectRow(projectId: string): { id: string; name: string; coordinator_id: string | null; owner_human_id: string; status: string } {
    const row = this.db
      .prepare('SELECT id, name, coordinator_id, owner_human_id, status, deleted_at FROM project WHERE id = ?')
      .get(projectId) as
      | { id: string; name: string; coordinator_id: string | null; owner_human_id: string; status: string; deleted_at: number | null }
      | undefined
    if (!row || row.deleted_at) throw new HamsError('STATE_INVALID', `项目不存在：${projectId}`, { nextStep: '刷新项目列表后重试' })
    return row
  }

  private memberRow(memberId: string): { id: string; name: string; kind: string; status: string } | undefined {
    return this.db.prepare('SELECT id, name, kind, status FROM member WHERE id = ?').get(memberId) as
      | { id: string; name: string; kind: string; status: string }
      | undefined
  }

  private participantRow(projectId: string, memberId: string): { kind: 'member' | 'temp'; brief: string; removed_at: number | null } | undefined {
    return this.db
      .prepare('SELECT kind, brief, removed_at FROM project_participant WHERE project_id = ? AND member_id = ?')
      .get(projectId, memberId) as { kind: 'member' | 'temp'; brief: string; removed_at: number | null } | undefined
  }

  private requireProjectAdmin(ctx: CommandContext): ReturnType<typeof resolvePrincipal> {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    if (principal.kind !== 'human') {
      throw new HamsError('POLICY_DENIED', '只有项目管理员能手动调整团队成员；推进 bot 请用 hams_group_spawn_bot', {
        nextStep: '让管理员在项目「团队」里加人',
      })
    }
    requireCapability(principal, CAPABILITY.projectManage)
    return principal
  }

  private pointerAt(key: string): ThreadPointer | null {
    const row = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.value) as ThreadPointer
      return parsed && typeof parsed.sessionId === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  private savePointerAt(key: string, pointer: ThreadPointer): void {
    this.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(pointer))
    this.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(`chat:session:${pointer.sessionId}`, pointer.memberId)
  }

  /** 群聊里某个成员自己的会话 key；推进 bot 沿用 chat:project:<id>，旧消息不断。 */
  private groupKey(projectId: string, memberId: string, isCoordinator: boolean): string {
    return isCoordinator ? `chat:project:${projectId}` : `chat:group:${projectId}:${memberId}`
  }

  private async ensureGroupSession(
    project: { id: string; name: string },
    member: { memberId: string; memberName: string; memberVersion: number; agentPreset: string; model: string | null; prompt: string },
    isCoordinator: boolean,
    context: string,
  ): Promise<{ sessionId: string; running: boolean }> {
    this.requireRuntime()
    const key = this.groupKey(project.id, member.memberId, isCoordinator)
    const existing = this.pointerAt(key)
    let model = member.model
    if (!model) {
      const fallback = this.runtime.defaultModel ? await this.runtime.defaultModel() : null
      model = fallback ? `${fallback.provider}/${fallback.model}` : null
    }
    if (!model) {
      throw new HamsError('HOST_CAPABILITY_MISSING', `${member.memberName} 没有配置模型，宿主也没有默认模型`, {
        nextStep: '在智能体「配置」里选一个模型并保存；或在宿主设置里指定默认模型',
      })
    }
    const same = Boolean(
      existing &&
        existing.memberVersion === member.memberVersion &&
        existing.agentPreset === member.agentPreset &&
        (existing.model || null) === model,
    )
    const { sessionId } = await this.runtime.ensure({
      sessionId: same ? existing!.sessionId : undefined,
      key,
      memberId: member.memberId,
      memberName: member.memberName,
      memberVersion: member.memberVersion,
      agentPreset: member.agentPreset,
      prompt: member.prompt,
      model,
      title: `项目群 · ${project.name} · ${member.memberName}`,
      context: context + promptContextBlock(member.prompt, member.agentPreset),
    })
    const at = this.now()
    const pointer: ThreadPointer = {
      sessionId,
      memberId: member.memberId,
      memberVersion: member.memberVersion,
      agentPreset: member.agentPreset,
      model,
      prompt: member.prompt,
      at,
    }
    this.savePointerAt(key, pointer)
    this.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(`chat:group:session:${sessionId}`, project.id)
    return { sessionId, running: false }
  }

  /** 群里现在有谁：推进 bot + 参与者（手动加入的常驻 bot 与临时 bot）。 */
  private teamRows(projectId: string): Array<{ memberId: string; name: string; kind: TeamKind; status: string; brief: string; addedAt?: number }> {
    const project = this.projectRow(projectId)
    const rows: Array<{ memberId: string; name: string; kind: TeamKind; status: string; brief: string; addedAt?: number }> = []
    if (project.coordinator_id) {
      const coordinator = this.memberRow(project.coordinator_id)
      if (coordinator) rows.push({ memberId: coordinator.id, name: coordinator.name, kind: 'coordinator', status: coordinator.status, brief: '项目推进 bot：拆任务、分配、汇总' })
    }
    const members = this.db
      .prepare(
        `SELECT pp.member_id, pp.kind, pp.brief, pp.added_at, m.name, m.status
           FROM project_participant pp JOIN member m ON m.id = pp.member_id
          WHERE pp.project_id = ? AND pp.removed_at IS NULL
          ORDER BY pp.added_at`,
      )
      .all(projectId) as Array<{ member_id: string; kind: 'member' | 'temp'; brief: string; added_at: number; name: string; status: string }>
    for (const row of members) {
      // 子代理由 session 事件自动登记，brief 以「子代理」开头；单独一种团队角色，不混进手动建的临时 bot。
      const kind: TeamKind = row.kind === 'temp' && row.brief.startsWith('子代理') ? 'subagent' : row.kind
      rows.push({ memberId: row.member_id, name: row.name, kind, status: row.status, brief: row.brief, addedAt: row.added_at })
    }
    return rows
  }

  private rosterText(projectId: string): string {
    const project = this.projectRow(projectId)
    const rows = this.teamRows(projectId)
    const kindLabel = (kind: TeamKind) => kind === 'coordinator' ? '推进 bot' : kind === 'subagent' ? '子代理' : kind === 'temp' ? '临时 bot' : '成员'
    const lines = rows.map((row) => `- ${row.name}（${kindLabel(row.kind)}，id=${row.memberId}）`)
    return `【项目群 ${project.name}】团队成员：\n${lines.join('\n')}`
  }

  private recentTranscript(projectId: string, limit = 12): string {
    const rows = this.db
      .prepare('SELECT author_name, text, kind, to_member_id FROM project_message WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(projectId, limit) as Array<{ author_name: string; text: string; kind: string; to_member_id: string | null }>
    return rows
      .reverse()
      .map((row) => `${row.author_name}${row.kind === 'mention' ? ' @某人' : ''}：${row.text}`)
      .join('\n')
  }

  private appendGroupMessage(input: {
    projectId: string
    authorKind: 'human' | 'bot' | 'system'
    authorId: string
    authorName: string
    text: string
    kind?: 'chat' | 'mention' | 'system'
    toMemberId?: string | null
    sessionId?: string | null
  }): string {
    const id = this.id()
    this.db
      .prepare(
        `INSERT INTO project_message (id, project_id, author_kind, author_id, author_name, text, at, kind, to_member_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.authorKind,
        input.authorId,
        input.authorName,
        input.text,
        this.now(),
        input.kind || 'chat',
        input.toMemberId ?? null,
        input.sessionId ?? null,
      )
    return id
  }

  /** 把每个成员会话里新产生的助手回复合并进群聊记录（按 seq 游标，幂等）。 */
  private async syncGroup(projectId: string): Promise<void> {
    const project = this.projectRow(projectId)
    const members = this.teamRows(projectId)
    for (const member of members) {
      const isCoordinator = member.kind === 'coordinator'
      const pointer = this.pointerAt(this.groupKey(projectId, member.memberId, isCoordinator))
      if (!pointer) continue
      const cursor = this.db.prepare('SELECT last_seq FROM chat_cursor WHERE session_id = ?').get(pointer.sessionId) as
        | { last_seq: number }
        | undefined
      let lastSeq = cursor?.last_seq ?? 0
      const { messages } = await this.runtime.read(pointer.sessionId)
      for (const message of messages) {
        if (message.role !== 'assistant') continue
        const seq = Number(message.seq ?? 0)
        if (seq <= lastSeq) continue
        const messageId = this.appendGroupMessage({
          projectId,
          authorKind: 'bot',
          authorId: member.memberId,
          authorName: member.name,
          text: message.text,
          kind: 'chat',
          sessionId: pointer.sessionId,
        })
        this.collectMemories(projectId, {
          id: messageId,
          authorKind: 'bot',
          authorId: member.memberId,
          authorName: member.name,
          text: message.text,
        })
        lastSeq = seq
      }
      this.db
        .prepare('INSERT OR REPLACE INTO chat_cursor (session_id, project_id, last_seq) VALUES (?, ?, ?)')
        .run(pointer.sessionId, project.id, lastSeq)
    }
  }

  /** 最近一次扫描子代理的时间；团队页轮询时别每次都翻全部会话。 */
  private lastSubagentScan = 0

  /**
   * DSH 的 subagent 是独立会话（header.origin='subagent'、parentSession=父会话），
   * 不是 HAMS 成员；团队页要看得见，就得把它登记成本项目的一条临时成员。
   * 同一个子会话只登记一次；子代理结束也不删，保留可追溯。
   */
  registerSubagent(input: { childSessionId: string; parentSessionId: string; label?: string; prompt?: string }): { memberId: string } | null {
    const childSessionId = String(input.childSessionId || '').trim()
    const parentSessionId = String(input.parentSessionId || '').trim()
    if (!childSessionId || !parentSessionId) return null
    const mapped = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`subagent:session:${childSessionId}`) as { value: string } | undefined
    if (mapped) {
      try {
        const parsed = JSON.parse(mapped.value) as { memberId?: unknown }
        if (typeof parsed.memberId === 'string' && parsed.memberId) return { memberId: parsed.memberId }
      } catch {
        // 旧值坏了就重新登记，下一段会覆盖
      }
    }
    const project = this.projectRefOfSession(parentSessionId)
    if (!project) return null
    const label = String(input.label || '').trim().slice(0, 40)
    // 子代理自己的任务提示词：能读到就存进版本，团队「查看」里可读可改（只作为 HAMS 记录）。
    const prompt = String(input.prompt || '').trim().slice(0, 8192)
    let name = label || `子代理 ${childSessionId.slice(0, 6)}`
    const clash = this.db.prepare('SELECT 1 AS hit FROM member WHERE name = ?').get(name) as { hit: number } | undefined
    if (clash) name = `${name.slice(0, 34)} · ${childSessionId.slice(0, 4)}`
    const at = this.now()
    const memberId = this.id()
    this.db
      .prepare(
        `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version,
                             owner_human_id, scope_project_id, created_at, updated_at)
         VALUES (?, 'bot', ?, NULL, ?, 'observer', 'active', 1, ?, ?, ?, ?)`,
      )
      .run(memberId, name, label, project.ownerHumanId, project.id, at, at)
    const digest = createHash('sha256').update(`subagent\n${childSessionId}\n${label}`).digest('hex').slice(0, 16)
    this.db
      .prepare(
        `INSERT INTO member_version
           (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
            change_class, published_by, published_at)
         VALUES (?, ?, 1, ?, NULL, '{}', ?, ?, 'major', ?, ?)`,
      )
      .run(this.id(), memberId, 'hams-bot', prompt, digest, project.ownerHumanId, at)
    // 参与关系用 temp（schema 只有 member/temp），brief 前缀让团队页把它识别成「子代理」。
    this.db
      .prepare(
        `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at)
         VALUES (?, ?, 'temp', ?, ?, ?)`,
      )
      .run(project.id, memberId, `子代理 · ${label || childSessionId.slice(0, 6)}`, project.ownerHumanId, at)
    this.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(
      `subagent:session:${childSessionId}`,
      JSON.stringify({ memberId, projectId: project.id }),
    )
    this.db.prepare('INSERT OR REPLACE INTO hams_meta (key, value) VALUES (?, ?)').run(
      `member:${memberId}:subagent`,
      childSessionId,
    )
    return { memberId }
  }

  /** 由父会话反查项目：群会话索引 → 工作项线程 → 单聊后面挂的推进/参与项目。 */
  /** 和公开的 `projectOfSession`（只认群索引）区分：这里要把父会话反查成项目，含工作项线程与单聊。 */
  private projectRefOfSession(sessionId: string): { id: string; ownerHumanId: string } | null {
    if (!sessionId) return null
    const groupProjectId = this.projectOfSession(sessionId)
    if (groupProjectId) {
      const row = this.db.prepare('SELECT id, owner_human_id FROM project WHERE id = ? AND deleted_at IS NULL').get(groupProjectId) as
        | { id: string; owner_human_id: string }
        | undefined
      if (row) return { id: row.id, ownerHumanId: row.owner_human_id }
    }
    const thread = this.db
      .prepare(
        `SELECT w.project_id AS projectId FROM work_item_thread t
           JOIN work_item w ON w.id = t.work_item_id
          WHERE t.session_id = ? AND w.project_id IS NOT NULL
          ORDER BY t.started_at DESC LIMIT 1`,
      )
      .get(sessionId) as { projectId: string } | undefined
    if (thread) {
      const row = this.db.prepare('SELECT id, owner_human_id FROM project WHERE id = ? AND deleted_at IS NULL').get(thread.projectId) as
        | { id: string; owner_human_id: string }
        | undefined
      if (row) return { id: row.id, ownerHumanId: row.owner_human_id }
    }
    const chatMemberId = this.memberOfSession(sessionId)
    if (chatMemberId) {
      const coordinator = this.db
        .prepare('SELECT id, owner_human_id FROM project WHERE coordinator_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1')
        .get(chatMemberId) as { id: string; owner_human_id: string } | undefined
      if (coordinator) return { id: coordinator.id, ownerHumanId: coordinator.owner_human_id }
      const participant = this.db
        .prepare(
          `SELECT p.id, p.owner_human_id FROM project_participant pp JOIN project p ON p.id = pp.project_id
            WHERE pp.member_id = ? AND pp.removed_at IS NULL AND p.deleted_at IS NULL
            ORDER BY pp.added_at DESC LIMIT 1`,
        )
        .get(chatMemberId) as { id: string; owner_human_id: string } | undefined
      if (participant) return { id: participant.id, ownerHumanId: participant.owner_human_id }
    }
    return null
  }

  private subagentSessionOf(memberId: string): string | null {
    const row = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`member:${memberId}:subagent`) as { value: string } | undefined
    return row?.value || null
  }

  /** 给早期登记（prompt 为空）的子代理补任务文本：新增一版配置，不改旧版本。 */
  private backfillSubagentPrompt(memberId: string, prompt: string): void {
    const text = String(prompt || '').trim().slice(0, 8192)
    if (!text) return
    const member = this.db.prepare('SELECT id, current_version, owner_human_id, status FROM member WHERE id = ?').get(memberId) as
      | { id: string; current_version: number; owner_human_id: string; status: string }
      | undefined
    if (!member || member.status === 'retired') return
    const current = this.db.prepare('SELECT * FROM member_version WHERE member_id = ? AND version = ?').get(memberId, member.current_version) as
      | Record<string, any>
      | undefined
    if (!current || String(current.prompt || '').trim()) return
    const at = this.now()
    const version = Number(member.current_version || 0) + 1
    const digest = createHash('sha256').update(`${memberId}\n${text}`).digest('hex').slice(0, 16)
    this.db
      .prepare(
        `INSERT INTO member_version
           (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest,
            change_class, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minor', ?, ?)`,
      )
      .run(this.id(), memberId, version, current.agent_preset ?? 'hams-bot', current.model ?? null, current.memory_scope_json ?? '{}', text, digest, member.owner_human_id, at)
    this.db.prepare('INSERT INTO member_version_skill (member_version_id, skill_id, skill_version_id) SELECT ?, skill_id, skill_version_id FROM member_version_skill WHERE member_version_id = ?').run(
      this.id(),
      current.id,
    )
    this.db.prepare('UPDATE member SET current_version = ?, updated_at = ? WHERE id = ?').run(version, at, memberId)
  }

  /** 轻量补登记：扫最近会话里 origin=subagent 且有 HAMS 父会话的，10 秒最多一次。 */
  private async discoverSubagents(): Promise<void> {
    if (!this.runtime.listSessions || !this.runtime.readSessionEvents) return
    const now = this.now()
    if (now - this.lastSubagentScan < 10_000) return
    this.lastSubagentScan = now
    const sessions = await this.runtime.listSessions()
    const cutoff = now - 7 * 86_400_000
    let budget = 40
    for (const session of sessions) {
      if (!session || session.origin !== 'subagent' || !session.parentSession) continue
      if (!session.id || (session.createdAt && session.createdAt < cutoff)) continue
      const known = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`subagent:session:${session.id}`) as { value: string } | undefined
      let knownMemberId = ''
      if (known) {
        try { knownMemberId = String((JSON.parse(known.value) as { memberId?: unknown }).memberId || '') } catch { knownMemberId = '' }
      }
      if (!knownMemberId) {
        // 先在 HAMS 索引里认父会话，认不出就别读子会话全文（历史里可能有几百条无关记录）。
        if (!this.projectRefOfSession(session.parentSession)) continue
        if (budget <= 0) break
        budget -= 1
      } else {
        // 早一版登记的子代理 prompt 是空的：只给这些存量补读一次，补完就不再读。
        const empty = this.db
          .prepare('SELECT 1 AS hit FROM member m JOIN member_version v ON v.member_id = m.id AND v.version = m.current_version WHERE m.id = ? AND v.prompt = \'\'')
          .get(knownMemberId) as { hit: number } | undefined
        if (!empty) continue
      }
      let label = ''
      let prompt = ''
      try {
        const events = await this.runtime.readSessionEvents(session.id)
        const descriptor = events.find((event) => event && typeof event === 'object' && (event as { type?: string }).type === 'subagent/descriptor') as
          | { data?: { label?: unknown } }
          | undefined
        label = typeof descriptor?.data?.label === 'string' ? descriptor.data.label : ''
        prompt = subagentTaskPrompt(events, session.createdAt || 0)
      } catch {
        label = ''
      }
      if (knownMemberId) this.backfillSubagentPrompt(knownMemberId, prompt)
      else this.registerSubagent({ childSessionId: session.id, parentSessionId: session.parentSession, label, prompt })
    }
  }

  async team(ctx: CommandContext, input: { projectId: string }): Promise<{ projectId: string; title: string; coordinator: TeamMemberView | null; members: TeamMemberView[] }> {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const project = this.projectRow(input.projectId)
    // 先补登记最近的子代理：即使宿主没触发事件（老实例/重启前就在跑），打开团队页也能看到。
    try { await this.discoverSubagents() } catch { /* 发现失败不能影响团队页 */ }
    const rows = this.teamRows(input.projectId)
    const views: TeamMemberView[] = []
    for (const row of rows) {
      const isCoordinator = row.kind === 'coordinator'
      const pointer = this.pointerAt(this.groupKey(input.projectId, row.memberId, isCoordinator))
      // 状态 = 是否还在推进独立对话：群会话 / 单聊 / 子代理会话任一在跑，或还有 running 的执行。
      const childSessionId = row.kind === 'subagent' ? this.subagentSessionOf(row.memberId) : null
      const dmSessionId = this.pointer('member', row.memberId)?.sessionId ?? null
      const watchedSessionIds = [...new Set([pointer?.sessionId, dmSessionId, childSessionId].filter((id): id is string => Boolean(id)))]
      let running = false
      if (watchedSessionIds.length && this.runtime.available) {
        for (const sessionId of watchedSessionIds) {
          try {
            running = this.runtime.liveStatus
              ? this.runtime.liveStatus(sessionId).running
              : this.runtime.status
                ? (await this.runtime.status(sessionId)).running
                : false
          } catch {
            running = false
          }
          if (running) break
        }
      }
      if (!running) {
        const activeRun = this.db.prepare("SELECT 1 AS hit FROM task_run WHERE member_id = ? AND status = 'running' LIMIT 1").get(row.memberId) as { hit: number } | undefined
        running = Boolean(activeRun)
      }
      const watchedSessionId = watchedSessionIds[0] ?? null
      views.push({
        memberId: row.memberId,
        name: row.name,
        kind: row.kind,
        status: row.status,
        brief: row.brief,
        sessionId: watchedSessionId,
        running,
      })
    }
    const coordinator = views.find((row) => row.kind === 'coordinator') ?? null
    return { projectId: input.projectId, title: project.name, coordinator, members: views.filter((row) => row.kind !== 'coordinator') }
  }

  /** 手动把在岗 bot 拉进项目群。重复加入是幂等的（撤销软删）。 */
  addParticipant(ctx: CommandContext, input: { projectId: string; memberId: string }): { ok: true; memberId: string } {
    this.requireProjectAdmin(ctx)
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw new HamsError('STATE_INVALID', '归档/暂停的项目不能再加人')
    if (project.coordinator_id === input.memberId) throw new HamsError('STATE_INVALID', '推进 bot 已经在群里了')
    const bot = this.bot(input.memberId)
    const existing = this.participantRow(input.projectId, input.memberId)
    this.db
      .prepare(
        `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
         VALUES (?, ?, 'member', '', ?, ?, NULL, NULL)
         ON CONFLICT(project_id, member_id) DO UPDATE SET kind = 'member', removed_by = NULL, removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at`,
      )
      .run(input.projectId, input.memberId, ctx.principalId, this.now())
    void existing
    void bot
    return { ok: true, memberId: input.memberId }
  }

  removeParticipant(ctx: CommandContext, input: { projectId: string; memberId: string }): { ok: true } {
    this.requireProjectAdmin(ctx)
    const project = this.projectRow(input.projectId)
    if (project.coordinator_id === input.memberId) throw new HamsError('STATE_INVALID', '推进 bot 不能从群里移除；改项目推进 bot 请走项目设置')
    const row = this.participantRow(input.projectId, input.memberId)
    if (!row || row.removed_at) throw new HamsError('STATE_INVALID', '这个人不在群里')
    const at = this.now()
    this.db
      .prepare('UPDATE project_participant SET removed_at = ?, removed_by = ? WHERE project_id = ? AND member_id = ?')
      .run(at, ctx.principalId, input.projectId, input.memberId)
    if (row.kind === 'temp') {
      this.db
        .prepare("UPDATE member SET status = 'retired', updated_at = ? WHERE id = ? AND status = 'active'")
        .run(at, input.memberId)
      void this.stopGroupSession(input.projectId, input.memberId, false)
    }
    return { ok: true }
  }

  private async stopGroupSession(projectId: string, memberId: string, isCoordinator: boolean): Promise<void> {
    const pointer = this.pointerAt(this.groupKey(projectId, memberId, isCoordinator))
    if (!pointer || !this.runtime.available) return
    try {
      await this.runtime.stop(pointer.sessionId)
    } catch {
      // 会话可能已被宿主回收；停不掉不影响移除
    }
  }

  /**
   * 推进 bot 自己创建临时 bot：只属于这个项目群（member.scope_project_id），
   * 退休时随参与者一起下线。
   */
  spawnTempBot(ctx: CommandContext, input: { projectId: string; name: string; brief?: string }): { memberId: string; name: string } {
    const principal = resolvePrincipal(this.db, ctx.principalId, this.now())
    const project = this.projectRow(input.projectId)
    if (project.status !== 'active') throw new HamsError('STATE_INVALID', '项目不在进行中，不能创建临时 bot')
    const isCoordinator = principal.kind === 'bot' && project.coordinator_id === principal.memberId
    if (principal.kind === 'human') {
      requireCapability(principal, CAPABILITY.projectManage)
    } else if (!isCoordinator) {
      throw new HamsError('POLICY_DENIED', '只有项目推进 bot 或项目管理员能创建临时 bot', {
        nextStep: '让推进 bot 在群里自己建，或让管理员在「团队」里建',
      })
    }
    const name = String(input.name || '').trim()
    if (!name) throw new HamsError('STATE_INVALID', '临时 bot 必须有名字')
    if (name.length > 24) throw new HamsError('STATE_INVALID', '名字最多 24 个字')
    const brief = String(input.brief || '').trim().slice(0, 500)
    const at = this.now()
    const memberId = this.id()
    this.db
      .prepare(
        `INSERT INTO member (id, kind, name, domain, responsibility, role, status, current_version, owner_human_id, scope_project_id, created_at, updated_at)
         VALUES (?, 'bot', ?, NULL, ?, 'executor', 'active', 1, ?, ?, ?, ?)`,
      )
      .run(memberId, name, brief, project.owner_human_id, project.id, at, at)
    const digest = createHash('sha256').update(`${name}\n${brief}`).digest('hex').slice(0, 16)
    this.db
      .prepare(
        `INSERT INTO member_version (id, member_id, version, agent_preset, model, memory_scope_json, prompt, prompt_digest, change_class, published_by, published_at)
         VALUES (?, ?, 1, 'hams-bot', NULL, '{}', ?, ?, 'major', ?, ?)`,
      )
      .run(this.id(), memberId, brief, digest, principal.memberId, at)
    const grant = this.db.prepare('INSERT OR IGNORE INTO member_permission (member_id, capability, scope, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)')
    for (const capability of ['work_item.execute', 'work_item.claim', 'evidence.append']) {
      grant.run(memberId, capability, `project:${project.id}`, principal.memberId, at)
    }
    this.db
      .prepare(
        `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at)
         VALUES (?, ?, 'temp', ?, ?, ?)`,
      )
      .run(project.id, memberId, brief, principal.memberId, at)
    return { memberId, name }
  }

  async groupRead(ctx: CommandContext, input: { projectId: string }): Promise<GroupChatView> {
    resolvePrincipal(this.db, ctx.principalId, this.now())
    const project = this.projectRow(input.projectId)
    if (!this.runtime.available) {
      return { projectId: input.projectId, title: project.name, coordinator: null, members: [], messages: [], running: false, available: false, reason: this.runtime.unavailableReason }
    }
    await this.syncGroup(input.projectId)
    const team = await this.team(ctx, { projectId: input.projectId })
    const rows = this.db
      .prepare('SELECT * FROM project_message WHERE project_id = ? ORDER BY at, id LIMIT 400')
      .all(input.projectId) as Array<{
      id: string
      author_kind: 'human' | 'bot' | 'system'
      author_id: string
      author_name: string
      text: string
      at: number
      kind: 'chat' | 'mention' | 'system'
      to_member_id: string | null
    }>
    const messages: GroupMessageView[] = rows.map((row) => ({
      id: row.id,
      authorKind: row.author_kind,
      authorId: row.author_id,
      authorName: row.author_name,
      text: row.text,
      at: row.at,
      kind: row.kind,
      toMemberId: row.to_member_id,
    }))
    const last = messages[messages.length - 1]
    const coordinatorRow = this.db.prepare('SELECT coordinator_id FROM project WHERE id = ?').get(input.projectId) as { coordinator_id: string | null }
    const coordinatorPointer = coordinatorRow.coordinator_id ? this.pointerAt(this.groupKey(input.projectId, coordinatorRow.coordinator_id, true)) : null
    let error: string | undefined
    if (coordinatorPointer) {
      try {
        const state = await this.runtime.read(coordinatorPointer.sessionId)
        error = state.error
      } catch {
        error = undefined
      }
    }
    return {
      projectId: input.projectId,
      title: project.name,
      coordinator: team.coordinator,
      members: team.members,
      messages,
      running: Boolean(team.coordinator?.running || team.members.some((row) => row.running)),
      available: true,
      ...(error ? { error } : {}),
    }
    void last
  }

  /** 人往群里发一句话：默认交给推进 bot；它可以用 hams_group_send @ 具体成员。 */
  async groupSend(
    ctx: CommandContext,
    input: { projectId: string; text: string },
  ): Promise<{ messageId: string; sessionId: string; mentions: string[] }> {
    this.human(ctx)
    this.requireRuntime()
    const text = String(input.text || '').trim()
    if (!text) throw new HamsError('STATE_INVALID', '消息不能为空')
    if (text.length > 8000) throw new HamsError('STATE_INVALID', '单条消息不能超过 8000 字')
    const project = this.projectRow(input.projectId)
    if (!project.coordinator_id) throw new HamsError('STATE_INVALID', '这个项目还没有推进 bot，群聊没有回答的人', { nextStep: '先在项目里指定推进 bot' })
    const human = this.memberRow(ctx.principalId)
    const humanName = human?.name || ctx.principalId
    // 人类在群里 @ 谁，就把这句话直接交给谁；没 @ 才由推进 bot 接。
    const mentioned = this.mentionedMembers(input.projectId, text, ctx.principalId)
    const targets = mentioned.length
      ? mentioned
      : [
          this.teamRows(input.projectId).find((row) => row.memberId === project.coordinator_id) ?? {
            memberId: project.coordinator_id,
            name: this.memberRow(project.coordinator_id)?.name || '推进 bot',
            kind: 'coordinator' as TeamKind,
            status: 'active',
            brief: '项目推进 bot',
          },
        ]
    const first = targets[0]
    const messageId = this.appendGroupMessage({
      projectId: input.projectId,
      authorKind: 'human',
      authorId: ctx.principalId,
      authorName: humanName,
      text,
      kind: mentioned.length ? 'mention' : 'chat',
      toMemberId: mentioned.length ? first.memberId : null,
    })
    this.collectMemories(input.projectId, {
      id: messageId,
      authorKind: 'human',
      authorId: ctx.principalId,
      authorName: humanName,
      text,
    })
    // 服务端先识别：这句话是不是一件新活？是就自动登记，不依赖模型是否调工具。
    let intake: IntakeOutcome | null = null
    try {
      intake = await (this.intake?.registerFromMessage({
        projectId: input.projectId,
        senderId: ctx.principalId,
        text,
        messageId,
        mentionedMemberId: mentioned.length ? first.memberId : null,
        recent: this.recentTranscript(input.projectId, 4),
      }) ?? null)
    } catch {
      intake = null
    }
    const intakeNote = this.intakeNote(intake)
    if (intake) {
      this.appendGroupMessage({
        projectId: input.projectId,
        authorKind: 'system',
        authorId: 'system',
        authorName: '系统',
        text: this.intakeSystemText(intake),
        kind: 'system',
      })
    }
    const sessionIds: string[] = []
    for (const row of targets) {
      sessionIds.push(await this.deliverHumanMessage(project, row, text, humanName, mentioned.length > 0, intakeNote))
    }
    return { messageId, sessionId: sessionIds[0], mentions: mentioned.map((row) => row.memberId) }
  }

  /**
   * 群里被 @ 的 bot：先看团队成员，再看全局在岗 bot。
   * @ 一个还没进群的 bot = 明确要它来排查，直接拉进群（人是发起者，写进参与者）。
   */
  private mentionedMembers(projectId: string, text: string, actorId: string): Array<{ memberId: string; name: string; kind: TeamKind; status: string; brief: string }> {
    const bots = this.db
      .prepare(
        `SELECT id AS memberId, name FROM member
          WHERE kind = 'bot' AND status = 'active'
            AND (scope_project_id IS NULL OR scope_project_id = ?)
          ORDER BY length(name) DESC, name`,
      )
      .all(projectId) as Array<{ memberId: string; name: string }>
    let rest = text
    const hits: string[] = []
    for (const bot of bots) {
      const token = new RegExp(`[@＠]\\s*${escapeRegExp(bot.name)}`)
      if (!token.test(rest)) continue
      hits.push(bot.memberId)
      rest = rest.replace(new RegExp(`[@＠]\\s*${escapeRegExp(bot.name)}`, 'g'), '@')
    }
    if (!hits.length) return []
    for (const memberId of hits) {
      const member = this.teamRows(projectId).find((row) => row.memberId === memberId)
      if (!member) {
        this.db
          .prepare(
            `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
             VALUES (?, ?, 'member', '被 @ 拉进群', ?, ?, NULL, NULL)
             ON CONFLICT(project_id, member_id) DO UPDATE SET removed_by = NULL, removed_at = NULL`,
          )
          .run(projectId, memberId, actorId, this.now())
      }
    }
    const team = this.teamRows(projectId)
    return hits
      .map((memberId) => team.find((row) => row.memberId === memberId))
      .filter((row): row is (typeof team)[number] => Boolean(row))
  }

  /**
   * 群聊里的自动记忆收集：规则提取候选，写进项目记忆；真的新增了才在群里留一条系统记录。
   * 只处理真人和 bot 的发言，不处理系统记录，避免自我循环。
   */
  private collectMemories(
    projectId: string,
    message: { id: string; authorKind: 'human' | 'bot'; authorId: string; authorName: string; text: string },
  ): number {
    try {
      const candidates = extractMemoryCandidates(message.text, {
        authorKind: message.authorKind,
        authorId: message.authorId,
        authorName: message.authorName,
      })
      if (!candidates.length) return 0
      const created: typeof candidates = []
      candidates.forEach((candidate, index) => {
        const result = createMemory(this.db, this.id, this.now(), message.authorId, {
          projectId,
          kind: candidate.kind,
          title: candidate.title,
          body: candidate.body,
          origin: 'auto',
          memberId: candidate.memberId,
          sourceRef: `message:${message.id}`,
          dedupeKey: `auto:${message.id}:${index}`,
        })
        if (result.created) created.push(candidate)
      })
      if (!created.length) return 0
      this.appendGroupMessage({
        projectId,
        authorKind: 'system',
        authorId: 'system',
        authorName: '记忆',
        text: `自动收集 ${created.length} 条记忆：${created
          .map((candidate) => `[${MEMORY_KIND_LABEL[candidate.kind]}] ${candidate.title}`)
          .join('；')}`,
        kind: 'system',
      })
      return created.length
    } catch {
      // 记忆收集失败不能影响群聊本身；下一轮/下一次消息会再试。
      return 0
    }
  }

  /** 工具路径：bot 主动把项目里值得记住的内容写进记忆；能力类默认同步给发言的 bot。 */
  rememberBySession(
    sessionId: string,
    input: { title: string; body: string; kind: string; botId?: string | null },
  ): { ok: true; memoryId: string; created: boolean; syncedTo: string | null } {
    const projectId = this.projectOfSession(sessionId)
    const speakerId = this.memberOfSession(sessionId)
    if (!projectId || !speakerId) throw new HamsError('POLICY_DENIED', '这个会话不在任何项目群里', { nextStep: '项目记忆只能在项目群里记录' })
    const kind = String(input.kind || 'fact')
    const memberId = kind === 'capability' ? (input.botId || speakerId) : null
    const result = createMemory(this.db, this.id, this.now(), speakerId, {
      projectId,
      kind,
      title: input.title,
      body: input.body,
      origin: 'tool',
      memberId,
      sourceRef: `tool:${sessionId.slice(-8)}`,
    })
    return { ok: true, memoryId: result.memory.id, created: result.created, syncedTo: result.syncedTo }
  }

  private async deliverHumanMessage(
    project: { id: string; name: string; coordinator_id: string | null },
    row: { memberId: string; name: string; kind: TeamKind; status: string; brief: string },
    text: string,
    humanName: string,
    mentioned: boolean,
    intakeNote = '',
  ): Promise<string> {
    if (row.status !== 'active') {
      throw new HamsError('STATE_INVALID', `${row.name} 当前不在岗，接不了这条指令`, { nextStep: '在智能体详情里恢复它在岗，或换一个 bot' })
    }
    const member = this.bot(row.memberId)
    const isCoordinator = project.coordinator_id === row.memberId
    const roster = this.rosterText(project.id)
    const context = isCoordinator ? this.coordinatorContext(project, roster) : this.memberContext(project, roster)
    const { sessionId } = await this.ensureGroupSession(project, member, isCoordinator, context)
    const transcript = this.recentTranscript(project.id, 10)
    const prefix = mentioned ? `[人类 ${humanName} @你]` : `[人类 ${humanName}]`
    const instruction = isCoordinator
      ? '（你是推进 bot。派活必须用 hams_group_send，并在 text 开头写「@成员名」，让群里看得见你点了谁；' +
        '系统已登记工作项时直接用它的 id 派给成员；系统没登记、你判断是新活时才用 hams_create_work_item 补建；' +
        '自己的判断可以直接回答，不要@不存在的人；关单与审批只能由人做。）'
      : '（你被人类点名了。直接回答这条指令；需要别人继续用 hams_group_send；关单与审批只能由人做，不要编造没记录过的事。）'
    const memory = projectMemoryBlock(this.db, project.id)
    await this.runtime.send(
      sessionId,
      `${roster}\n\n${memory ? `${memory}\n\n` : ''}【群聊最近记录】\n${transcript}\n\n${intakeNote}${prefix} ${text}\n\n${instruction}`,
    )
    return sessionId
  }

  private coordinatorContext(project: { id: string; name: string }, roster: string): string {
    return (
      `你在 HAMS 项目《${project.name}》（projectId=${project.id}）的群聊里，是这个项目的推进 bot。\n` +
      `${roster}\n` +
      '你可以：看项目工作项（hams_list_project_work）、在本项目建工作项（hams_create_work_item，projectId 用上面的）、' +
      '指派任务（hams_assign_task）、@ 群成员（hams_group_send 带 memberId）、' +
      '建临时 bot（hams_group_spawn_bot，只属于这个项目群）、记项目记忆（hams_remember）。关单与审批只能由人做。用中文简短回答。\n' +
      '人类的新活会由系统自动登记成工作项，消息里会给出工作项 id；优先用那条工作项派活。只有系统没登记、而你认为确实还缺一条时，才用 hams_create_work_item 补建（同标题自动去重）。\n' +
      '遇到决定、偏好、教训、口径或 bot 能力经验，用 hams_remember 记下来；能力类会同步给对应 bot。\n' +
      (projectMemoryBlock(this.db, project.id) ? `${projectMemoryBlock(this.db, project.id)}\n` : '') +
      '硬规则：派活给谁，就在群聊正文里写出「@名字」；hams_group_send 会自动补上开头的 @名字，' +
      '所以调用它时 text 直接写任务内容即可，但最终群里必须能看到你点了谁。'
    )
  }

  private memberContext(project: { id: string; name: string }, roster: string): string {
    return (
      `你在 HAMS 项目《${project.name}》的群聊里，是群里的一名 bot 成员。\n${roster}\n` +
      '被 @ 时你会收到带上下文的指令；回复直接说话即可，会被合并进群聊记录。需要其他成员时用 hams_group_send，' +
      '正文同样要写出「@名字」。系统会自动登记新活；需要额外建任务时用 hams_create_work_item（有权限时）或请推进 bot 建单；不要替推进 bot 派活，也不要批准关单。' +
      (projectMemoryBlock(this.db, project.id) ? `\n${projectMemoryBlock(this.db, project.id)}` : '')
    )
  }

  /** 工具路径：以某个会话的身份在群里发言（@ 某个成员）。 */
  async groupSpeakBySession(sessionId: string, input: { toMemberId: string; text: string }): Promise<{ ok: true; messageId: string }> {
    const projectId = this.projectOfSession(sessionId)
    const speakerId = this.memberOfSession(sessionId)
    if (!projectId || !speakerId) throw new HamsError('POLICY_DENIED', '这个会话不在任何项目群里', { nextStep: '群聊只能在项目群会话里用' })
    const project = this.projectRow(projectId)
    const speaker = this.memberRow(speakerId)
    if (!speaker) throw new HamsError('STATE_INVALID', '群会话的成员不存在')
    const isCoordinator = project.coordinator_id === speakerId
    const isMember = Boolean(this.participantRow(projectId, speakerId) && !this.participantRow(projectId, speakerId)!.removed_at)
    if (!isCoordinator && !isMember) throw new HamsError('POLICY_DENIED', '你不在这个项目群里', { nextStep: '让管理员把你加进项目团队' })
    if (!input.toMemberId) throw new HamsError('STATE_INVALID', '要 @ 谁？请给出 memberId（先用 hams_group_members 查）')
    const target = this.teamRows(projectId).find((row) => row.memberId === input.toMemberId)
    if (!target) throw new HamsError('STATE_INVALID', `${input.toMemberId} 不在这个项目群里`, { nextStep: '先用 hams_group_members 看有谁' })
    const raw = String(input.text || '').trim()
    if (!raw) throw new HamsError('STATE_INVALID', '要说的话不能为空')
    // 派活必须在正文里看得见「@名字」，不能只靠一个 toMemberId 字段。
    const atPrefix = `@${target.name}`
    const text = raw.startsWith(atPrefix) ? raw : `${atPrefix} ${raw}`
    const messageId = this.appendGroupMessage({
      projectId,
      authorKind: 'bot',
      authorId: speakerId,
      authorName: speaker.name,
      text,
      kind: 'mention',
      toMemberId: input.toMemberId,
    })
    this.collectMemories(projectId, {
      id: messageId,
      authorKind: 'bot',
      authorId: speakerId,
      authorName: speaker.name,
      text,
    })
    const targetMember = this.bot(input.toMemberId)
    const roster = this.rosterText(projectId)
    const { sessionId: targetSession } = await this.ensureGroupSession(project, targetMember, false, this.memberContext(project, roster))
    const transcript = this.recentTranscript(projectId, 10)
    const memory = projectMemoryBlock(this.db, projectId)
    await this.runtime.send(
      targetSession,
      `${roster}\n\n${memory ? `${memory}\n\n` : ''}【群聊最近记录】\n${transcript}\n\n[${speaker.name} @你] ${text}\n\n` +
        '（在群聊里回复即可；需要别人继续用 hams_group_send。不要编造没记录过的事。）',
    )
    return { ok: true, messageId }
  }

  /**
   * 工具路径：推进 bot 指派工作项后，在群里留一条可见的「@接活人」记录。
   * 只写合并记录，不再唤醒被指派人（真正开跑由会话适配器派发）。
   */
  groupNoteAssignmentBySession(sessionId: string, input: { memberId: string; text: string }): { ok: true; messageId: string } | null {
    const projectId = this.projectOfSession(sessionId)
    const speakerId = this.memberOfSession(sessionId)
    if (!projectId || !speakerId) return null
    const project = this.projectRow(projectId)
    if (project.coordinator_id !== speakerId) return null
    const speaker = this.memberRow(speakerId)
    if (!speaker) return null
    const body = String(input.text || '').trim()
    if (!body) return null
    let target = this.teamRows(projectId).find((row) => row.memberId === input.memberId)
    if (!target) {
      const member = this.memberRow(input.memberId)
      if (!member || member.kind !== 'bot' || member.status !== 'active') return null
      this.db
        .prepare(
          `INSERT INTO project_participant (project_id, member_id, kind, brief, added_by, added_at, removed_by, removed_at)
           VALUES (?, ?, 'member', '被指派加入', ?, ?, NULL, NULL)
           ON CONFLICT(project_id, member_id) DO UPDATE SET removed_by = NULL, removed_at = NULL`,
        )
        .run(projectId, member.id, speakerId, this.now())
      target = this.teamRows(projectId).find((row) => row.memberId === input.memberId)
      if (!target) return null
    }
    const text = body.startsWith(`@${target.name}`) ? body : `@${target.name} ${body}`
    const messageId = this.appendGroupMessage({
      projectId,
      authorKind: 'bot',
      authorId: speakerId,
      authorName: speaker.name,
      text,
      kind: 'mention',
      toMemberId: target.memberId,
    })
    return { ok: true, messageId }
  }

  /** 工具路径：推进 bot 建临时 bot（只属于本群）。 */
  groupSpawnBySession(sessionId: string, input: { name: string; brief?: string }): { memberId: string; name: string } {
    const projectId = this.projectOfSession(sessionId)
    const speakerId = this.memberOfSession(sessionId)
    if (!projectId || !speakerId) throw new HamsError('POLICY_DENIED', '这个会话不在任何项目群里')
    const project = this.projectRow(projectId)
    if (project.coordinator_id !== speakerId) throw new HamsError('POLICY_DENIED', '只有推进 bot 能在自己群里建临时 bot')
    return this.spawnTempBot({ principalId: speakerId, channel: 'tool', correlationId: `group-spawn-${this.now()}` }, { projectId, ...input })
  }

  /** 工具路径：群成员名单。 */
  groupMembersBySession(sessionId: string): Array<{ memberId: string; name: string; kind: TeamKind; status: string; brief: string }> {
    const projectId = this.projectOfSession(sessionId)
    if (!projectId) throw new HamsError('POLICY_DENIED', '这个会话不在任何项目群里')
    return this.teamRows(projectId)
  }

  projectOfSession(sessionId: string): string | null {
    const row = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`chat:group:session:${sessionId}`) as { value: string } | undefined
    return row?.value || null
  }

  memberOfSession(sessionId: string): string | null {
    const row = this.db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`chat:session:${sessionId}`) as { value: string } | undefined
    return row?.value || null
  }

}
