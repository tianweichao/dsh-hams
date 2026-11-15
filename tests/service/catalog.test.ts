/**
 * M6：项目 / 人机成员 / 知识三屏的后端接入。
 *
 * 判据是「接的是真实数据」：
 * - 项目读模型来自 project / project_metric / metric_observation 三张真表；
 * - 成员能力来自岗位并集或 member_permission，不是界面自报；
 * - 知识三类资产分别来自磁盘上的 skill 文件、导入的 Markdown 文件、HAMS 自己的业务表。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHarness, IDS } from './fixtures.ts'
import { sandboxPath } from '../store/helpers.ts'

// ───────────────────────── 项目 ─────────────────────────

test('m01 项目读模型：真实 project + 指标 + 读数，缺数显示 null', (t) => {
  const h = createHarness(t)
  const list = h.service.listProjects(h.ctx(IDS.owner))
  assert.equal(list.length, 1)
  const project = list[0]
  assert.equal(project.id, IDS.project)
  assert.equal(project.owner_name, '王（负责人）')
  assert.equal(project.coordinator_name, '运营协调')
  assert.equal(project.metric_count, 2)
  assert.equal(project.observation_count, 2)
  assert.equal(project.current_target_version, 1)

  const detail = h.service.getProjectDetail(h.ctx(IDS.owner), IDS.project)
  assert.equal(detail.metrics.length, 2)
  const closure = detail.metrics.find((metric) => metric.id === 'pm-closure')
  assert.ok(closure)
  assert.equal(closure.latest?.value, 87)
  assert.equal(closure.series.length, 1)
  const count = detail.metrics.find((metric) => metric.id === 'pm-overdischarge')
  assert.ok(count)
  assert.equal(count.latest?.value, null, 'value=NULL 必须原样返回 null，界面才能显示未知')
  assert.deepEqual(detail.budgets.map((budget) => budget.period_kind), ['day', 'week'])
  assert.ok(detail.allowedActions.includes('publish') === false)
  assert.ok(detail.allowedActions.includes('createWorkItem'))
  h.close()
})

test('m02 新建项目：负责人是当前主体，发布目标 v1，指标与读数真实落库', (t) => {
  const h = createHarness(t)
  const receipt = h.service.createProject(h.ctx(IDS.owner, 'ui', 'proj-create-1'), {
    name: '电池备件周转',
    type: 'one_off',
    goalText: '把备件周转天数压到 7 天以内',
    coordinatorId: IDS.coord,
    metrics: [
      { name: '周转天数', direction: 'lower', targetValue: 7, unit: '天', windowKind: 'week' },
      { name: '缺料次数', direction: 'lower', targetValue: 0, unit: '次', windowKind: 'day' },
    ],
  })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.status, 'applied')
  const projectId = String(receipt.objectId)
  const detail = h.service.getProjectDetail(h.ctx(IDS.owner), projectId)
  assert.equal(detail.status, 'active')
  assert.equal(detail.owner_human_id, IDS.owner)
  assert.equal(detail.current_target_version, 1)
  assert.equal(detail.target_versions.length, 1)
  assert.equal(detail.metrics.length, 2)
  assert.equal(detail.budgets.length, 0, '新项目没有额度就显示 0，不伪造')

  const metric = detail.metrics[0]
  const observed = h.service.recordMetric(h.ctx(IDS.owner, 'ui', 'metric-1'), {
    projectId,
    metricId: metric.id,
    value: 9.5,
    sourceRef: '手动：周报',
  })
  assert.equal(observed.status, 'applied')
  const after = h.service.getProjectDetail(h.ctx(IDS.owner), projectId)
  assert.equal(after.metrics.find((item) => item.id === metric.id)?.latest?.value, 9.5)

  // 幂等：同键同载荷返回首次回执，不会造第二个项目。
  const input = {
    name: '电池备件周转',
    type: 'one_off',
    goalText: '把备件周转天数压到 7 天以内',
    coordinatorId: IDS.coord,
    metrics: [
      { name: '周转天数', direction: 'lower', targetValue: 7, unit: '天', windowKind: 'week' },
      { name: '缺料次数', direction: 'lower', targetValue: 0, unit: '次', windowKind: 'day' },
    ],
  }
  const again = h.service.createProject(h.ctx(IDS.owner, 'ui', 'proj-create-1'), input)
  assert.equal(again.objectId, projectId)
  h.close()
})

test('m03 项目命令的权限与状态机：只读主体被拒，归档要 project.archive', (t) => {
  const h = createHarness(t)
  assert.throws(
    () => h.service.createProject(h.ctx(IDS.intern), { name: 'x', type: 'one_off', goalText: 'y' }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  assert.throws(
    () => h.service.updateProjectStatus(h.ctx(IDS.approver), { projectId: IDS.project, status: 'paused' }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  const paused = h.service.updateProjectStatus(h.ctx(IDS.owner), { projectId: IDS.project, status: 'paused' })
  assert.equal(paused.detail?.after, 'paused')
  const archived = h.service.updateProjectStatus(h.ctx(IDS.owner), { projectId: IDS.project, status: 'archived' })
  assert.equal(archived.detail?.after, 'archived')
  assert.throws(
    () => h.service.updateProjectStatus(h.ctx(IDS.owner), { projectId: IDS.project, status: 'active' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  h.close()
})

test('m04 建草稿再发布：没目标不给建，草稿发布时生成 v1 目标版本', (t) => {
  const h = createHarness(t)
  assert.throws(
    () => h.service.createProject(h.ctx(IDS.owner), { name: '草稿无目标', type: 'one_off', goalText: '  ' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  const draft = h.service.createProject(h.ctx(IDS.owner), {
    name: '草稿项目',
    type: 'one_off',
    goalText: '先写目标，晚点发布',
    publish: false,
  })
  const id = String(draft.objectId)
  const before = h.service.getProjectDetail(h.ctx(IDS.owner), id)
  assert.equal(before.status, 'draft')
  assert.equal(before.target_versions.length, 0)
  const published = h.service.updateProjectStatus(h.ctx(IDS.owner), { projectId: id, status: 'active' })
  assert.ok(published.detail?.targetVersionId)
  const after = h.service.getProjectDetail(h.ctx(IDS.owner), id)
  assert.equal(after.status, 'active')
  assert.equal(after.target_versions.length, 1)
  assert.equal(after.current_target?.version, 1)
  h.close()
})

// ───────────────────────── 人机成员 ─────────────────────────

test('m05 成员列表：能力来自岗位并集 / member_permission，系统主体不出现', (t) => {
  const h = createHarness(t)
  const list = h.service.listMembers(h.ctx(IDS.owner))
  assert.equal(list.length, 6)
  assert.ok(!list.some((item) => item.id === 'system'))
  const owner = list.find((item) => item.id === IDS.owner)
  assert.ok(owner)
  assert.ok(owner.capabilities.includes('member.manage'))
  assert.ok(owner.capabilities.includes('knowledge.sync'))
  assert.deepEqual(owner.positions.map((item) => item.id), ['pos_owner'])
  const intern = list.find((item) => item.id === IDS.intern)
  assert.deepEqual(intern?.capabilities, [], '没在岗岗位的人 = 只读')
  const bot = list.find((item) => item.id === IDS.bot)
  assert.deepEqual(bot?.capabilities.sort(), [
    'check.evaluate',
    'evidence.append',
    'proposal.create',
    'work_item.claim',
    'work_item.execute',
    'work_item.request_closure',
  ])

  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), IDS.owner)
  assert.equal(detail.login?.auth_source, undefined, '夹具里的负责人没有 hams_user')
  assert.ok(detail.position_history.length >= 1)
  assert.ok(h.service.listPositions(h.ctx(IDS.owner)).some((position) => position.id === 'pos_owner'))
  h.close()
})

test('m06 新建人：绑岗位才拿到能力；没有 member.manage 的人建不了', (t) => {
  const h = createHarness(t)
  const created = h.service.createMember(h.ctx(IDS.owner, 'ui', 'member-create-1'), {
    kind: 'human',
    name: '孙（新审批人）',
    role: 'executor',
    positionId: 'pos_approver',
    domain: '安全',
    responsibility: '复核告警处置',
  })
  assert.equal(created.status, 'applied')
  const memberId = String(created.objectId)
  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), memberId)
  assert.equal(detail.kind, 'human')
  assert.deepEqual(detail.capabilities.sort(), ['approval.decide', 'evidence.append'])
  assert.equal(detail.positions.length, 1)
  assert.equal(detail.recent_work.length, 0)

  assert.throws(
    () => h.service.createMember(h.ctx(IDS.approver), { kind: 'human', name: 'x', positionId: 'pos_approver' }),
    (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
  )
  h.close()
})

test('m07 新建 bot：版本快照 + 能力白名单；审批类能力不能授予 bot', (t) => {
  const h = createHarness(t)
  const created = h.service.createMember(h.ctx(IDS.owner), {
    kind: 'bot',
    name: '复查执行 bot',
    role: 'executor',
    agentPreset: 'reader',
    model: 'deepseek-chat',
    capabilities: ['work_item.claim', 'work_item.execute', 'evidence.append'],
  })
  const botId = String(created.objectId)
  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), botId)
  assert.equal(detail.kind, 'bot')
  assert.equal(detail.current_version, 1)
  assert.equal(detail.bot_versions.length, 1)
  assert.equal(detail.bot_versions[0].model, 'deepseek-chat')
  assert.equal(detail.permissions.length, 3)
  assert.deepEqual(detail.capabilities.sort(), ['evidence.append', 'work_item.claim', 'work_item.execute'])
  assert.throws(
    () =>
      h.service.createMember(h.ctx(IDS.owner), {
        kind: 'bot',
        name: '越权 bot',
        capabilities: ['approval.decide'],
      }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  h.close()
})

test('m08 成员状态：不能改自己；退休人时关闭在岗区间', (t) => {
  const h = createHarness(t)
  assert.throws(
    () => h.service.updateMemberStatus(h.ctx(IDS.owner), { memberId: IDS.owner, status: 'paused' }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  const created = h.service.createMember(h.ctx(IDS.owner), {
    kind: 'human',
    name: '待退休的人',
    positionId: 'pos_approver',
  })
  const memberId = String(created.objectId)
  const paused = h.service.updateMemberStatus(h.ctx(IDS.owner), { memberId, status: 'paused' })
  assert.equal(paused.detail?.after, 'paused')
  const retired = h.service.updateMemberStatus(h.ctx(IDS.owner), { memberId, status: 'retired' })
  assert.equal(retired.detail?.closedPositions, 1)
  const detail = h.service.getMemberDetail(h.ctx(IDS.owner), memberId)
  assert.deepEqual(detail.capabilities, [], '退休后岗位结束，能力清空')
  h.close()
})

// ───────────────────────── 知识 ─────────────────────────

function writeSkill(root: string, dir: string, name: string, body: string): string {
  const folder = sandboxPath(root, 'skills', dir)
  mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'SKILL.md')
  writeFileSync(
    file,
    ['---', `name: ${name}`, `description: ${name} 的说明`, '---', '', body].join('\n'),
    'utf8',
  )
  return file
}

test('m09 知识同步：技能来自磁盘真实文件，表结构来自 HAMS 自己的库，重复执行幂等', (t) => {
  const h = createHarness(t)
  writeSkill(h.root, 'alpha-skill', 'alpha-skill', '# Alpha\n\n正文 A')
  writeSkill(h.root, 'beta-skill', 'beta-skill', '# Beta\n\n正文 B')

  const first = h.service.syncKnowledge(h.ctx(IDS.owner))
  assert.equal(first.status, 'applied')
  const report = (first.detail?.report ?? {}) as {
    skills: { created: number; updated: number; unchanged: number }
    tables: { created: number }
  }
  assert.equal(report.skills.created, 2)
  assert.equal(report.tables.created, 12)

  const list = h.service.listKnowledge(h.ctx(IDS.owner))
  assert.equal(list.counts.skills, 2)
  assert.equal(list.counts.tables, 12)
  const skill = list.items.find((item) => item.kind === 'skill' && item.name === 'alpha-skill')
  assert.ok(skill)
  const detail = h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'skill', id: skill.id })
  assert.ok('content' in detail && detail.content.includes('正文 A'))
  assert.ok('description' in detail && detail.description === 'alpha-skill 的说明')
  assert.deepEqual(detail.allowedActions, ['sync'])

  const table = list.items.find((item) => item.kind === 'table' && item.name.includes('work_item'))
  assert.ok(table)
  const tableDetail = h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'table', id: table.id })
  assert.ok('live' in tableDetail && tableDetail.live === true)
  assert.ok('columns_detail' in tableDetail && tableDetail.columns_detail.length > 10)
  assert.equal(typeof (tableDetail as { row_count: number | null }).row_count, 'number')

  const second = h.service.syncKnowledge(h.ctx(IDS.owner))
  const secondReport = (second.detail?.report ?? {}) as { skills: { unchanged: number; created: number } }
  assert.equal(secondReport.skills.unchanged, 2)
  assert.equal(secondReport.skills.created, 0)

  writeSkill(h.root, 'alpha-skill', 'alpha-skill', '# Alpha\n\n正文 A 改了')
  const third = h.service.syncKnowledge(h.ctx(IDS.owner))
  const thirdReport = (third.detail?.report ?? {}) as { skills: { updated: number } }
  assert.equal(thirdReport.skills.updated, 1)
  const versions = h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'skill', id: skill.id })
  assert.ok('versions' in versions && versions.versions.length === 2)
  assert.equal(versions.versions[0].status, 'published')
  assert.equal(versions.versions[1].status, 'retired')
  h.close()
})

test('m10 知识文档：面板内撰写落成真实文件，改稿留旧版本，发布改状态', (t) => {
  const h = createHarness(t)
  const created = h.service.createKnowledgeDoc(h.ctx(IDS.owner), {
    title: '过放处置规程',
    body: '# 步骤\n\n1. 断电\n2. 拍照',
  })
  const docId = String(created.objectId)
  const file = String(created.detail?.path)
  assert.ok(existsSync(file), '正文必须真的写到磁盘')
  assert.match(readFileSync(file, 'utf8'), /title:/)

  const detail = h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'doc', id: docId })
  assert.ok('content' in detail && detail.content.includes('断电'))
  assert.equal((detail as { status: string }).status, 'draft')
  assert.deepEqual(detail.allowedActions.sort(), ['edit', 'publish'])

  const updated = h.service.updateKnowledgeDoc(h.ctx(IDS.owner), {
    docId,
    body: '# 步骤\n\n1. 断电\n2. 拍照\n3. 通知',
    expectedRevision: 1,
  })
  assert.equal(updated.objectRevision, 2)
  assert.ok(existsSync(path.join(h.root, 'knowledge-data', 'knowledge', 'docs', `${docId}.v1.md`)), '旧版本要留档')
  assert.throws(
    () => h.service.updateKnowledgeDoc(h.ctx(IDS.owner), { docId, body: 'x', expectedRevision: 1 }),
    (error: unknown) => (error as { code?: string }).code === 'STATE_INVALID',
  )
  const published = h.service.publishKnowledgeDoc(h.ctx(IDS.owner), { docId })
  assert.equal(published.detail?.status, 'published')
  assert.equal((h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'doc', id: docId }) as { status: string }).status, 'published')
  h.close()
})

test('m11 知识导入：登记真实 Markdown 路径与哈希，源文件改动后重新导入会升版', (t) => {
  const h = createHarness(t)
  const source = sandboxPath(h.root, 'notes')
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'a.md'), '# 甲\n\n内容 A\n', 'utf8')
  writeFileSync(path.join(source, 'b.md'), '---\ntitle: 乙文档\n---\n\n内容 B\n', 'utf8')
  writeFileSync(path.join(source, 'ignore.txt'), 'not markdown', 'utf8')

  const first = h.service.importKnowledgeDocs(h.ctx(IDS.owner), { dir: source })
  const report = (first.detail?.report ?? {}) as { scanned: number; imported: number; skipped: number }
  assert.equal(report.scanned, 2)
  assert.equal(report.imported, 2)

  const list = h.service.listKnowledge(h.ctx(IDS.owner), { kind: 'doc' })
  const docB = list.items.find((item) => item.kind === 'doc' && item.title === '乙文档')
  assert.ok(docB, 'frontmatter 的 title 要作为文档标题')
  const detail = h.service.getKnowledge(h.ctx(IDS.owner), { kind: 'doc', id: docB.id })
  assert.equal((detail as { source_kind: string }).source_kind, 'file')
  assert.equal((detail as { present: boolean }).present, true)
  assert.deepEqual(detail.allowedActions, [], '导入的源文件不在面板里改')

  const again = h.service.importKnowledgeDocs(h.ctx(IDS.owner), { dir: source })
  assert.equal((again.detail?.report as { skipped: number }).skipped, 2)

  writeFileSync(path.join(source, 'a.md'), '# 甲\n\n内容 A 改了\n', 'utf8')
  const third = h.service.importKnowledgeDocs(h.ctx(IDS.owner), { dir: source })
  assert.equal((third.detail?.report as { updated: number }).updated, 1)

  h.close()
})
