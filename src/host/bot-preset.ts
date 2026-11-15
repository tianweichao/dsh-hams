/**
 * HAMS bot 的宿主 preset：工具组合 + 每个 bot 自己的提示词。
 *
 * 两条规则（2026-11-15 用户口径）：
 * - **工具跟官方 `standard` preset 对齐**：bash、文件读写/搜索、subagent、workflow、联网、
 *   技能、计划、待办、定时、交付卡片都在。bot 不再被削成「只有 HAMS 窄工具」，否则
 *   执行类任务连仓库都读不到，只能报权限阻塞。
 * - **提示词按 bot 分**：每个成员版本的 `prompt` 生成一个独立 preset id（`hams-bot-<成员>-v<版本>-<哈希>`），
 *   persona 前缀 = HAMS 基础规则 + 该 bot 的设定；工具部分与基础 preset 共用同一份。
 *   这样改提示词只换身份，不会顺手改工具；改工具只改这一份常量。
 *
 * 约束：
 * - preset 由插件运行时注册，不写 profile YAML，也不碰 permissionPresets；
 * - persona 前缀是模板，`{{…}}` 会被提示词注册表当变量解析，所以用户提示词里的花括号先转义；
 * - `register()` 不因装不起来 reject，必须再 `resolve()` 看 `broken`，规则同 `ensureHamsBotPreset`。
 */
import { createHash } from 'node:crypto'

export const HAMS_BOT_PRESET = 'hams-bot'

const PLAN_MODE_SECTION = String.raw`You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

/** HAMS 自己的身份与纪律；每个 bot 的差异由 `prompt` 追加在后面。 */
const HAMS_PERSONA_BASE =
  'You are a HAMS work-item agent. Facts about the work item come from the HAMS tools; never invent state or close a work item yourself. ' +
  'Answer the human in Chinese, briefly. When the human is chatting in a project group, you are the coordinator: you may break work into tasks and assign them to other bots via the HAMS tools. ' +
  'When a concrete deliverable is requested, register it as a HAMS work item with hams_create_work_item before doing the work; never just promise in chat without creating the item.'

/**
 * 与 `@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml` 逐行对齐。
 * 刻意不带：`tool-pwsh`（Windows 专属）与 `tool-plugin-manager` / `tool-plugin-market`
 * （只在宿主 profile 作用域有 `profileContext` 时可用）。
 */
const STANDARD_TOOL_PLUGINS = [
  {
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    config: { maxBytes: 65536 },
  },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  {
    id: 'tool-fs',
    name: '@deepseek-ai/dsh-tool-fs',
    config: { applyPatch: false },
  },
  {
    id: 'tool-fs-search',
    name: '@deepseek-ai/dsh-tool-fs-search',
    config: { sampleOverCapGlobResults: false },
  },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } }],
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
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true },
      },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
] as const

/** persona 模板里的 `{{…}}` 是提示词变量；用户文本不能触发解析。 */
function templateSafe(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
}

/** 基础 persona：没有 per-bot 提示词时用（也用于 `hams-bot` 这个默认 preset）。 */
export function hamsPersonaPrefix(prompt?: string | null): string {
  const text = String(prompt || '').trim()
  if (!text) return HAMS_PERSONA_BASE
  return (
    `${HAMS_PERSONA_BASE}\n\n` +
    `【你的设定（由成员配置发布；与上面的通用说明冲突时以这里为准）】\n${templateSafe(text)}`
  )
}

/** 目录名/ID 只保留安全字符：成员 id 里可能有冒号等。 */
export function presetSafeId(value: string): string {
  return String(value || 'bot').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'
}

/** 每个成员版本一个 preset：版本变了就换新 id，旧会话继续冻结在旧代际上。 */
export function botPresetId(memberId: string, version: number, prompt?: string | null): string {
  const digest = createHash('sha256').update(String(prompt || '')).digest('hex').slice(0, 8)
  return `${HAMS_BOT_PRESET}-${presetSafeId(memberId)}-v${Number(version) || 0}-${digest}`
}

export interface BotPresetDefinition {
  id: string
  name: string
  description: string
  order: number
  plugins: readonly unknown[]
}

/** 纯函数：给测试和注册共用，避免「注册的」和「测的」不是一份定义。 */
export function hamsBotPresetDefinition(options: { id?: string; memberName?: string; prompt?: string | null } = {}): BotPresetDefinition {
  const id = options.id || HAMS_BOT_PRESET
  const perBot = Boolean(String(options.prompt || '').trim())
  return {
    id,
    name: perBot ? `HAMS bot · ${options.memberName || id}` : 'HAMS bot',
    description: perBot
      ? 'HAMS 工作项/群聊执行体：工具与官方 standard preset 对齐，人设来自这个 bot 的提示词'
      : 'HAMS 工作项/群聊执行体：工具与官方 standard preset 对齐（bash / 文件 / subagent / 联网 / 技能 / 交付卡片）',
    order: 90,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: hamsPersonaPrefix(options.prompt) },
      },
      ...STANDARD_TOOL_PLUGINS,
    ],
  }
}

interface PresetsRegistry {
  list(): Promise<Array<{ id?: string; broken?: string }>>
  register(definition: BotPresetDefinition): Promise<() => Promise<void>>
  resolve(id: string): Promise<{ id?: string; broken?: string }>
}

function registryOf(ctx: { get?: (name: string) => unknown }): PresetsRegistry | undefined {
  try {
    const found = ctx.get ? ctx.get('agentPresets') : undefined
    return found && typeof found === 'object' ? (found as PresetsRegistry) : undefined
  } catch {
    return undefined
  }
}

/** 已注册的 id：同一进程里重复 register 会撞车，注册一次就够。 */
const registered = new Set<string>()
const pending = new Map<string, Promise<string | null>>()

async function registerPreset(
  ctx: { get?: (name: string) => unknown },
  definition: BotPresetDefinition,
  log?: (line: string) => void,
): Promise<string | null> {
  const note = log || (() => {})
  if (registered.has(definition.id)) return definition.id
  const registry = registryOf(ctx)
  if (!registry) return null
  try {
    const list = await registry.list()
    if (Array.isArray(list) && list.some((row) => row && row.id === definition.id)) {
      const resolved = await registry.resolve(definition.id)
      if (resolved && resolved.broken) {
        note(`[hams] agent preset ${definition.id} 不可用：${resolved.broken}`)
        return null
      }
      registered.add(definition.id)
      return definition.id
    }
    await registry.register(definition)
    const resolved = await registry.resolve(definition.id)
    if (resolved && resolved.broken) {
      note(`[hams] agent preset ${definition.id} 不可用：${resolved.broken}`)
      return null
    }
    registered.add(definition.id)
    note(`[hams] 已注册 agent preset ${definition.id}`)
    return definition.id
  } catch (error) {
    note(`[hams] 注册 ${definition.id} 失败，退回宿主默认 preset：${String(error)}`)
    return null
  }
}

/** 默认 `hams-bot`（没有 per-bot 提示词的路径；老会话/测试仍可用）。 */
let defaultPresetPromise: Promise<string | null> | null = null
export function ensureHamsBotPreset(ctx: { get?: (name: string) => unknown }, log?: (line: string) => void): Promise<string | null> {
  if (!defaultPresetPromise) {
    defaultPresetPromise = registerPreset(ctx, hamsBotPresetDefinition({ id: HAMS_BOT_PRESET }), log)
  }
  return defaultPresetPromise
}

/**
 * 解析一个 bot 会话应该挂哪个 preset：
 * - 成员配了别的宿主 preset（例如 standard）→ 原样用，提示词由调用方写进会话上下文；
 * - 没配或配的是 `hams-bot` → 注册/复用该成员版本的人设 preset。
 */
export function resolveBotPreset(
  ctx: { get?: (name: string) => unknown },
  input: { memberId: string; memberName?: string; version: number; prompt?: string | null; preset?: string | null },
  log?: (line: string) => void,
): Promise<string | null> {
  const requested = String(input.preset || '').trim()
  if (requested && requested !== HAMS_BOT_PRESET) return Promise.resolve(requested)
  const id = botPresetId(input.memberId, input.version, input.prompt)
  const existing = pending.get(id)
  if (existing) return existing
  const definition = hamsBotPresetDefinition({ id, memberName: input.memberName, prompt: input.prompt })
  const task = registerPreset(ctx, definition, log).finally(() => { pending.delete(id) })
  pending.set(id, task)
  return task
}
