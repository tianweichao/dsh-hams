/**
 * 服务层测试夹具：一个真实建库的 HAMS（临时目录 + WAL），加一套能跑通闭环的种子数据。
 *
 * 种子只放「测试需要的最小事实」：
 * - 两个人（负责人 / 另一名审批人）+ 一个没岗位的人 + 一个 bot；
 * - 两个岗位与它们的权限并集（岗位能力矩阵本身仍待业务签字，这里只是测试夹具）；
 * - 一个持续运营项目、两版判据模板（人工验收 / 自动关单）、当期的日周额度。
 *
 * 时间用可推进的 `clock` 对象注入，避免测试依赖真实时钟；时区固定 Asia/Shanghai。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { HamsService } from '../../src/service/hams.ts'
import type { CommandContext } from '../../src/service/types.ts'
import { createSandbox, sandboxPath } from '../store/helpers.ts'

/** 2026-11-14 09:00 Asia/Shanghai（周六）。 */
export const AT = Date.UTC(2026, 10, 14, 1, 0, 0)
export const HOUR = 3_600_000
export const DAY = 86_400_000

export const IDS = {
  owner: 'h_owner',
  approver: 'h_approver',
  otherApprover: 'h_other',
  intern: 'h_intern',
  bot: 'b_check',
  coord: 'b_coord',
  project: 'p1',
  template: 'tpl',
  templateAuto: 'tpl_auto',
  templateVersion: 'tv1',
  templateVersionAuto: 'tv_auto',
} as const

export interface Harness {
  root: string
  db: DatabaseSync
  service: HamsService
  clock: { now: number }
  /** 依次生成不重复的 correlationId，方便在审计里定位每一步。 */
  ctx(principalId: string, channel?: CommandContext['channel'], idempotencyKey?: string): CommandContext
  advance(ms: number): void
  close(): void
}

export function createHarness(t: { after: (fn: () => void) => void }): Harness {
  const root = createSandbox(t)
  const db = openDatabase({ path: sandboxPath(root, 'hams.db') })
  migrate(db)
  seedTestData(db)

  const clock = { now: AT }
  const knowledgeData = sandboxPath(root, 'knowledge-data')
  const skillRoot = sandboxPath(root, 'skills')
  const service = new HamsService({
    db,
    now: () => clock.now,
    runtimeEpoch: 1,
    knowledge: { dataDir: knowledgeData, skillDirs: [skillRoot] },
  })
  let counter = 0
  return {
    root,
    db,
    service,
    clock,
    ctx(principalId: string, channel: CommandContext['channel'] = 'ui', idempotencyKey?: string): CommandContext {
      counter += 1
      return { principalId, channel, correlationId: `corr-${counter}`, idempotencyKey }
    },
    advance(ms: number): void {
      clock.now += ms
    },
    close(): void {
      db.close()
    },
  }
}

export function seedTestData(db: DatabaseSync): void {
  const insertMember = db.prepare(
    `INSERT INTO member (id, kind, name, role, owner_human_id, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertMember.run(IDS.owner, 'human', '王（负责人）', 'coordinator', null, 0, AT, AT)
  insertMember.run(IDS.approver, 'human', '李（审批人）', 'executor', null, 0, AT, AT)
  insertMember.run(IDS.otherApprover, 'human', '赵（也在审批岗）', 'executor', null, 0, AT, AT)
  insertMember.run(IDS.intern, 'human', '钱（无在岗岗位）', 'observer', null, 0, AT, AT)
  insertMember.run(IDS.bot, 'bot', '复查助手', 'executor', IDS.owner, 0, AT, AT)
  insertMember.run(IDS.coord, 'bot', '运营协调', 'coordinator', IDS.owner, 0, AT, AT)

  db.prepare('INSERT INTO position (id, name, domain) VALUES (?, ?, ?)').run('pos_owner', '资产运营负责人', '安全')
  db.prepare('INSERT INTO position (id, name, domain) VALUES (?, ?, ?)').run('pos_approver', '安全审批岗', '安全')
  const insertPermission = db.prepare('INSERT INTO position_permission (position_id, capability, scope) VALUES (?, ?, ?)')
  for (const capability of [
    'work_item.create',
    'work_item.accept',
    'work_item.manage',
    'work_item.request_closure',
    'evidence.append',
    'check.evaluate',
    'proposal.decide',
    'approval.decide',
  ]) {
    insertPermission.run('pos_owner', capability, 'global')
  }
  for (const capability of ['approval.decide', 'evidence.append']) {
    insertPermission.run('pos_approver', capability, 'global')
  }
  // M6：项目 / 成员 / 知识的写能力挂在负责人岗位上（与宿主适配器的 pos-owner 一致）。
  for (const capability of [
    'project.create',
    'project.manage',
    'project.archive',
    'target.publish',
    'metric.record',
    'member.manage',
    'knowledge.write',
    'knowledge.sync',
  ]) {
    insertPermission.run('pos_owner', capability, 'global')
  }

  const insertPosition = db.prepare(
    `INSERT INTO member_position (member_id, position_id, starts_at, ends_at, assigned_by)
     VALUES (?, ?, ?, NULL, 'system')`,
  )
  insertPosition.run(IDS.owner, 'pos_owner', AT - DAY)
  insertPosition.run(IDS.approver, 'pos_approver', AT - DAY)
  insertPosition.run(IDS.otherApprover, 'pos_approver', AT - DAY)

  const insertBotPermission = db.prepare(
    `INSERT INTO member_permission (member_id, capability, scope, granted_by, granted_at)
     VALUES (?, ?, 'global', ?, ?)`,
  )
  for (const capability of [
    'work_item.claim',
    'work_item.execute',
    'evidence.append',
    'work_item.request_closure',
    'check.evaluate',
    'proposal.create',
  ]) {
    insertBotPermission.run(IDS.bot, capability, IDS.owner, AT)
  }
  insertBotPermission.run(IDS.coord, 'proposal.create', IDS.owner, AT)

  db.prepare(
    `INSERT INTO project (id, name, type, status, owner_human_id, coordinator_id, goal_text,
                          current_target_version, no_progress_streak, revision, created_at, updated_at)
     VALUES (?, ?, 'continuous', 'active', ?, ?, ?, 1, 0, 1, ?, ?)`,
  ).run(IDS.project, '电池资产持续运营', IDS.owner, IDS.coord, '把电池资产告警的处置闭环率做到 95%', AT, AT)
  db.prepare(
    `INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at)
     VALUES ('pv1', ?, 1, ?, ?, ?)`,
  ).run(IDS.project, '把电池资产告警的处置闭环率做到 95%', IDS.owner, AT)
  const insertMetric = db.prepare(
    `INSERT INTO project_metric
       (id, project_id, version_id, name, direction, target_value, target_max, unit, definition_text,
        calculator_key, calculator_params_json, window_kind, source_kind)
     VALUES (?, ?, 'pv1', ?, ?, ?, NULL, ?, '', NULL, '{}', ?, 'manual')`,
  )
  insertMetric.run('pm-closure', IDS.project, '闭环率', 'higher', 95, '%', 'week')
  insertMetric.run('pm-overdischarge', IDS.project, '过放次数', 'lower', 0, '次', 'day')
  db.prepare(
    `INSERT INTO metric_observation (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
     VALUES ('mo-1', 'pm-closure', ?, ?, ?, 87, 'manual:周报', ?)`,
  ).run(AT, AT - 7 * DAY, AT, AT)
  // 缺数：value=NULL 表示这周没有读数，界面必须显示未知而不是达标。
  db.prepare(
    `INSERT INTO metric_observation (id, metric_id, observed_at, window_start, window_end, value, source_ref, ingested_at)
     VALUES ('mo-2', 'pm-overdischarge', ?, ?, ?, NULL, 'manual:缺数', ?)`,
  ).run(AT, AT - DAY, AT, AT)

  db.prepare(
    'INSERT INTO work_template (id, key, name, domain, category) VALUES (?, ?, ?, ?, ?)',
  ).run(IDS.template, 'battery_alert_tracking', '电池告警追踪', '安全', '安全响应')
  db.prepare(
    'INSERT INTO work_template (id, key, name, domain, category) VALUES (?, ?, ?, ?, ?)',
  ).run(IDS.templateAuto, 'battery_routine', '电池例行复查', '安全', '安全响应')

  const insertVersion = db.prepare(
    `INSERT INTO work_template_version
       (id, template_id, version, required_evidence_json, validator_key, validator_params_json,
        check_policy_json, review_policy_json, misfire_policy, status, published_by, published_at)
     VALUES (?, ?, ?, ?, NULL, '{}', ?, ?, 'each', 'published', ?, ?)`,
  )
  insertVersion.run(
    IDS.templateVersion,
    IDS.template,
    1,
    JSON.stringify([
      { kind: 'reading', min_count: 2, max_age_hours: 48 },
      { kind: 'photo', min_count: 1 },
    ]),
    JSON.stringify({ mode: 'next_day_at', time: '09:00', tz: 'Asia/Shanghai' }),
    JSON.stringify({ approver: 'owner', expires_hours: 24, auto_close: false }),
    IDS.owner,
    AT,
  )
  insertVersion.run(
    IDS.templateVersionAuto,
    IDS.templateAuto,
    1,
    JSON.stringify([{ kind: 'reading', min_count: 1 }]),
    JSON.stringify({ mode: 'after_hours', hours: 24 }),
    JSON.stringify({ approver: 'owner', expires_hours: 24, auto_close: true }),
    IDS.owner,
    AT,
  )
  db.prepare('UPDATE work_template SET published_version_id = ? WHERE id = ?').run(IDS.templateVersion, IDS.template)
  db.prepare('UPDATE work_template SET published_version_id = ? WHERE id = ?').run(
    IDS.templateVersionAuto,
    IDS.templateAuto,
  )

  const insertBudget = db.prepare(
    `INSERT INTO project_budget (project_id, period_kind, period_start, metric, used, limit_value)
     VALUES (?, ?, ?, 'new_tasks', 0, ?)`,
  )
  insertBudget.run(IDS.project, 'day', '2026-11-14', 3)
  insertBudget.run(IDS.project, 'week', '2026-11-09', 10)
}

export interface AlertInputOptions {
  externalEventId?: string
  dedupeKey?: string
  templateVersionId?: string
  ownerHumanId?: string
  title?: string
  occurredAt?: number
}

export function alertInput(options: AlertInputOptions = {}): Parameters<HamsService['ingestAlert']>[1] {
  return {
    connector: 'bms',
    externalEventId: options.externalEventId ?? 'evt-1',
    eventType: 'overdischarge',
    severity: 3,
    occurredAt: options.occurredAt ?? AT - HOUR,
    payloadRef: 'evidence/inbox/evt-1.json',
    asset: { externalSystem: 'bms', externalId: 'BT-20871', displayName: '电池 BT-20871', kind: 'battery' },
    workItem: {
      domain: '安全',
      category: '安全响应',
      title: options.title ?? 'BT-20871 过放告警',
      projectId: IDS.project,
      ownerHumanId: options.ownerHumanId ?? IDS.owner,
      templateVersionId: options.templateVersionId ?? IDS.templateVersion,
      dedupeKey: options.dedupeKey ?? 'alert:BT-20871:overdischarge',
    },
  }
}

/** 把一条告警跑到「已认领、运行中」的便捷函数；返回工作项与运行 id。 */
export function ingestAndClaim(
  harness: Harness,
  options: AlertInputOptions & { sessionId?: string } = {},
): { workItemId: string; runId: string } {
  const ingested = harness.service.ingestAlert(harness.ctx('system', 'system'), alertInput(options))
  const workItemId = ingested.objectId as string
  const claimed = harness.service.claim(harness.ctx(IDS.bot, 'tool'), {
    workItemId,
    sessionId: options.sessionId ?? `sess-${workItemId}`,
  })
  return { workItemId, runId: String(claimed.detail?.runId) }
}

/** 把一单跑到「待验收、审批待决」，需要的证据按模板要求给齐（闭环测试与 tick 测试共用）。 */
export function driveToReview(
  harness: Harness,
  options: { dedupeKey?: string; externalEventId?: string; templateVersionId?: string } = {},
): { workItemId: string; runId: string; approvalId: string } {
  const { workItemId, runId } = ingestAndClaim(harness, options)
  harness.service.startRun(harness.ctx(IDS.bot, 'tool'), { runId })
  harness.service.appendEvidence(harness.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId })
  harness.service.appendEvidence(harness.ctx(IDS.bot, 'tool'), { workItemId, kind: 'reading', ref: 'r2', observedAt: AT, runId })
  harness.service.appendEvidence(harness.ctx(IDS.bot, 'tool'), { workItemId, kind: 'photo', ref: 'p1', observedAt: AT, runId })
  const submitted = harness.service.submitResult(harness.ctx(IDS.bot, 'tool'), { runId, summary: '设备已恢复' })
  harness.advance(DAY)
  harness.service.evaluateCheck(harness.ctx(IDS.bot, 'tool'), { checkId: String(submitted.detail?.checkId) })
  const closure = harness.service.requestClosure(harness.ctx(IDS.bot, 'tool'), { workItemId, reason: '请验收' })
  return { workItemId, runId, approvalId: String(closure.approvalId) }
}
