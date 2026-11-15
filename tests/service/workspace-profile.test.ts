/**
 * 工作区画像：把真实项目/角色/下一步/文档一次性灌进 HAMS。
 *
 * 判据：只补缺失、不覆盖；重复应用不产生重复行；文档登记真实路径；
 * 旧示例模板只在没有任何单据引用时删除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHarness, IDS } from './fixtures.ts'
import { sandboxPath } from '../store/helpers.ts'
import { applyWorkspaceProfile, defaultProfilePath } from '../../src/service/workspace-profile.ts'
import { createIdFactory } from '../../src/domain/ids.ts'

function writeProfile(root: string, overrides: Record<string, unknown> = {}): string {
  const dataDir = sandboxPath(root, 'profile-data')
  mkdirSync(dataDir, { recursive: true })
  const file = defaultProfilePath(dataDir)
  const docsDir = sandboxPath(root, 'profile-docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(path.join(docsDir, 'a.md'), '# 文档 A\n\n真实内容 A\n', 'utf8')
  writeFileSync(path.join(docsDir, 'b.md'), '---\ntitle: 文档 B\n---\n\n真实内容 B\n', 'utf8')
  const profile = {
    version: 1,
    workspaceRoot: root,
    template: {
      id: 'tpl-profile-test',
      versionId: 'tpl-profile-test-v1',
      key: 'profile_test',
      name: '画像测试模板',
      domain: '研究',
      category: '研究推进',
      requiredEvidence: [{ kind: 'doc', min_count: 1 }],
      checkPolicy: { mode: 'after_hours', hours: 72 },
      reviewPolicy: { approver: 'owner', expires_hours: 72, auto_close: false },
    },
    members: [
      {
        key: 'researcher',
        kind: 'bot',
        name: '画像研究 agent',
        role: 'executor',
        domain: '投资',
        responsibility: '测试角色',
        capabilities: ['work_item.claim', 'evidence.append'],
      },
    ],
    projects: [
      {
        key: 'p-test',
        name: '画像测试项目',
        type: 'continuous',
        status: 'active',
        goalText: '验证画像可以落成真实项目与指标',
        coordinatorKey: 'researcher',
        metrics: [
          {
            name: '已入库条目',
            direction: 'higher',
            targetValue: 10,
            unit: '条',
            windowKind: 'snapshot',
            sourceKind: 'manual',
            observations: [{ value: 7, sourceRef: 'profile:a.md' }],
          },
        ],
      },
    ],
    workItems: [
      {
        key: 'w-test',
        projectKey: 'p-test',
        title: '画像测试工作项',
        domain: '研究',
        category: '研究推进',
        priority: 1,
        dueInDays: 3,
        source: 'profile-docs/a.md',
      },
    ],
    docs: [
      { path: 'profile-docs/a.md', title: '画像文档 A' },
      { path: 'profile-docs/b.md' },
    ],
    overview: { title: '画像总览', body: '这是画像生成的总览。' },
    cleanupTemplates: ['tpl-battery-alert'],
    ...overrides,
  }
  writeFileSync(file, JSON.stringify(profile, null, 2), 'utf8')
  return file
}

test('w01 画像应用：成员/项目/工作项/文档/总览/技能全部落库，重复应用不翻倍', (t) => {
  const h = createHarness(t)
  const skills = sandboxPath(h.root, 'skills', 'profile-skill')
  mkdirSync(skills, { recursive: true })
  writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: profile-skill\ndescription: 画像技能\n---\n\n# 正文\n', 'utf8')
  const file = writeProfile(h.root)
  const options = {
    db: h.db,
    dataDir: sandboxPath(h.root, 'profile-data'),
    operatorId: IDS.owner,
    now: h.clock.now,
    idFactory: createIdFactory(() => h.clock.now),
    file,
    workspaceRoot: h.root,
    skillDirs: [sandboxPath(h.root, 'skills')],
  }

  const first = applyWorkspaceProfile(options)
  assert.equal(first.status, 'applied', JSON.stringify(first.errors))
  assert.equal(first.created.members, 1)
  assert.equal(first.created.projects, 1)
  assert.equal(first.created.workItems, 1)
  assert.equal(first.created.observations, 1)
  assert.equal(first.created.docs, 3, '两篇导入 + 一篇总览')
  assert.equal(first.created.skills, 1)
  assert.equal(first.created.tables, 12)
  assert.equal(first.errors.length, 0)

  const member = h.service.listMembers(h.ctx(IDS.owner)).find((item) => item.name === '画像研究 agent')
  assert.ok(member)
  assert.equal(member.kind, 'bot')
  const project = h.service.listProjects(h.ctx(IDS.owner)).find((item) => item.name === '画像测试项目')
  assert.ok(project)
  const detail = h.service.getProjectDetail(h.ctx(IDS.owner), project.id)
  assert.equal(detail.metrics[0].latest?.value, 7)
  assert.equal(detail.coordinator_id, member.id)

  const items = h.service.listWorkItems(h.ctx(IDS.owner))
  const item = items.find((row) => row.title === '画像测试工作项')
  assert.ok(item)
  assert.equal(item.project_id, project.id)
  assert.ok(item.template_version_id)
  const sourceEvent = h.db
    .prepare("SELECT payload_json FROM work_item_event WHERE work_item_id = ? AND kind = 'profile_source'")
    .get(item.id) as { payload_json: string } | undefined
  assert.match(sourceEvent?.payload_json ?? '', /profile-docs\/a\.md/)

  const docs = h.service.listKnowledge(h.ctx(IDS.owner), { kind: 'doc' })
  assert.ok(docs.items.some((doc) => doc.kind === 'doc' && doc.title === '画像文档 A'))
  assert.ok(docs.items.some((doc) => doc.kind === 'doc' && doc.title === '文档 B'), 'frontmatter 标题优先')
  assert.ok(docs.items.some((doc) => doc.kind === 'doc' && doc.title === '画像总览'))

  const second = applyWorkspaceProfile(options)
  assert.equal(second.status, 'unchanged')
  assert.equal(h.service.listMembers(h.ctx(IDS.owner)).filter((row) => row.name === '画像研究 agent').length, 1)
  assert.equal(h.service.listWorkItems(h.ctx(IDS.owner)).filter((row) => row.title === '画像测试工作项').length, 1)
  assert.equal(h.service.listProjects(h.ctx(IDS.owner)).filter((row) => row.name === '画像测试项目').length, 1)
  h.close()
})

test('w02 旧示例模板：没有单据引用才删除，有引用就保留', (t) => {
  const h = createHarness(t)
  const insertTemplate = () => {
    h.db.prepare("INSERT INTO work_template (id, key, name, domain, category) VALUES ('tpl-battery-alert','legacy_battery_example','电池告警追踪','安全','安全响应')").run()
    h.db.prepare(
      `INSERT INTO work_template_version
         (id, template_id, version, required_evidence_json, validator_key, validator_params_json,
          check_policy_json, review_policy_json, misfire_policy, status, published_by, published_at)
       VALUES ('tpl-battery-alert-v1','tpl-battery-alert',1,'[]','{}','{}','{}','{}','each','published',?,?)`,
    ).run(IDS.owner, h.clock.now)
    h.db.prepare("UPDATE work_template SET published_version_id='tpl-battery-alert-v1' WHERE id='tpl-battery-alert'").run()
  }

  // 没有任何工作项引用：应用画像后应被清掉。
  insertTemplate()
  const file = writeProfile(h.root)
  const options = {
    db: h.db,
    dataDir: sandboxPath(h.root, 'profile-data'),
    operatorId: IDS.owner,
    now: h.clock.now,
    idFactory: createIdFactory(() => h.clock.now),
    file,
    workspaceRoot: h.root,
  }
  const report = applyWorkspaceProfile(options)
  assert.equal(report.created.removedTemplates, 1)
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM work_template WHERE id='tpl-battery-alert'").get().c, 0)
  h.close()

  // 有工作项引用：必须保留。
  const h2 = createHarness(t)
  h2.db.prepare("INSERT INTO work_template (id, key, name, domain, category) VALUES ('tpl-battery-alert','legacy_battery_example','电池告警追踪','安全','安全响应')").run()
  h2.db.prepare(
    `INSERT INTO work_template_version
       (id, template_id, version, required_evidence_json, validator_key, validator_params_json,
        check_policy_json, review_policy_json, misfire_policy, status, published_by, published_at)
     VALUES ('tpl-battery-alert-v1','tpl-battery-alert',1,'[]','{}','{}','{}','{}','each','published',?,?)`,
  ).run(IDS.owner, h2.clock.now)
  h2.db.prepare("UPDATE work_template SET published_version_id='tpl-battery-alert-v1' WHERE id='tpl-battery-alert'").run()
  h2.db.prepare(
    `INSERT INTO work_item (id, template_version_id, domain, category, title, owner_human_id, created_by, created_at, updated_at)
     VALUES ('w-battery', 'tpl-battery-alert-v1', '安全', '安全响应', '历史单', ?, ?, ?, ?)`,
  ).run(IDS.owner, IDS.owner, h2.clock.now, h2.clock.now)
  const file2 = writeProfile(h2.root)
  const report2 = applyWorkspaceProfile({
    db: h2.db,
    dataDir: sandboxPath(h2.root, 'profile-data'),
    operatorId: IDS.owner,
    now: h2.clock.now,
    idFactory: createIdFactory(() => h2.clock.now),
    file: file2,
    workspaceRoot: h2.root,
  })
  assert.equal(report2.created.removedTemplates, 0)
  assert.equal(h2.db.prepare("SELECT COUNT(*) AS c FROM work_template WHERE id='tpl-battery-alert'").get().c, 1)
  h2.close()
})

test('w03 画像缺文件或文档路径不存在：只报错不阻断，哈希不记以便下次重试', (t) => {
  const h = createHarness(t)
  const file = writeProfile(h.root, {
    docs: [{ path: 'profile-docs/not-exists.md', title: '不存在' }],
    overview: { title: '总览', body: '正文' },
  })
  const report = applyWorkspaceProfile({
    db: h.db,
    dataDir: sandboxPath(h.root, 'profile-data'),
    operatorId: IDS.owner,
    now: h.clock.now,
    idFactory: createIdFactory(() => h.clock.now),
    file,
    workspaceRoot: h.root,
  })
  assert.equal(report.status, 'applied')
  assert.ok(report.errors.some((error) => error.includes('文档不存在')))
  assert.ok(h.service.listProjects(h.ctx(IDS.owner)).some((row) => row.name === '画像测试项目'), '其它内容照常落库')
  const meta = h.db.prepare("SELECT value FROM hams_meta WHERE key='workspace_profile_sha256'").get() as
    | { value: string }
    | undefined
  assert.equal(meta, undefined, '有错误时不记哈希')
  h.close()
})
