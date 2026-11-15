/**
 * 服务层共享类型：命令上下文与回执。
 *
 * 两条边界：
 * - `principalId` 只能由进站适配器从服务端上下文解析后传入，**绝不读请求体**（C5 结论）；
 * - 业务成败写在回执的 `ok` / `status` 上，HTTP 状态码只表达传输层（backend-design §9）。
 */
import type { HamsErrorCode } from '../domain/errors.ts'

export type Channel = 'ui' | 'tool' | 'system' | 'connector'
export type MemberKind = 'human' | 'bot' | 'system'

export interface CommandContext {
  /** 服务端解析出来的操作者；不接受客户端自报。 */
  principalId: string
  channel: Channel
  correlationId: string
  /** 写命令的幂等键；同一 principal + action + key 只产生一次业务效果。 */
  idempotencyKey?: string
  expectedRevision?: number
  /** 代录：实际操作人（P1 单机模式下他人参与的留痕方式）。 */
  onBehalfOf?: string
  authSubject?: string
  hostPreset?: string
}

export interface CommandReceipt {
  ok: boolean
  status: 'applied' | 'accepted' | 'rejected'
  objectId?: string
  objectRevision?: number
  executionEpoch?: number
  approvalId?: string
  auditId: string
  correlationId: string
  detail?: Record<string, unknown>
  error?: {
    code: HamsErrorCode
    message: string
    nextStep?: string
    detail?: unknown
  }
}

export interface Principal {
  memberId: string
  kind: MemberKind
  name: string
  role: string
  status: string
  currentVersion: number
  positions: { positionId: string; name: string }[]
  capabilities: Set<string>
}

export interface WorkItemRow {
  id: string
  project_id: string | null
  parent_id: string | null
  template_version_id: string | null
  asset_id: string | null
  domain: string
  category: string
  title: string
  priority: number
  status: string
  resume_state: string | null
  blocked_reason: string | null
  owner_human_id: string
  assignee_id: string | null
  due_at: number | null
  next_action_at: number | null
  check_generation: number
  close_requires_approval: number
  dedupe_key: string | null
  revision: number
  execution_epoch: number
  fence_seq: number
  evidence_set_hash: string
  created_by: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface ApprovalRow {
  id: string
  subject_kind: string
  subject_id: string
  subject_revision: number
  execution_epoch: number
  evidence_set_hash: string
  criteria_ref: string
  criteria_json: string
  reason_text: string
  requested_by: string
  requested_channel: string
  approver_id: string
  status: string
  decided_by: string | null
  decided_channel: string | null
  decision_note: string
  decided_at: number | null
  invalidated_reason: string | null
  expires_at: number
  created_at: number
}

export interface CheckRow {
  id: string
  work_item_id: string
  generation: number
  execution_epoch: number
  template_version_id: string | null
  planned_due_at: number
  status: string
  evidence_set_hash: string
  result_json: string
  evaluated_at: number | null
  created_at: number
}

export interface TemplateRow {
  id: string
  key: string
  name: string
  domain: string
  category: string
  published_version_id: string | null
}

export interface TemplateVersionRow {
  id: string
  template_id: string
  version: number
  required_evidence_json: string
  validator_key: string | null
  validator_params_json: string
  check_policy_json: string
  review_policy_json: string
  misfire_policy: string
  status: string
  published_by: string | null
  published_at: number | null
}

export interface RunRow {
  id: string
  work_item_id: string
  thread_id: string
  check_id: string | null
  member_id: string
  member_version: number
  execution_epoch: number
  runtime_epoch: number
  fence: number
  trigger: string
  attempt: number
  status: string
  result_summary: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export interface ThreadRow {
  id: string
  work_item_id: string
  generation: number
  session_id: string
  member_id: string
  member_version: number
  status: string
  turn_count: number
  opened_at: number
  closed_at: number | null
  close_reason: string | null
}

export interface EvidenceRow {
  id: string
  work_item_id: string
  run_id: string | null
  kind: string
  ref: string
  content_hash: string
  source: string
  observed_at: number
  captured_at: number
  captured_by: string
  on_behalf_of: string | null
  supersedes_id: string | null
  status: string
  verified_by: string | null
  verified_at: number | null
  purged_at: number | null
}

export interface ProposalRow {
  id: string
  subject_key: string
  project_id: string | null
  work_item_id: string | null
  kind: string
  dedupe_key: string
  proposed_by: string
  decider_id: string
  title: string
  body: string
  rationale_json: string
  impact_json: string
  status: string
  duplicate_count: number
  snoozed_until: number | null
  expires_at: number | null
  result_work_item_id: string | null
  revision: number
  created_at: number
}
