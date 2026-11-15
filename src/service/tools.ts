/**
 * 模型工具层：bot 唯一的动手通道，比 HTTP 更窄。
 *
 * 三条硬规则（backend-design §10 / 兼容层 §5）：
 * 1. **没有审批工具、没有提议决定工具、没有直接关单工具、没有任意 SQL**；
 * 2. 主体只从宿主执行上下文里的 `sessionId` 反查 `work_item_thread` 得到，
 *    参数里出现 `memberId` / `principalId` 一律拒绝（C5 的结论：`exec.agent.session.id`
 *    是唯一可信来源，模型无法伪造）；
 * 3. 失败不抛错，返回 `{ok:false, error:{code,message,nextStep}}`——让模型知道下一步，
 *    而不是死循环盲试。
 *
 * 工具定义与 `ctx.tools.register` 的参数形状对齐（name / description / parameters），
 * 但这里不依赖宿主，便于单测；注册动作留给插件入口。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HamsError } from '../domain/errors.ts'
import type { HamsService } from './hams.ts'
import type { CommandContext } from './types.ts'
import {
  asNumber,
  asObject,
  asString,
  nextStepFor,
  optionalString,
  type ReceiptError,
} from './contracts.ts'

export interface ToolExecContext {
  /** 宿主注入的服务端会话 id；模型无法伪造。 */
  sessionId: string
  callId?: string
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: ReceiptError
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, exec: ToolExecContext): ToolResult | Promise<ToolResult>
}

/** 项目群能力（由 ChatService 实现）；宿主没接会话运行时就报 HOST_CAPABILITY_MISSING。 */
export interface GroupChatPort {
  projectOfSession(sessionId: string): string | null
  groupMembersBySession(sessionId: string): Array<{ memberId: string; name: string; kind: string; status: string; brief: string }>
  groupSpeakBySession(sessionId: string, input: { toMemberId: string; text: string }): Promise<{ ok: true; messageId: string }>
  groupSpawnBySession(sessionId: string, input: { name: string; brief?: string }): { memberId: string; name: string }
  /** 指派后在群里留下可见的 @ 记录（可选；没有实现的宿主忽略）。 */
  noteAssignment?(sessionId: string, input: { memberId: string; text: string }): { ok: true; messageId: string } | null
  /** 把值得记住的内容写进项目记忆；能力类同步给对应 bot。 */
  rememberBySession?(
    sessionId: string,
    input: { title: string; body: string; kind: string; botId?: string | null },
  ): { ok: true; memoryId: string; created: boolean; syncedTo: string | null }
}

interface ThreadIdentity {
  workItemId: string
  memberId: string
  threadId: string
  generation: number
  status: string
}

export interface HamsToolsOptions {
  service: HamsService
  db: DatabaseSync
  /** 覆盖默认的线程解析（测试或未来的多宿主适配）。 */
  resolveThread?: (db: DatabaseSync, sessionId: string) => ThreadIdentity | null
  /**
   * 首次认领时还没有线程：由宿主适配器把「它自己创建的会话」映射到 bot 成员。
   * 这只是会话创建与首个 turn 之间的桥；M5 会在开会话时先建线程，届时可以不用它。
   */
  resolveSessionOwner?: (sessionId: string) => { memberId: string } | null
  idempotencyFor?: (exec: ToolExecContext, tool: string) => string | undefined
  /** 项目群：成员名单、@ 发言、建临时 bot。没注入时这些工具明确报不可用。 */
  chat?: GroupChatPort
}

export function resolveThreadIdentity(db: DatabaseSync, sessionId: string): ThreadIdentity | null {
  const row = db
    .prepare(
      `SELECT id, work_item_id, member_id, generation, status
         FROM work_item_thread WHERE session_id = ?
        ORDER BY generation DESC LIMIT 1`,
    )
    .get(sessionId) as
    | { id: string; work_item_id: string; member_id: string; generation: number; status: string }
    | undefined
  if (!row) return null
  return {
    threadId: row.id,
    workItemId: row.work_item_id,
    memberId: row.member_id,
    generation: row.generation,
    status: row.status,
  }
}

function fail(error: unknown): ToolResult {
  if (error instanceof HamsError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        nextStep: error.nextStep ?? nextStepFor(error.code),
        detail: error.detail,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'STATE_INVALID',
      message: error instanceof Error ? error.message : String(error),
      nextStep: nextStepFor('STATE_INVALID'),
    },
  }
}

/** 参数里禁止出现身份字段；出现即拒绝，不给「试试看」的空间。 */
function assertNoIdentityArgs(args: Record<string, unknown>): void {
  for (const field of ['memberId', 'member_id', 'principalId', 'principal_id', 'actorId', 'actor_id']) {
    if (field in args) {
      throw new HamsError('POLICY_DENIED', '身份由服务端从会话解析，参数里不接受任何身份字段')
    }
  }
}

export function createHamsTools(options: HamsToolsOptions): ToolDefinition[] {
  const { service, db } = options
  const resolve = options.resolveThread ?? resolveThreadIdentity
  let counter = 0

  /** 需要绑定工作项的会话（证据、提交结果、复查、阻塞、请示关单）：对话会话不允许做这些。 */
  function identity(exec: ToolExecContext): ThreadIdentity {
    const source = memberIdentity(exec)
    if (!source.thread) {
      throw new HamsError('POLICY_DENIED', `这个操作要在工作项会话里做，当前是对话会话：${exec.sessionId}`, {
        nextStep: '把这个动作交给工作项里的运行；对话里只能查待办、看项目工作项、指派与提议',
      })
    }
    return source.thread
  }

  /** 认人会话：工作项线程 → 宿主映射 → 对话会话反向索引；拿不到才拒绝。 */
  function memberIdentity(exec: ToolExecContext): { memberId: string; thread: ThreadIdentity | null } {
    if (!exec?.sessionId || !exec.sessionId.trim()) {
      throw new HamsError('HOST_CAPABILITY_MISSING', '拿不到服务端会话 id，无法确定调用者身份')
    }
    const thread = resolve(db, exec.sessionId)
    if (thread) return { memberId: thread.memberId, thread }
    const owner = options.resolveSessionOwner?.(exec.sessionId)
    if (owner?.memberId) return { memberId: owner.memberId, thread: null }
    // 对话会话（单聊/项目群聊）也属于某个 bot：查 HAMS 的反向索引，而不是让模型自报身份。
    const chat = db.prepare('SELECT value FROM hams_meta WHERE key = ?').get(`chat:session:${exec.sessionId}`) as
      | { value: string }
      | undefined
    if (chat && chat.value) return { memberId: chat.value, thread: null }
    throw new HamsError('POLICY_DENIED', `会话未绑定任何工作项，拒绝执行：${exec.sessionId}`)
  }

  function context(
    identityValue: { memberId: string } | ThreadIdentity,
    exec: ToolExecContext,
    tool: string,
  ): CommandContext {
    counter += 1
    return {
      principalId: identityValue.memberId,
      channel: 'tool',
      correlationId: exec.callId ?? `tool-${tool}-${counter}`,
      idempotencyKey: options.idempotencyFor?.(exec, tool) ?? (exec.callId ? `${tool}:${exec.callId}` : undefined),
    }
  }

  function run<T>(fn: () => T): ToolResult {
    try {
      return { ok: true, data: fn() }
    } catch (error) {
      return fail(error)
    }
  }

  async function runAsync(fn: () => Promise<unknown>): Promise<ToolResult> {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return fail(error)
    }
  }

  function groupPort(): GroupChatPort {
    if (!options.chat) {
      throw new HamsError('HOST_CAPABILITY_MISSING', '当前实例没有接宿主会话服务，群聊工具不可用', {
        nextStep: '重启 DSH 让插件接上 agents 服务',
      })
    }
    return options.chat
  }

  function ownedItemCheck(thread: ThreadIdentity, workItemId: string): void {
    if (thread.workItemId !== workItemId) {
      throw new HamsError('POLICY_DENIED', '本会话只被绑定到一个工作项，不能操作其它工作项')
    }
  }

  const tools: ToolDefinition[] = [
    {
      name: 'hams_list_my_work',
      description: '列出指派给我的或可认领的工作项。只读。',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: '按状态过滤' } },
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec)
          const args = rawArgs === undefined ? {} : asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const status = optionalString(args.status, 'status')
          const items = service.listWorkItems(context(member, exec, 'list'), { limit: 50 })
          return items.filter((item) => {
            const mine = item.assignee_id === member.memberId
            const claimable = item.status === 'ready'
            if (!mine && !claimable) return false
            return status ? item.status === status : true
          })
        })
      },
    },
    {
      name: 'hams_get_work_item',
      description: '读取工作项详情与当前允许的动作（allowedActions）。只读。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const id = asString(args.id, 'id')
          return service.getWorkItem(context(member, exec, 'get'), id)
        })
      },
    },
    {
      name: 'hams_claim',
      description: '认领一个 ready 工作项，建立租约与运行。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          expectedEpoch: { type: 'number', description: '调用方看到的执行代次，用于拒绝过期操作' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identityValue = memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const id = asString(args.id, 'id')
          const expectedEpoch = args.expectedEpoch === undefined ? undefined : asNumber(args.expectedEpoch, 'expectedEpoch')
          if (expectedEpoch !== undefined) {
            const item = service.getWorkItem(context(identityValue, exec, 'get'), id)
            if (item.execution_epoch !== expectedEpoch) {
              throw new HamsError('EPOCH_STALE', `执行代次已变：期望 ${expectedEpoch}，当前 ${item.execution_epoch}`)
            }
          }
          return service.claim(context(identityValue, exec, 'claim'), {
            workItemId: id,
            sessionId: exec.sessionId,
          })
        })
      },
    },
    {
      name: 'hams_assign_task',
      description: '把一个待处理的工作项指派给另一个在岗 bot。只有项目的推进 bot（coordinator）或有人工管理权限的人可以指派。指派后必须在群聊里用 hams_group_send 写出「@该 bot 名字」说明任务，让人类看得见派给了谁。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '工作项 id' },
          assigneeId: { type: 'string', description: '接任务的 bot 成员 id' },
        },
        required: ['id', 'assigneeId'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identity = memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const workItemId = asString(args.id, 'id')
          const assigneeId = asString(args.assigneeId, 'assigneeId')
          const result = service.assignWorkItem(context(identity, exec, 'assign'), { workItemId, memberId: assigneeId })
          // 指派同时，在群聊里打出 @接活人：人类要看得见「派给了谁」。
          try {
            groupPort().noteAssignment?.(exec.sessionId, {
              memberId: assigneeId,
              text: `请接手工作项 ${workItemId}，在群里说明下一步并接单。`,
            })
          } catch {
            // 不在项目群会话里（或宿主没接群聊）：指派本身已经成功，不因此失败。
          }
          return result
        })
      },
    },
    {
      name: 'hams_list_project_work',
      description: '列出一个项目下的工作项（状态、负责人、下一步、截止），用于在项目群聊里回答“进展到哪了”。',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          status: { type: 'string', description: '可选：只看某个状态' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const identity = memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          return service
            .listWorkItems(context(identity, exec, 'list-project'), {
              projectId: asString(args.projectId, 'projectId'),
              status: optionalString(args.status, 'status'),
              limit: 100,
            })
            .map((row) => ({
              id: row.id,
              title: row.title,
              status: row.status,
              assigneeId: row.assignee_id,
              nextActionAt: row.next_action_at,
              dueAt: row.due_at,
              updatedAt: row.updated_at,
            }))
        })
      },
    },
    {
      name: 'hams_group_members',
      description: '列出现在这个项目群里的成员（推进 bot、手动加入的 bot、临时 bot）。只读。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec)
          assertNoIdentityArgs(rawArgs === undefined ? {} : asObject(rawArgs, 'args'))
          return groupPort().groupMembersBySession(exec.sessionId)
        })
      },
    },
    {
      name: 'hams_group_send',
      description: '在项目群里 @ 某个成员说一句话；正文会自动以「@成员名」开头，对方的回答会合并进群聊记录。派活必须用它，不能只在心里指派。',
      parameters: {
        type: 'object',
        properties: {
          toMemberId: { type: 'string', description: '要 @ 的群成员 id（先用 hams_group_members 查）' },
          text: { type: 'string' },
        },
        required: ['toMemberId', 'text'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return runAsync(async () => {
          memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          return groupPort().groupSpeakBySession(exec.sessionId, {
            toMemberId: asString(args.toMemberId, 'toMemberId'),
            text: asString(args.text, 'text'),
          })
        })
      },
    },
    {
      name: 'hams_remember',
      description:
        '在项目群里，把推进过程中值得记住的内容记进项目记忆（事实/决策/偏好/教训/能力）。遇到决定、口径、教训、人的偏好或 bot 能力经验时使用；kind=capability 时会同步一份给对应 bot 的记忆，botId 省略则默认为当前 bot。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题（最多 120 字）' },
          body: { type: 'string', description: '记忆正文：保留了哪些事实、为什么、以后怎么做' },
          kind: {
            type: 'string',
            enum: ['fact', 'decision', 'preference', 'lesson', 'capability'],
            description: '事实 / 决策 / 偏好 / 教训 / 能力',
          },
          botId: { type: 'string', description: '能力类归属的 bot 成员 id；省略 = 当前 bot' },
        },
        required: ['title', 'body', 'kind'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const port = groupPort()
          if (!port.rememberBySession) throw new HamsError('HOST_CAPABILITY_MISSING', '当前宿主没有接项目记忆服务')
          return port.rememberBySession(exec.sessionId, {
            title: asString(args.title, 'title'),
            body: asString(args.body, 'body'),
            kind: asString(args.kind, 'kind'),
            botId: optionalString(args.botId, 'botId'),
          })
        })
      },
    },
    {
      name: 'hams_group_spawn_bot',
      description: '在项目群里创建一个只属于这个项目的临时 bot（之后可用 hams_group_send @ 它，正文要写出 @名字）。只有推进 bot 能建。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '临时 bot 的名字（最多 24 字）' },
          brief: { type: 'string', description: '给它的一句话职责说明' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          return groupPort().groupSpawnBySession(exec.sessionId, {
            name: asString(args.name, 'name'),
            brief: optionalString(args.brief, 'brief'),
          })
        })
      },
    },
    {
      name: 'hams_append_evidence',
      description: '为工作项追加证据；证据只增不改，更正请另起一条并指向被替代行。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', description: 'reading / photo / receipt / log / doc' },
          ref: { type: 'string', description: '证据引用路径或标识' },
          observedAt: { type: 'number', description: '事实发生时间（UTC 毫秒）' },
          source: { type: 'string' },
        },
        required: ['id', 'kind', 'ref', 'observedAt'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const workItemId = asString(args.id, 'id')
          ownedItemCheck(thread, workItemId)
          const runRow = db
            .prepare(
              `SELECT id FROM task_run WHERE work_item_id = ? AND member_id = ?
                ORDER BY created_at DESC LIMIT 1`,
            )
            .get(workItemId, thread.memberId) as { id: string } | undefined
          return service.appendEvidence(context(thread, exec, 'append_evidence'), {
            workItemId,
            kind: asString(args.kind, 'kind'),
            ref: asString(args.ref, 'ref'),
            observedAt: asNumber(args.observedAt, 'observedAt'),
            source: optionalString(args.source, 'source'),
            runId: runRow?.id ?? null,
          })
        })
      },
    },
    {
      name: 'hams_submit_result',
      description: '结束本轮运行并提交结果摘要；工作项会进入复查或等待验收。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, summary: { type: 'string' } },
        required: ['id', 'summary'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const workItemId = asString(args.id, 'id')
          ownedItemCheck(thread, workItemId)
          const current = db
            .prepare(
              `SELECT id FROM task_run WHERE work_item_id = ? AND member_id = ? AND status = 'running'
                ORDER BY created_at DESC LIMIT 1`,
            )
            .get(workItemId, thread.memberId) as { id: string } | undefined
          if (!current) throw new HamsError('STATE_INVALID', '当前没有运行中的任务；先认领并开始运行')
          return service.submitResult(context(thread, exec, 'submit_result'), {
            runId: current.id,
            summary: asString(args.summary, 'summary'),
          })
        })
      },
    },
    {
      name: 'hams_evaluate_check',
      description: '对到期复查做判定；服务端会按证据清单复核，不采信模型自述。',
      parameters: {
        type: 'object',
        properties: { checkId: { type: 'string' } },
        required: ['checkId'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const checkId = asString(args.checkId, 'checkId')
          const row = db
            .prepare(
              `SELECT c.work_item_id AS work_item_id, w.assignee_id AS assignee_id
                 FROM work_item_check c JOIN work_item w ON w.id = c.work_item_id
                WHERE c.id = ?`,
            )
            .get(checkId) as { work_item_id: string; assignee_id: string | null } | undefined
          if (!row) throw new HamsError('STATE_INVALID', `复查不存在：${checkId}`)
          if (row.assignee_id !== thread.memberId) {
            throw new HamsError('POLICY_DENIED', '只能判定自己名下的复查')
          }
          return service.evaluateCheck(context(thread, exec, 'evaluate_check'), { checkId })
        })
      },
    },
    {
      name: 'hams_report_blocker',
      description: '上报阻塞，并给出阻塞类别与说明。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: {
            type: 'string',
            enum: ['needs_evidence', 'external', 'dependency', 'permission', 'human_input', 'data_source'],
          },
          note: { type: 'string' },
        },
        required: ['id', 'category', 'note'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const workItemId = asString(args.id, 'id')
          ownedItemCheck(thread, workItemId)
          return service.reportBlocker(context(thread, exec, 'report_blocker'), {
            workItemId,
            category: asString(args.category, 'category'),
            note: asString(args.note, 'note', { allowEmpty: true }),
          })
        })
      },
    },
    {
      name: 'hams_request_closure',
      description: '请示关单：服务端核对证据清单与验证器后生成人工审批。not 直接关单。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const thread = identity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const workItemId = asString(args.id, 'id')
          ownedItemCheck(thread, workItemId)
          return service.requestClosure(context(thread, exec, 'request_closure'), {
            workItemId,
            reason: asString(args.reason, 'reason'),
          })
        })
      },
    },
    {
      name: 'hams_propose',
      description: '提出想做的事（建单 / 升级 / 权限 / 范围 / 知识变更），由人决定；提议不改变工作项。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['create_task', 'upgrade_task', 'permission_request', 'scope_change', 'knowledge_change'],
          },
          subjectKey: { type: 'string', description: 'project:<id> 或 work_item:<id> 或 global' },
          dedupeKey: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          rationale: {
            type: 'object',
            description: '必须包含 evidence 数组（可以是引用，但不能为空）',
            properties: { evidence: { type: 'array' }, expectedEffect: { type: 'string' }, cost: {} },
            required: ['evidence'],
          },
        },
        required: ['kind', 'subjectKey', 'dedupeKey', 'title', 'body', 'rationale'],
        additionalProperties: false,
      },
      execute(rawArgs, exec) {
        return run(() => {
          const member = memberIdentity(exec)
          const args = asObject(rawArgs, 'args')
          assertNoIdentityArgs(args)
          const subjectKey = asString(args.subjectKey, 'subjectKey')
          const deciderId = resolveDecider(db, subjectKey)
          const rationale = asObject(args.rationale, 'rationale')
          const evidence = rationale.evidence
          if (!Array.isArray(evidence) || evidence.length === 0) {
            throw new HamsError('POLICY_DENIED', '提议必须带证据：rationale.evidence 不能为空')
          }
          return service.propose(context(member, exec, 'propose'), {
            kind: asString(args.kind, 'kind') as
              | 'create_task'
              | 'upgrade_task'
              | 'permission_request'
              | 'scope_change'
              | 'knowledge_change',
            subjectKey,
            dedupeKey: asString(args.dedupeKey, 'dedupeKey'),
            deciderId,
            title: asString(args.title, 'title'),
            body: asString(args.body, 'body'),
            rationale: {
              evidence,
              expectedEffect: optionalString(rationale.expectedEffect, 'rationale.expectedEffect'),
            },
          })
        })
      },
    },
  ]

  return tools
}

/** 提议的决定人由服务端解析：项目负责人 / 工作项负责人；global 不允许模型发起。 */
export function resolveDecider(db: DatabaseSync, subjectKey: string): string {
  if (subjectKey.startsWith('project:')) {
    const projectId = subjectKey.slice('project:'.length)
    const row = db.prepare('SELECT owner_human_id FROM project WHERE id = ?').get(projectId) as
      | { owner_human_id: string }
      | undefined
    if (row) return row.owner_human_id
  }
  if (subjectKey.startsWith('work_item:')) {
    const workItemId = subjectKey.slice('work_item:'.length)
    const row = db.prepare('SELECT owner_human_id FROM work_item WHERE id = ?').get(workItemId) as
      | { owner_human_id: string }
      | undefined
    if (row) return row.owner_human_id
  }
  throw new HamsError('POLICY_DENIED', '提议必须挂在项目或工作项上，由对应负责人决定')
}

export const TOOL_NAMES = [
  'hams_list_my_work',
  'hams_get_work_item',
  'hams_claim',
  'hams_assign_task',
  'hams_list_project_work',
  'hams_group_members',
  'hams_group_send',
  'hams_remember',
  'hams_group_spawn_bot',
  'hams_append_evidence',
  'hams_submit_result',
  'hams_evaluate_check',
  'hams_report_blocker',
  'hams_request_closure',
  'hams_propose',
] as const

/** 明确不存在的工具：审批、提议决定、直接关单、任意 SQL。 */
export const FORBIDDEN_TOOL_NAMES = [
  'hams_decide_approval',
  'hams_decide_proposal',
  'hams_close_work_item',
  'hams_sql',
  'hams_http',
] as const
