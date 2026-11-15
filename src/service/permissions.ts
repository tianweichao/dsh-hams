/**
 * 主体解析与能力校验。
 *
 * 铁律（backend-design §4.1 / §11）：
 * - 人的能力只来自「在岗岗位」的并集：`member_position` 的 [starts_at, ends_at) 必须覆盖当前时刻；
 * - bot 的能力只来自 `member_permission`，且审批/发布类能力由库触发器拒绝授予；
 * - 系统主体 `id='system'` 只用于自动化写入，不参与业务授权判断；
 * - 没有在岗岗位的人 = 只读：任何写命令一律 POLICY_DENIED（对应 ㉑ 第 3 格）。
 *
 * 能力名先按首版闭环需要收敛成一组常量；8 个岗位的完整矩阵仍需业务签字（status §5），
 * 所以这里只定义「有哪些能力名」，不内置任何岗位 → 能力的映射。
 */
import type { DatabaseSync } from 'node:sqlite'
import { denied } from '../domain/errors.ts'
import type { Principal } from './types.ts'

export const CAPABILITY = {
  workItemCreate: 'work_item.create',
  workItemAccept: 'work_item.accept',
  workItemManage: 'work_item.manage',
  workItemClaim: 'work_item.claim',
  workItemExecute: 'work_item.execute',
  workItemRequestClosure: 'work_item.request_closure',
  evidenceAppend: 'evidence.append',
  checkEvaluate: 'check.evaluate',
  proposalCreate: 'proposal.create',
  proposalDecide: 'proposal.decide',
  approvalDecide: 'approval.decide',
  connectorIngest: 'connector.ingest',
  // M6：项目 / 指标 / 知识（人的能力仍只从在岗岗位来）
  projectCreate: 'project.create',
  projectManage: 'project.manage',
  metricRecord: 'metric.record',
  knowledgeWrite: 'knowledge.write',
  knowledgeSync: 'knowledge.sync',
} as const

/** 只能给人、不得授予 bot 的能力（与库触发器 trg_bot_no_human_capability 保持一致）。 */
export const HUMAN_ONLY_CAPABILITIES = [
  'approval.decide',
  'proposal.decide',
  'work_item.close',
  'skill.publish',
  'target.publish',
  'review.confirm',
  'project.archive',
  'member.manage',
  'position.manage',
  'permission.grant',
] as const

export function resolvePrincipal(db: DatabaseSync, memberId: string, nowMs: number): Principal {
  const member = db
    .prepare('SELECT id, kind, name, role, status, current_version FROM member WHERE id = ?')
    .get(memberId) as
    | { id: string; kind: string; name: string; role: string; status: string; current_version: number }
    | undefined
  if (!member) throw denied(`主体不存在：${memberId}`)
  if (member.status !== 'active') throw denied(`主体已停用：${member.name}`)

  const capabilities = new Set<string>()
  const positions: { positionId: string; name: string }[] = []

  if (member.kind === 'human') {
    const rows = db
      .prepare(
        `SELECT pp.capability AS capability, p.id AS position_id, p.name AS position_name
           FROM member_position mp
           JOIN position p ON p.id = mp.position_id AND p.status = 'active'
           JOIN position_permission pp ON pp.position_id = mp.position_id
          WHERE mp.member_id = ?
            AND mp.starts_at <= ?
            AND (mp.ends_at IS NULL OR mp.ends_at > ?)`,
      )
      .all(member.id, nowMs, nowMs) as { capability: string; position_id: string; position_name: string }[]
    for (const row of rows) {
      capabilities.add(row.capability)
      if (!positions.some((item) => item.positionId === row.position_id)) {
        positions.push({ positionId: row.position_id, name: row.position_name })
      }
    }
  } else if (member.kind === 'bot') {
    const rows = db
      .prepare('SELECT capability FROM member_permission WHERE member_id = ?')
      .all(member.id) as { capability: string }[]
    for (const row of rows) capabilities.add(row.capability)
  }

  return {
    memberId: member.id,
    kind: member.kind as Principal['kind'],
    name: member.name,
    role: member.role,
    status: member.status,
    currentVersion: Number(member.current_version),
    positions,
    capabilities,
  }
}

export function requireCapability(principal: Principal, capability: string): void {
  if (principal.kind === 'system') return
  if (!principal.capabilities.has(capability)) {
    throw denied(`「${principal.name}」没有 ${capability} 能力`, '确认岗位是否在岗，或由管理员补充授权')
  }
}

export function requireHuman(principal: Principal): void {
  if (principal.kind !== 'human') throw denied('该操作只允许人执行')
}

export function requireBot(principal: Principal): void {
  if (principal.kind !== 'bot') throw denied('该操作只允许 bot 执行')
}

export function isSystem(principal: Principal): boolean {
  return principal.kind === 'system'
}
