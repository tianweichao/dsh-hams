/**
 * 群聊/单聊「任务识别器」：一次独立的模型调用，不挂工具、不占主会话上下文。
 *
 * 用户明确要求不要关键词规则：是不是新活、是不是在改某个工作项的状态，由模型判断。
 * 这里只做三件事：
 * 1. 拼一份短提示（项目、未结工作项、最近群聊、人类原话）；
 * 2. 选最低推理强度（模型支持 off/none 就用，否则用它的最低档），限制输出长度；
 * 3. 解析严格 JSON，解析不出来就当「没有判断」，交回推进 bot，不猜。
 *
 * 不使用 agent 会话：分类器不需要工具、不需要历史、也不需要写会话日志；
 * 直接走 `llm.stream` 更轻，且不会在宿主的会话列表里制造一次性会话。
 */
import type { IntakeDecision } from '../service/chat.ts'

export interface LlmStreamChunk {
  type?: string
  text?: unknown
}

export interface LlmLike {
  listModels?(provider: string): Promise<Array<{ id: string; name?: string }>>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts?: Array<{ id: string; name: string }> } }>
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>
}

export interface IntakeModel {
  provider: string
  model: string
  /** 显式指定的推理强度；省略时自动选 off/none 或最低档。 */
  reasoningEffort?: string
}

export interface ClassifyInput {
  llm: LlmLike
  model: IntakeModel
  projectName: string
  workItems: Array<{ id: string; title: string; status: string; assignee?: string | null }>
  recent?: string
  message: string
  signal?: AbortSignal
  timeoutMs?: number
}

const DECISION_SCHEMA = `只输出一个 JSON 对象，不要 markdown、不要解释。三种形态：
{"action":"create","title":"不超过 60 字的具体任务标题","reason":"一句话"}
{"action":"update","workItemId":"必须是下面列表里的 id","status":"paused|active|cancelled","reason":"一句话"}
{"action":"none","reason":"一句话"}`

function buildPrompt(input: ClassifyInput): string {
  const items = input.workItems.length
    ? input.workItems
        .slice(0, 20)
        .map((item) => `- ${item.id}｜${item.status}｜${item.assignee ? `@${item.assignee}` : '未指派'}｜${item.title}`)
        .join('\n')
    : '（当前没有未结工作项）'
  const recent = input.recent ? `\n最近群聊（供理解“这个/刚才”指什么）：\n${input.recent}\n` : ''
  return (
    `你是 HAMS 的任务识别器。判断人类这句话是在「开一件新活」还是在「改某个已有工作项的状态」。\n\n` +
    `项目：${input.projectName}\n\n当前未结工作项（id｜状态｜负责人｜标题）：\n${items}\n${recent}\n` +
    `人类新消息：\n${input.message}\n\n` +
    `判断口径：\n` +
    `- 只有明确要求做一件新的、可交付的事，才 create；寒暄、感谢、确认、追问进展、回答 bot 的问题、闲聊都 none。\n` +
    `- 只有明确要求暂停/继续/取消某个已有工作项，才 update；“做完了/可以关单了”不是 update（关单要人审批），给 none。\n` +
    `- 不要臆造工作项 id；拿不准就 none。\n` +
    `- create 的标题要具体、能直接当任务名，不要带“帮我/请”。\n\n${DECISION_SCHEMA}`
  )
}

function parseDecision(text: string): IntakeDecision | null {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const action = value.action
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 200) : ''
  if (action === 'create') {
    const title = typeof value.title === 'string' ? value.title.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
    if (title.length < 4) return null
    return { action: 'create', title, reason }
  }
  if (action === 'update') {
    const workItemId = typeof value.workItemId === 'string' ? value.workItemId.trim() : ''
    const status = value.status
    if (!workItemId || (status !== 'paused' && status !== 'active' && status !== 'cancelled')) return null
    return { action: 'update', workItemId, status, reason }
  }
  if (action === 'none') return { action: 'none', reason }
  return null
}

function hasOff(info: { reasoning?: { efforts?: Array<{ id: string; name: string }> } } | undefined): boolean {
  return Boolean(info?.reasoning?.efforts?.some((effort) => /^(off|none|no[-_]?think|minimal)$/i.test(effort.id)))
}

/** 选模型的缓存：同一个默认模型只探测一次「有没有支持 off 的模型」。 */
const modelChoiceCache = new Map<string, Promise<IntakeModel>>()

/**
 * 默认模型不支持 off/none 时，在同一 provider 的目录里找一个支持 off 的模型。
 * 目的：识别器不开思考；找不到就退回默认模型的最低档。
 * 结果按「provider + 默认模型」缓存，避免每条消息都扫目录。
 */
export function chooseIntakeModel(llm: LlmLike, preferred: IntakeModel): Promise<IntakeModel> {
  if (preferred.reasoningEffort) return Promise.resolve(preferred)
  const key = `${preferred.provider}/${preferred.model}`
  const cached = modelChoiceCache.get(key)
  if (cached) return cached
  const task = (async () => {
    if (!llm.resolveModelInfo) return preferred
    try {
      const info = await llm.resolveModelInfo(preferred.provider, preferred.model)
      if (hasOff(info)) return preferred
    } catch {
      return preferred
    }
    if (!llm.listModels) return preferred
    let catalog: Array<{ id: string }> = []
    try { catalog = await llm.listModels(preferred.provider) } catch { return preferred }
    for (const row of catalog.slice(0, 8)) {
      if (!row?.id || row.id === preferred.model) continue
      try {
        const info = await llm.resolveModelInfo(preferred.provider, row.id)
        if (hasOff(info)) return { provider: preferred.provider, model: row.id }
      } catch {
        // 单个模型解析失败不影响继续找
      }
    }
    return preferred
  })()
  modelChoiceCache.set(key, task)
  return task
}

/** 选最低推理强度：模型公布 off/none 就用它，否则用第一档（通常是低）。 */
export async function leastEffort(input: ClassifyInput): Promise<string | undefined> {
  if (input.model.reasoningEffort) return input.model.reasoningEffort
  if (!input.llm.resolveModelInfo) return undefined
  try {
    const info = await input.llm.resolveModelInfo(input.model.provider, input.model.model, input.signal)
    const efforts = info?.reasoning?.efforts ?? []
    const off = efforts.find((effort) => /^(off|none|no[-_]?think|minimal)$/i.test(effort.id) || /off|none|不思考|无思考/i.test(effort.name))
    return (off ?? efforts[0])?.id
  } catch {
    return undefined
  }
}

/** 调一次模型做判断；任何失败都返回 null（交回 bot，不猜、不建单）。 */
export async function classifyWorkRequest(input: ClassifyInput): Promise<IntakeDecision | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000)
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal
  try {
    const chosen = await chooseIntakeModel(input.llm, input.model)
    const reasoningEffort = await leastEffort({ ...input, model: chosen, signal })
    const stream = input.llm.stream({
      provider: chosen.provider,
      model: chosen.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(input) }] }],
      maxTokens: 300,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (text.length > 2000) break
    }
    return parseDecision(text)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
