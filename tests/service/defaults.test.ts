/**
 * 默认 bot / 新建向导草稿 / 归档项目删除。
 *
 * 这三件事都发生在「项目还没进入日常推进」之前，所以用真实的库与命令层测：
 * - 默认 bot 幂等落库，责任人必须是本机操作者；
 * - 不传推进 bot 时落到「项目管理」，显式 null 表示不要；
 * - 草稿可在任何一步保存，发布时才生成目标版本；
 * - 只有归档项目能删，删后列表/详情/群聊不再出现，工作项解绑保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdFactory } from '../../src/domain/ids.ts'
import {
  DEFAULT_ANALYST_NAME,
  DEFAULT_COORDINATOR_NAME,
  defaultCoordinatorId,
  ensureDefaultBots,
} from '../../src/service/defaults.ts'
import { createHamsHttpHandler } from '../../src/http/handler.ts'
import { IDS, createHarness } from './fixtures.ts'

function seedDefaults(h: ReturnType<typeof createHarness>): void {
  ensureDefaultBots(h.db, createIdFactory(() => h.clock.now), h.clock.now, IDS.owner)
}

test('d01 默认 bot：幂等创建项目管理 / 数据分析，能力与版本真实落库', (t) => {
  const h = createHarness(t)
  try {
    const first = ensureDefaultBots(h.db, createIdFactory(() => h.clock.now), h.clock.now, IDS.owner)
    assert.deepEqual(first.created.map((bot) => bot.name), [DEFAULT_COORDINATOR_NAME, DEFAULT_ANALYST_NAME])
    assert.equal(defaultCoordinatorId(h.db), 'bot-pm')

    const pm = h.db.prepare("SELECT kind, role, status, current_version, owner_human_id FROM member WHERE name = ?").get(DEFAULT_COORDINATOR_NAME) as any
    assert.deepEqual({ ...pm }, { kind: 'bot', role: 'coordinator', status: 'active', current_version: 1, owner_human_id: IDS.owner })
    const versions = h.db.prepare("SELECT COUNT(*) AS c FROM member_version WHERE member_id = 'bot-pm'").get() as { c: number }
    assert.equal(Number(versions.c), 1)
    const caps = h.db.prepare("SELECT capability FROM member_permission WHERE member_id = 'bot-pm' ORDER BY capability").all() as Array<{ capability: string }>
    assert.ok(caps.some((row) => row.capability === 'work_item.execute'))
    assert.ok(!caps.some((row) => row.capability === 'approval.decide'), '默认 bot 不能拿人的审批能力')

    const second = ensureDefaultBots(h.db, createIdFactory(() => h.clock.now), h.clock.now, IDS.owner)
    assert.equal(second.created.length, 0)
    assert.equal(second.existing.length, 2)
    assert.equal((h.db.prepare("SELECT COUNT(*) AS c FROM member WHERE name = ?").get(DEFAULT_COORDINATOR_NAME) as { c: number }).c, 1)
  } finally {
    h.close()
  }
})

test('d02 建项目不指定推进 bot：默认落到「项目管理」；显式 null 才是不指定', (t) => {
  const h = createHarness(t)
  try {
    seedDefaults(h)
    const created = h.service.createProject(h.ctx(IDS.owner, 'ui', 'default-coord'), {
      name: '默认推进项目',
      type: 'continuous',
      goalText: '把默认推进链路跑通',
    })
    const detail = h.service.getProjectDetail(h.ctx(IDS.owner), String(created.objectId))
    assert.equal(detail.coordinator_id, 'bot-pm')
    assert.equal(detail.coordinator_name, DEFAULT_COORDINATOR_NAME)

    const analyst = h.db
      .prepare('SELECT member_id, kind FROM project_participant WHERE project_id = ? AND removed_at IS NULL')
      .all(String(created.objectId)) as Array<{ member_id: string; kind: string }>
    assert.deepEqual(analyst.map((row) => [row.member_id, row.kind]), [['bot-data', 'member']], '数据分析 bot 默认进群，@ 得到')

    const none = h.service.createProject(h.ctx(IDS.owner, 'ui', 'no-coord'), {
      name: '我自己推进的项目',
      type: 'one_off',
      goalText: '明确不要推进 bot',
      coordinatorId: null,
    })
    assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner), String(none.objectId)).coordinator_id, null)
  } finally {
    h.close()
  }
})

test('d03 向导草稿：任何一步都能存，发布时生成目标版本并清空草稿', (t) => {
  const h = createHarness(t)
  try {
    seedDefaults(h)
    const saved = h.service.saveProjectDraft(h.ctx(IDS.owner, 'ui', 'draft-1'), {
      name: '草稿项目',
      type: 'one_off',
      goalText: '',
      metrics: [{ name: '完成率', direction: 'higher', targetValue: 90, unit: '%', windowKind: 'week' }],
      step: 2,
    })
    assert.equal(saved.ok, true)
    const projectId = String(saved.objectId)
    const draft = h.service.getProjectDetail(h.ctx(IDS.owner), projectId)
    assert.equal(draft.status, 'draft')
    assert.equal(draft.goal_text, '')
    assert.equal(draft.draft?.step, 2)
    assert.equal(draft.draft?.metrics[0]?.name, '完成率')

    const updated = h.service.saveProjectDraft(h.ctx(IDS.owner, 'ui', 'draft-2'), {
      projectId,
      name: '草稿项目（改过名）',
      type: 'one_off',
      goalText: '把流程跑通',
      metrics: [],
      step: 4,
    })
    assert.equal(updated.ok, true)
    assert.equal(updated.objectId, projectId, '续存不能新建第二个项目')
    const second = h.service.getProjectDetail(h.ctx(IDS.owner), projectId)
    assert.equal(second.name, '草稿项目（改过名）')
    assert.equal(second.draft?.step, 4)

    const published = h.service.publishProjectTarget(h.ctx(IDS.owner, 'ui', 'draft-publish'), {
      projectId,
      goalText: '把流程跑通',
      metrics: [{ name: '完成率', direction: 'higher', targetValue: 90, unit: '%', windowKind: 'week' }],
    })
    assert.equal(published.ok, true)
    const after = h.service.getProjectDetail(h.ctx(IDS.owner), projectId)
    assert.equal(after.status, 'active')
    assert.equal(after.current_target_version, 1)
    assert.equal(after.draft, null, '发布后草稿向导内容清空')
    assert.ok(after.phases.length >= 1, '草稿发布时补默认阶段')
  } finally {
    h.close()
  }
})

test('d04 删除：只有归档项目能删；删后列表/详情消失，工作项解绑保留', (t) => {
  const h = createHarness(t)
  try {
    const created = h.service.createProject(h.ctx(IDS.owner, 'ui', 'del-create'), {
      name: '要删的项目',
      type: 'one_off',
      goalText: '删除行为',
    })
    const projectId = String(created.objectId)
    const workItem = h.service.createWorkItem(h.ctx(IDS.owner, 'ui', 'del-item'), {
      domain: '安全',
      category: '安全响应',
      title: '项目下的工作项',
      projectId,
      templateVersionId: IDS.templateVersion,
      ownerHumanId: IDS.owner,
    })

    assert.throws(
      () => h.service.deleteProject(h.ctx(IDS.owner, 'ui', 'del-too-early'), { projectId }),
      /归档/,
      '未归档不能删',
    )

    h.service.updateProjectStatus(h.ctx(IDS.owner, 'ui', 'del-archive'), { projectId, status: 'archived' })
    const deleted = h.service.deleteProject(h.ctx(IDS.owner, 'ui', 'del-final'), { projectId })
    assert.equal(deleted.ok, true)
    assert.equal(deleted.detail?.detachedWorkItems, 1)

    assert.equal(h.service.listProjects(h.ctx(IDS.owner)).some((row) => row.id === projectId), false)
    assert.throws(() => h.service.getProjectDetail(h.ctx(IDS.owner), projectId), /已删除/)
    const row = h.db.prepare('SELECT project_id FROM work_item WHERE id = ?').get(String(workItem.objectId)) as { project_id: string | null }
    assert.equal(row.project_id, null, '工作项保留，只是解绑项目')

    // 软删后名字可复用（project.name 有 UNIQUE 约束，墓碑名 + deleted_name 保原值）。
    const reuse = h.service.createProject(h.ctx(IDS.owner, 'ui', 'del-reuse'), {
      name: '要删的项目',
      type: 'one_off',
      goalText: '同名新建',
    })
    assert.equal(reuse.ok, true)
    assert.notEqual(reuse.objectId, projectId)
  } finally {
    h.close()
  }
})

test('d05 HTTP：saveDraft / delete 走标准信封，删除前必须先归档', (t) => {
  const h = createHarness(t)
  try {
    const handler = createHamsHttpHandler({ service: h.service, authenticate: () => ({ ok: true, principalId: IDS.owner }) })
    const call = (path: string, body: Record<string, unknown>) =>
      JSON.parse(handler({ method: 'POST', path: `/hams/api/v1/${path}`, headers: {}, body: JSON.stringify({ commandId: 'ui', ...body }) }).body)
    const draft = call('project/saveDraft', {
      idempotencyKey: 'draft-http-1',
      payload: { name: 'HTTP 草稿', type: 'one_off', goalText: '', metrics: [], step: 1 },
    })
    assert.equal(draft.ok, true)
    assert.equal(typeof draft.objectId, 'string')
    const detail = call('project/get', { objectId: draft.objectId })
    assert.equal(detail.data.draft.step, 1)

    const early = call('project/delete', { idempotencyKey: 'delete-http-1', objectId: draft.objectId, payload: { projectId: draft.objectId } })
    assert.equal(early.ok, false)
    assert.match(String(early.error.message), /归档/)

    call('project/status', { idempotencyKey: 'archive-http-1', objectId: draft.objectId, payload: { projectId: draft.objectId, status: 'archived' } })
    const deleted = call('project/delete', { idempotencyKey: 'delete-http-2', objectId: draft.objectId, payload: { projectId: draft.objectId } })
    assert.equal(deleted.ok, true)
    const list = call('project/list', { payload: {} })
    assert.equal(list.data.some((row: { id: string }) => row.id === draft.objectId), false)
  } finally {
    h.close()
  }
})
