/**
 * 宿主侧对话运行时：把 HAMS 的单聊/群聊接到真实的 DSH agent 会话上。
 *
 * 三条边界（与设计一致）：
 * - **不改宿主 profile**：bot 用的 `hams-bot` preset 在插件运行时注册（C11 实测结论：
 *   preset 是 agent 作用域的组合，不碰公司 YAML 与 permissionPresets）；空组合 = 没有
 *   shell / 文件写这类 agent 作用域插件，bot 只剩全局注册的 HAMS 工具。
 * - **不抄聊天正文**：消息用 `sessionQuery.readSession()` 从会话日志读（活会话也走它），
 *   HAMS 库只存会话指针。
 * - **不 import 宿主包**：插件不在宿主的 node_modules 里，所有宿主能力都从 `ctx.get()`
 *   现取；拿不到就报 HOST_CAPABILITY_MISSING，绝不假装有会话。
 */
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatModelRow, ChatPresetRow, ChatRuntime } from '../service/chat.ts'

interface SessionLike {
  id: string
  events?: unknown
}
interface AgentLike {
  session: SessionLike
  status?: string
  followup(message: unknown): void
  inject?(message: unknown): void
  cancel(cause: { kind: 'user' }, options: { keepInbox: true }): void
}
interface AgentHandleLike {
  agent: AgentLike
  dispose(): void | Promise<void>
}
interface AgentsService {
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
  get?(sessionId: string): { status?: string } | undefined
}
interface SessionQueryService {
  readSession(sessionId: string): Promise<{ events?: readonly unknown[] }>
}
interface PresetsService {
  list(): Promise<ChatPresetRow[]>
  register(definition: { id: string; name?: string; description?: string; order?: number; plugins: readonly unknown[] }): Promise<() => Promise<void>>
  resolve(id?: string): Promise<ChatPresetRow & { id: string }>
  mount(agentCtx: unknown, id: string): Promise<unknown>
  presetForSession?(session: unknown): string | null
}
interface LlmService {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>
}
interface DefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined
}

export const HAMS_BOT_PRESET = 'hams-bot'

/**
 * bot 组合：persona（告诉它是 HAMS 的执行体）+ 压缩（长会话必备）。
 * 刻意不装 bash / tool-fs / subagent / 联网：C11 要求 bot 会话里没有 shell 与文件写，
 * 而且「装了再关 write」在 compositionInventory 里无法自证，干脆不装。
 */
const HAMS_BOT_PRESET_DEFINITION = {
  id: HAMS_BOT_PRESET,
  name: 'HAMS bot',
  description: 'HAMS 工作项执行体：没有 shell、文件写、委派与联网，只用宿主全局工具（含 HAMS 窄语义工具）',
  order: 90,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix:
          'You are a HAMS work-item agent. Facts about the work item come from the HAMS tools; never invent state or close a work item yourself. ' +
          'Answer the human in Chinese, briefly. When the human is chatting in a project group, you are the coordinator: you may break work into tasks and assign them to other bots via the HAMS tools.',
      },
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
  ],
} as const

export interface HostChatRuntimeOptions {
  ctx: { get?: (name: string) => unknown }
  /** `$DSH_HOME/hams`：bot 会话的工作目录在 `<dataDir>/bots/<memberId>`。 */
  dataDir: string
  log?: (message: string) => void
}

/** 会话事件 → 聊天消息。只取真人输入与助手正文，工具调用与推理不进聊天。 */
export function chatMessagesFromEvents(events: readonly unknown[]): { messages: ChatMessage[]; running: boolean; error?: string } {
  const messages: ChatMessage[] = []
  const openTurns = new Set<number>()
  let running = false
  /** 最近一轮以 error 结束时的原因：模型没配、鉴权失败、provider 挂了都靠这个浮到界面上。 */
  let lastError: string | undefined
  const text = (content: unknown): string => {
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => String((block as { text: string }).text))
      .join('\n')
      .trim()
  }
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as { type?: string; seq?: number; time?: number; data?: Record<string, unknown>; surfaceOp?: unknown }
    // 压缩会用 replace 把一段历史替换成摘要副本；人看的 transcript 只取 append 的事件。
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    const data = event.data || {}
    if (event.type === 'turn/start') {
      const turn = Number(data.turn)
      if (Number.isFinite(turn)) openTurns.add(turn)
      running = true
      lastError = undefined
      continue
    }
    if (event.type === 'turn/end') {
      const turn = Number(data.turn)
      if (Number.isFinite(turn)) openTurns.delete(turn)
      running = openTurns.size > 0
      const reason = data.reason as { kind?: string; error?: { message?: unknown } } | undefined
      if (reason && reason.kind === 'error') {
        const message = reason.error && typeof reason.error.message === 'string' ? reason.error.message : ''
        lastError = message || '这一轮执行失败（宿主没有给出原因）'
      }
      continue
    }
    if (event.type === 'user/message') {
      const source = data.source as { kind?: string } | undefined
      if (!source || source.kind !== 'user') continue
      const body = text(data.content)
      if (!body) continue
      messages.push({ id: String(data.id || `u-${messages.length}`), role: 'user', text: body, at: Number(event.time) || 0, seq: Number(event.seq) || 0 })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message as { id?: string; content?: unknown } | undefined
      const body = text(message && message.content)
      if (!body) continue
      messages.push({ id: String((message && message.id) || `a-${messages.length}`), role: 'assistant', text: body, at: Number(event.time) || 0, seq: Number(event.seq) || 0 })
    }
  }
  return { messages, running: running && openTurns.size > 0, ...(lastError ? { error: lastError } : {}) }
}

/**
 * 模型串 → agents 的 agentOptions。
 *
 * model id 本身可能带 `/`（本机默认路由就是 `auto/deepseek-v4.1-flash`），所以不能按第一个
 * 斜杠硬切：先跨 provider 精确匹配完整 id，再看前缀是不是已注册 provider，最后才当裸名字
 * 交给默认 provider。目录探测失败时按前缀/默认处理，不阻塞开会话。
 */
export interface DefaultSelection { provider?: string; model?: string; reasoningEffort?: string }

/**
 * 会话要用的 AgentOptions：优先 bot 自己配的模型；没配就用宿主默认模型兜底。
 * 两边都不存在时返回 undefined（调用方应给出「配置模型」的明确错误，而不是让宿主抛 has no provider/model）。
 */
export async function resolveAgentOptions(
  choice: string | null,
  llmService?: LlmService,
  fallback?: DefaultSelection,
): Promise<{ provider?: string; model: string; reasoningEffort?: string } | undefined> {
  const parsed = await parseModelChoice(choice, llmService, fallback?.provider)
  if (parsed?.model) return parsed
  if (!fallback?.provider || !fallback.model) return undefined
  return {
    provider: String(fallback.provider),
    model: String(fallback.model),
    ...(fallback.reasoningEffort ? { reasoningEffort: String(fallback.reasoningEffort) } : {}),
  }
}

export async function parseModelChoice(
  value: string | null,
  llmService?: LlmService,
  fallbackProvider?: string,
): Promise<{ provider?: string; model: string } | undefined> {
  const raw = (value || '').trim()
  if (!raw) return undefined
  let providerIds: string[] = []
  if (llmService) {
    try {
      providerIds = llmService.listProviders().map((row) => row.id)
    } catch {
      providerIds = []
    }
  }
  if (llmService && providerIds.length) {
    for (const provider of providerIds) {
      try {
        const models = await llmService.listModels(provider)
        if (models.some((row) => row.id === raw)) return { provider, model: raw }
      } catch {
        // 单个 provider 目录失败不影响其它
      }
    }
    const longestFirst = [...providerIds].sort((a, b) => b.length - a.length)
    for (const provider of longestFirst) {
      if (raw.startsWith(`${provider}/`)) return { provider, model: raw.slice(provider.length + 1) }
    }
  }
  return { provider: fallbackProvider, model: raw }
}

/** 注册 bot preset（进程内只做一次）；装不起来返回 null，让调用方退回宿主默认 preset。 */
let presetPromise: Promise<string | null> | null = null
export function ensureHamsBotPreset(ctx: { get?: (name: string) => unknown }, log?: (line: string) => void): Promise<string | null> {
  if (presetPromise) return presetPromise
  const note = log || (() => {})
  presetPromise = (async () => {
    const registry = (() => {
      try {
        const found = ctx.get ? ctx.get('agentPresets') : undefined
        return found && typeof found === 'object' ? (found as PresetsService) : undefined
      } catch {
        return undefined
      }
    })()
    if (!registry) return null
    try {
      const list = await registry.list()
      if (Array.isArray(list) && list.some((row) => row && row.id === HAMS_BOT_PRESET)) {
        const resolved = await registry.resolve(HAMS_BOT_PRESET)
        if (resolved && resolved.broken) {
          note(`[hams] agent preset ${HAMS_BOT_PRESET} 不可用：${resolved.broken}`)
          return null
        }
        return HAMS_BOT_PRESET
      }
      // register 不因装不起来而 reject：失败只会落成 record.broken，所以必须再 resolve 一次。
      await registry.register(HAMS_BOT_PRESET_DEFINITION as never)
      const resolved = await registry.resolve(HAMS_BOT_PRESET)
      if (resolved && resolved.broken) {
        note(`[hams] agent preset ${HAMS_BOT_PRESET} 不可用：${resolved.broken}`)
        return null
      }
      note(`[hams] 已注册 agent preset ${HAMS_BOT_PRESET}`)
      return HAMS_BOT_PRESET
    } catch (error) {
      note(`[hams] 注册 ${HAMS_BOT_PRESET} 失败，退回宿主默认 preset：${String(error)}`)
      return null
    }
  })()
  return presetPromise
}

/** 目录名只保留安全字符：会话 key 里带冒号与成员 id，不能直接当路径。 */
function safeSegment(value: string): string {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
}

export function createHostChatRuntime(options: HostChatRuntimeOptions): ChatRuntime & { dispose(): Promise<void> } {
  const { ctx, dataDir } = options
  const log = options.log || (() => {})
  const handles = new Map<string, Promise<AgentHandleLike>>()
  const openings = new Map<string, Promise<AgentHandleLike>>()
  const meta = new Map<string, { memberId: string; preset: string; model: string | null }>()
  const contextSent = new Set<string>()
  let modelsCache: { at: number; rows: ChatModelRow[] } | null = null
  let closed = false

  const service = <T>(name: string): T | undefined => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      const found = ctx.get(name)
      return found && typeof found === 'object' ? (found as T) : undefined
    } catch {
      return undefined
    }
  }
  const agents = () => service<AgentsService>('agents')
  const sessionQuery = () => service<SessionQueryService>('sessionQuery')
  const presets = () => service<PresetsService>('agentPresets')
  const llm = () => service<LlmService>('llm')
  const defaultModelService = () => service<DefaultModelService>('agentDefaultModel')

  /** 把「你是谁、在哪个项目」作为注入上下文送进会话：模型看得到，聊天记录里不显示。 */
  function sendContext(handle: AgentHandleLike, sessionId: string, context?: string): void {
    if (!context || contextSent.has(sessionId) || typeof handle.agent.inject !== 'function') return
    try {
      handle.agent.inject({
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: context }],
        source: { kind: 'hams-chat-context', form: 'instructions' },
      })
      contextSent.add(sessionId)
    } catch (error) {
      log(`[hams] 注入对话上下文失败：${String(error)}`)
    }
  }

  async function openSession(input: { sessionId?: string; memberId: string; preset: string; model: string | null; context?: string; cwdKey?: string }): Promise<AgentHandleLike> {
    const registry = agents()
    if (!registry) throw new Error('宿主没有 agents 服务')
    // bot 没配模型时用宿主默认模型兜底：否则新会话一开就报 has no provider/model。
    const parsedModel = await resolveAgentOptions(input.model, llm(), defaultModelService()?.currentSelection?.())
    if (!parsedModel) throw new Error('这个 bot 没有配置模型，宿主也没有默认模型；请给 bot 选一个模型或设置宿主默认模型')
    const agentOptions = Object.fromEntries(Object.entries(parsedModel).filter(([, value]) => value !== undefined && value !== ''))
    const presetId = input.preset === HAMS_BOT_PRESET ? await ensureHamsBotPreset(ctx, log) : input.preset
    // 一个 bot 被多个项目引用时，每个对话各占一个子目录，免得以后给了文件工具互相串。
    const cwd = path.resolve(dataDir, 'bots', input.memberId, 'chats', safeSegment(input.cwdKey || 'default'))
    const base = path.resolve(dataDir, 'bots') + path.sep
    if (!cwd.startsWith(base)) throw new Error('bot 工作目录越界')
    await mkdir(cwd, { recursive: true })
    const meta = { cwd, ...(presetId ? { agentPreset: presetId } : {}) }
    const registryPresets = presets()
    // meta.agentPreset 只写 session header；真正挂载组合必须在 setup 里 mount，否则是「假安全」。
    const setup = presetId && registryPresets && typeof registryPresets.mount === 'function'
      ? async (agentCtx: unknown) => { await registryPresets.mount(agentCtx, presetId) }
      : undefined
    if (input.sessionId) {
      // resume 只认 resumeSessionId/agentOptions/setup；meta 只在 create 时写。
      const handle = await registry.resume({ resumeSessionId: input.sessionId, agentOptions, ...(setup ? { setup } : {}) })
      sendContext(handle, input.sessionId, input.context)
      return handle
    }
    const sessionId = `hams-${input.memberId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const handle = await registry.create({ sessionId, meta, agentOptions, ...(setup ? { setup } : {}) })
    sendContext(handle, sessionId, input.context)
    return handle
  }

  function handleFor(sessionId: string, input: { memberId: string; preset: string; model: string | null; context?: string }): Promise<AgentHandleLike> {
    const existing = handles.get(sessionId)
    if (existing) return existing
    const pending = openings.get(sessionId)
    if (pending) return pending
    const opening = openSession({ sessionId, memberId: input.memberId, preset: input.preset, model: input.model, context: input.context })
    openings.set(sessionId, opening)
    return opening
      .then((handle) => { handles.set(sessionId, Promise.resolve(handle)); return handle })
      .finally(() => { openings.delete(sessionId) })
  }

  const runtime: ChatRuntime & { dispose(): Promise<void> } = {
    get available() {
      return Boolean(agents())
    },
    get unavailableReason() {
      return agents() ? undefined : '宿主没有 agents 服务（只读实例或没有 agent 运行时）'
    },
    async ensure(input) {
      if (closed) throw new Error('对话运行时已停止')
      if (input.sessionId) {
        meta.set(input.sessionId, { memberId: input.memberId, preset: input.agentPreset || HAMS_BOT_PRESET, model: input.model })
        await handleFor(input.sessionId, { ...meta.get(input.sessionId)!, context: input.context })
        return { sessionId: input.sessionId }
      }
      const presetId = input.agentPreset || HAMS_BOT_PRESET
      const handle = await openSession({
        memberId: input.memberId,
        preset: presetId,
        model: input.model,
        cwdKey: input.key,
        context: input.context,
      })
      const sessionId = handle.agent.session.id
      meta.set(sessionId, { memberId: input.memberId, preset: presetId, model: input.model })
      handles.set(sessionId, Promise.resolve(handle))
      return { sessionId }
    },
    async send(sessionId, text) {
      const info = meta.get(sessionId)
      if (!info) throw new Error('未知会话：先发一次 chat/open 再发消息')
      const handle = await handleFor(sessionId, info)
      handle.agent.followup({
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    },
    async status(sessionId) {
      const live = agents()?.get?.(sessionId)
      const status = live && typeof live.status === 'string' ? live.status : undefined
      if (status) return { running: status === 'running' }
      const query = sessionQuery()
      let events: readonly unknown[] = []
      if (query) {
        try {
          const snapshot = await query.readSession(sessionId)
          events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
        } catch {
          return { running: false }
        }
      }
      const scanned = chatMessagesFromEvents(events)
      return { running: scanned.running, ...(scanned.error ? { error: scanned.error } : {}) }
    },
    async read(sessionId) {
      const query = sessionQuery()
      let events: readonly unknown[] = []
      if (query) {
        try {
          const snapshot = await query.readSession(sessionId)
          events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
        } catch (error) {
          log(`[hams] 读会话 ${sessionId} 失败：${String(error)}`)
        }
      }
      const scanned = chatMessagesFromEvents(events)
      const live = agents()?.get?.(sessionId)
      const status = live && typeof live.status === 'string' ? live.status : undefined
      return { messages: scanned.messages, running: status ? status === 'running' : scanned.running, ...(scanned.error ? { error: scanned.error } : {}) }
    },
    async stop(sessionId) {
      const pending = handles.get(sessionId)
      if (!pending) return
      const handle = await pending
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    },
    async defaultModel() {
      const selection = defaultModelService()?.currentSelection?.()
      if (!selection || !selection.provider || !selection.model) return null
      return { provider: String(selection.provider), model: String(selection.model) }
    },
    async presets() {
      const registry = presets()
      if (!registry) return []
      try {
        const list = await registry.list()
        return Array.isArray(list) ? list.filter((row) => row && row.id) : []
      } catch (error) {
        log(`[hams] 读 preset 目录失败：${String(error)}`)
        return []
      }
    },
    async models() {
      const now = Date.now()
      if (modelsCache && now - modelsCache.at < 60_000) return modelsCache.rows
      const rows: ChatModelRow[] = []
      const seen = new Set<string>()
      const push = (provider: string, model: string, label?: string) => {
        const key = `${provider}/${model}`
        if (!provider || !model || seen.has(key)) return
        seen.add(key)
        rows.push({ provider, model, label })
      }
      const llmService = llm()
      if (llmService) {
        try {
          for (const provider of llmService.listProviders()) {
            try {
              for (const model of await llmService.listModels(provider.id)) push(model.provider || provider.id, model.id, model.name)
            } catch {
              // 单个 provider 目录失败不影响别的
            }
          }
        } catch (error) {
          log(`[hams] 读模型目录失败：${String(error)}`)
        }
      }
      const fallback = defaultModelService()?.currentSelection()
      if (fallback && fallback.provider && fallback.model) push(fallback.provider, fallback.model, `${fallback.model}（宿主默认）`)
      modelsCache = { at: now, rows }
      return rows
    },
    async dispose() {
      closed = true
      for (const pending of [...handles.values(), ...openings.values()]) {
        try {
          const handle = await pending
          await handle.dispose()
        } catch {
          // 关闭阶段的失败只记日志，不阻塞插件卸载
        }
      }
      handles.clear()
      openings.clear()
    },
  }
  return runtime
}
