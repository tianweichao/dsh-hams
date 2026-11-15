import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_FILE = fileURLToPath(new URL('../../client/index.js', import.meta.url))

interface Captured {
  id: string
  module: { name: string; inject: string[]; apply: (ctx: unknown) => void }
}

function loadClient(): { captured: Captured; window: Record<string, unknown> } {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const react = {
    createElement: (...args: unknown[]) => ({ type: args[0], props: { ...(args[1] as object || {}), children: args.length === 3 ? args[2] : args.slice(2) }, children: args.slice(2) }),
    useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}],
    useEffect: () => {},
    useRef: (value: unknown) => ({ current: value }),
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  }
  let captured: Captured | null = null
  const storage = new Map<string, string>()
  const fakeWindow: Record<string, unknown> = {
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, String(value)) },
      removeItem: (key: string) => { storage.delete(key) },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    __ModuleLoader__: {
      load: (spec: { id: string; factory: (require: (name: string) => unknown) => Captured['module'] }) => {
        captured = {
          id: spec.id,
          module: spec.factory((moduleName) => {
            if (moduleName === 'react') return react
            throw new Error(`客户端加载了未预期的包：${moduleName}`)
          }),
        }
      },
    },
  }
  // 用一个隔离的函数作用域执行模块源码；window 与 console 都注入假对象。
  const run = new Function('window', 'console', source) as (w: unknown, c: unknown) => void
  run(fakeWindow, { error: () => {}, log: () => {} })
  assert.ok(captured, '客户端模块应当调用 window.__ModuleLoader__.load')
  return { captured: captured!, window: fakeWindow }
}

test('q01 客户端模块：导出 name/inject/apply，注册左侧入口与主面板', () => {
  const { captured, window } = loadClient()
  assert.equal(captured.id, 'dsh-hams')
  assert.equal(captured.module.name, 'hams-client')
  assert.deepEqual(captured.module.inject, ['slots', 'layout'])
  assert.equal(typeof captured.module.apply, 'function')

  const registrations: { spec: Record<string, unknown>; component: unknown }[] = []
  const ctx = {
    slots: {
      inject(_name: string, callback: () => void) {
        callback()
      },
      register(spec: Record<string, unknown>, component: unknown) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    layout: {},
  }
  captured.module.apply(ctx)

  const names = registrations.map((entry) => entry.spec.name)
  // sidebar.panellist.actions 是触发宿侧重渲染的占位（More 菜单已被宿主补丁关掉）
  assert.deepEqual(names.sort(), ['main', 'main', 'main', 'sidebar.panellist', 'sidebar.panellist', 'sidebar.panellist', 'sidebar.panellist.actions'])

  const panellistIds = registrations
    .filter((entry) => entry.spec.name === 'sidebar.panellist')
    .map((entry) => entry.spec.id)
    .sort()
  assert.deepEqual(panellistIds, ['apps', 'conversations', 'hams'])

  const labels = Object.fromEntries(registrations
    .filter((entry) => entry.spec.name === 'sidebar.panellist')
    .map((entry) => [entry.spec.id, (entry.spec.label as () => string)()]))
  assert.deepEqual(labels, { conversations: '对话', hams: 'HAMS', apps: '应用' })

  const mainKeys = registrations
    .filter((entry) => entry.spec.name === 'main')
    .map((entry) => entry.spec.key)
    .sort()
  assert.deepEqual(mainKeys, ['apps', 'conversations', 'hams'])
  for (const entry of registrations) assert.equal(typeof entry.component, 'function')

  const debug = (window as { __hams?: { panel: string; components: Record<string, unknown> } }).__hams
  assert.equal(debug?.panel, 'hams')
  assert.equal(typeof debug?.components.HamsPanel, 'function')
  assert.equal(typeof debug?.components.AppsPanel, 'function')
})

test('q03 应用页：读宿主侧栏条目并按分组列出，不硬编码插件清单', () => {
  const { captured, window } = loadClient()
  const entries = [
    { options: { id: 'plugins', order: 0, label: () => '插件' } },
    { options: { id: 'schedules', order: 10, label: () => '自动化任务' } },
    { options: { id: 'hams', order: 12, label: () => '工作台' } },
    { options: { id: 'baoyu-design.artifacts', order: 20, label: () => '作品' } },
    { options: { id: 'agents-anywhere.bridge', order: 30, label: () => '药品' } },
    { options: { id: 'apps', order: 90, label: () => '应用' } },
  ]
  const footerEntries = [{ options: { id: 'agents-anywhere-next', order: 26, label: () => '远程控制' } }]
  const panelInfo = { getSnapshot: () => ({ activePanelId: 'apps' }), subscribe: () => () => {} }
  const opened: (string | null)[] = []
  const ctx = {
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: () => () => {},
      entries: (hole: string) => (hole === 'sidebar.footer.action' ? footerEntries : entries),
      subscribe: () => () => {},
    },
    layout: {
      panelInfo,
      selectPanel: (id: string | null) => opened.push(id),
      hasMainPanel: () => true,
    },
  }
  ;(window as { __hams?: { ctx?: unknown } }).__hams = { ctx }
  captured.module.apply(ctx)

  const panel = (window as { __hams: { components: { AppsPanel: () => unknown } } }).__hams.components.AppsPanel
  const text = textOf(panel())
  for (const label of ['应用', '常驻左侧', '生成', '工具', '作品', '远程控制', '工作台', '管理插件', '底部栏']) {
    assert.ok(text.includes(label), `应用页应当列出「${label}」：${text.slice(0, 200)}`)
  }
  assert.ok(!text.includes('其他入口') || text.includes('插件'), '未分组条目落在「其他入口」')
})

/** 把假的 React 元素树拍平成文本，用来断言渲染内容。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  // 复合组件：假 React 不做渲染调度，这里直接把函数组件当纯函数展开。
  if (typeof element.type === 'function') return textOf((element.type as (props: Record<string, unknown>) => unknown)(element.props || {}))
  return textOf(element.children)
}

test('q02 客户端不依赖打包器：只用 require("react")，模块加载阶段不发请求', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual([...new Set(required)], ['react'])
  // 没有 JSX、没有 import 语句：文件可直接被宿主 loader 执行
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /<\/[A-Za-z]/)
})

test('q04 三屏接真实数据：项目/成员/知识分别渲染后端返回的行，不再有占位文案', () => {
  const { captured, window } = loadClient()
  const ctx = { slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} }
  ;(window as { __hams?: { ctx?: unknown } }).__hams = { ctx }
  captured.module.apply(ctx)
  const components = (window as { __hams: { components: Record<string, (props: Record<string, unknown>) => unknown> } })
    .__hams.components
  const noop = () => {}
  const projectDetail = {
    id: 'p1', name: '示例投研项目', type: 'continuous', status: 'active',
    owner_human_id: 'h1', owner_name: '王（负责人）', coordinator_id: 'b1', coordinator_name: '运营协调',
    goal_text: '把数据→因子→回测→agent 自主运行做成可复现链路', current_target_version: 1, revision: 1, created_at: 0, updated_at: 0,
    work_items: { total: 2, open: 1, byStatus: { active: 1, completed: 1 } },
    metric_count: 1, observation_count: 1,
    target_versions: [{ id: 'pv1', version: 1, goal_text: '把数据→因子→回测→agent 自主运行做成可复现链路', published_by: 'h1', published_by_name: '王', published_at: 0 }],
    current_target: { id: 'pv1', version: 1, goal_text: '把数据→因子→回测→agent 自主运行做成可复现链路', published_at: 0 },
    metrics: [{
      id: 'm1', name: '已入库因子', direction: 'higher', target_value: 300, target_max: null, unit: '个',
      definition_text: '', calculator_key: null, window_kind: 'week', source_kind: 'manual',
      latest: { value: 285, observed_at: 0, window_start: 0, window_end: 0, source_ref: null },
      series: [{ value: 285, window_end: 0 }],
    }],
    budgets: [{ period_kind: 'day', period_start: '2026-11-14', metric: 'new_tasks', used: 0, limit_value: 3 }],
    recent_items: [{ id: 'w1', title: 'Phase 8：Task Worktree 隔离', status: 'active', owner_human_id: 'h1', assignee_id: null, due_at: null, updated_at: 0 }],
    allowedActions: ['createWorkItem', 'pause', 'archive'],
  }
  const projectText = textOf(components.ProjectScreen({
    projects: [{ ...projectDetail }], detail: projectDetail, busy: false, formOpen: false, bots: [], initialTab: 'goals',
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
  }))
  // 打开详情后是独立整页：只显示详情与返回入口，不再把列表挤在同一屏
  for (const label of ['示例投研项目', '已入库因子', '最新 285个', '目标 300个', '目标与阶段', '阶段', '工作项', '交付物', '复盘历史', '返回项目列表']) {
    assert.ok(projectText.includes(label), `项目屏应显示「${label}」：${projectText.slice(0, 300)}`)
  }
  // 未选中项目时是列表页，新建入口与项目名都在
  const projectListText = textOf(components.ProjectScreen({
    projects: [{ ...projectDetail }], detail: null, busy: false, formOpen: false, bots: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
  }))
  for (const label of ['新建项目', '示例投研项目']) {
    assert.ok(projectListText.includes(label), `项目列表页应显示「${label}」：${projectListText.slice(0, 300)}`)
  }
  assert.ok(!projectListText.includes('返回项目列表'), '列表页不应出现返回入口')

  const member = {
    id: 'b1', kind: 'bot', name: '研究执行 agent', domain: null, responsibility: '因子挖掘与回测', role: 'executor',
    status: 'active', current_version: 1, owner_human_id: 'h1', owner_name: '王', created_at: 0, updated_at: 0,
    positions: [{ id: 'pos1', name: '投资研究岗' }], capabilities: ['evidence.append', 'work_item.claim'],
    work: { total: 3, open: 2, byStatus: { active: 2, completed: 1 } }, runs: { total: 1, last_at: 0 },
    position_history: [], permissions: [{ capability: 'evidence.append', scope: 'global', granted_by: 'h1', granted_at: 0 }],
    recent_work: [{ id: 'w1', title: 'Phase 8：Task Worktree 隔离', status: 'active', project_id: 'p1', owner_human_id: 'h1', assignee_id: 'b1', due_at: null, updated_at: 0 }],
    recent_runs: [{ id: 'r1', work_item_id: 'w1', status: 'running', trigger: 'claim', started_at: 0, finished_at: null, created_at: 0 }],
    bot_versions: [{ id: 'mv1', version: 1, model: 'deepseek-chat', agent_preset: 'reader', change_class: 'major', published_by: 'h1', published_at: 0 }],
    login: null, allowedActions: ['pause', 'retire'],
  }
  const memberProps = {
    members: [member], positions: [{ id: 'pos1', name: '投资研究岗', domain: '投资', description: '', status: 'active', capabilities: [], holders: 1 }],
    busy: false, formOpen: false, filter: 'all', onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop,
  }
  // 成员详情同样是独立整页：只显示详情 + 返回入口
  const memberText = textOf(components.MemberScreen({ ...memberProps, detail: member, initialTab: 'config' }))
  for (const label of ['研究执行 agent', '未结工作', '配置 · 当前 v1', '版本历史', '最近 12 周活动', '返回成员列表']) {
    assert.ok(memberText.includes(label), `成员屏应显示「${label}」：${memberText.slice(0, 300)}`)
  }
  assert.ok(!memberText.includes('新建成员'), '成员详情页不应再出现列表的新建入口')
  // 未选中成员时回到列表页
  const memberListText = textOf(components.MemberScreen({ ...memberProps, detail: null }))
  for (const label of ['新建成员', '研究执行 agent']) {
    assert.ok(memberListText.includes(label), `成员列表页应显示「${label}」：${memberListText.slice(0, 300)}`)
  }
  assert.ok(!memberListText.includes('返回成员列表'), '成员列表页不应出现返回入口')

  const doc = {
    kind: 'doc', id: 'd1', title: '过放处置规程', subtitle: 'HAMS 内撰写', status: 'draft', source_kind: 'hams',
    revision: 1, bytes: 20, updated_at: 0, owner_id: 'h1', owner_name: '王', path: '/tmp/d1.md',
    present: true, changed: false, content: '正文内容', truncated: false, file_bytes: 20, allowedActions: ['edit', 'publish'],
  }
  const knowledgeText = textOf(components.KnowledgeScreen({
    data: { items: [doc], counts: { docs: 1, skills: 0, tables: 0 }, sources: { skill_dirs: ['/tmp/skills'], docs_dir: '/tmp/docs' } },
    detail: doc, busy: false, form: null, report: null, importReport: null,
    onForm: noop, onOpen: noop, onSync: noop, onCreateDoc: noop, onImport: noop, onPublish: noop, onEdit: noop,
    editing: false, onCancelEdit: noop,
  }))
  for (const label of ['过放处置规程', '正文内容', '发布', '编辑正文', '放大', '同步真实数据']) {
    assert.ok(knowledgeText.includes(label), `知识屏应显示「${label}」：${knowledgeText.slice(0, 300)}`)
  }
  assert.ok(!projectText.includes('这一屏的数据接口还没接'), '占位文案必须删掉')
  assert.ok(!knowledgeText.includes('技能来源'), '知识屏不再显示来源路径这类说明文字')
  assert.ok(!knowledgeText.includes('文档是本机文件'), '知识屏不再显示数据表/技能的说明文字')
})

test('q08 任务详情独立成整页：选中后只显示详情与返回入口，未选中回到列表', () => {
  const { captured, window } = loadClient()
  const ctx = { slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} }
  ;(window as { __hams?: { ctx?: unknown } }).__hams = { ctx }
  captured.module.apply(ctx)
  const components = (window as { __hams: { components: Record<string, (props: Record<string, unknown>) => unknown> } })
    .__hams.components
  const noop = () => {}
  const item = {
    id: 'w1', title: 'BT-20871 过放追踪单', status: 'active', domain: '安全', priority: 2,
    owner_human_id: 'h1', owner_name: '王', assignee_id: null, revision: 2, execution_epoch: 1,
    next_action_at: 0, due_at: 0, updated_at: 0, allowedActions: [], events: [], evidence: [], checks: [],
    templateVersion: {}, template_version_id: null, blocked_reason: null, evidence_set_hash: null,
  }
  const base = {
    items: [item], onSelect: noop, onAct: noop, busy: false, onCreate: noop, canAct: true,
    evidenceForm: null, actionForm: null, templates: [], projects: [], members: [], checks: [], me: 'h1',
    onClose: noop,
  }
  const detailText = textOf(components.ItemsTab({ ...base, selected: item }))
  for (const label of ['BT-20871 过放追踪单', '返回任务列表', '关单判据']) {
    assert.ok(detailText.includes(label), `任务详情页应显示「${label}」：${detailText.slice(0, 300)}`)
  }
  assert.ok(!detailText.includes('新建工作项'), '详情页不应再出现列表的新建入口')
  const listText = textOf(components.ItemsTab({ ...base, selected: null }))
  assert.ok(listText.includes('新建工作项'), `任务列表页应显示「新建工作项」：${listText.slice(0, 300)}`)
  assert.ok(!listText.includes('返回任务列表'), '列表页不应出现返回入口')
})

test('q09 新建项目/任务/成员都独立成页：只显示表单与返回入口，取消回到列表', () => {
  const { captured, window } = loadClient()
  const ctx = { slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} }
  ;(window as { __hams?: { ctx?: unknown } }).__hams = { ctx }
  captured.module.apply(ctx)
  const components = (window as { __hams: { components: Record<string, (props: Record<string, unknown>) => unknown> } })
    .__hams.components
  const noop = () => {}

  const projectText = textOf(components.ProjectScreen({
    projects: [], detail: null, busy: false, formOpen: true, bots: [], humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
  }))
  assert.ok(projectText.includes('返回项目列表'), `新建项目应是整页：${projectText.slice(0, 200)}`)
  assert.ok(projectText.includes('新建项目'), '新建项目页应保留标题')
  assert.ok(!projectText.includes('全部类型'), '新建页不应出现列表筛选')

  const memberText = textOf(components.MemberScreen({
    members: [], detail: null, positions: [], busy: false, formOpen: true, filter: 'all',
    onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop,
  }))
  assert.ok(memberText.includes('返回成员列表'), `新建成员应是整页：${memberText.slice(0, 200)}`)
  assert.ok(memberText.includes('新建成员'))
  assert.ok(!memberText.includes('搜索成员'), '新建成员页不应出现列表搜索')

  const taskText = textOf(components.ItemsTab({
    items: [], selected: null, onSelect: noop, onAct: noop, busy: false, onCreate: noop, canAct: true,
    canCreate: true, templates: [], projects: [], members: [], checks: [], me: 'h1',
    createOpen: true, onCreateOpen: noop, onCreateCancel: noop,
  }))
  assert.ok(taskText.includes('返回任务列表'), `新建工作项应是整页：${taskText.slice(0, 200)}`)
  assert.ok(!taskText.includes('全部状态'), '新建工作项页不应出现列表筛选')
})

test('q10 文档预览走 Markdown 渲染：标题/强调/代码块/列表/链接都出结构', () => {
  const { renderMarkdown } = clientHelpers()
  const nodes = renderMarkdown('# 过放处置\n\n**必须**先断电，再执行 `reset`。\n\n- 第一步\n- 第二步\n\n```bash\nreset --hard\n```\n\n见 [规程](https://example.com/a.md)。', 'k')
  const types = nodes.map((node: any) => (typeof node.type === 'function' ? 'fn' : node.type))
  assert.ok(types.includes('pre'), '代码块应渲染成 pre')
  assert.ok(types.includes('ul'), '无序列表应渲染成 ul')
  const flat = textOf(nodes)
  for (const label of ['过放处置', '必须', 'reset', '第一步', '第二步', '规程']) {
    assert.ok(flat.includes(label), `Markdown 渲染应保留「${label}」：${flat.slice(0, 200)}`)
  }
  assert.ok(JSON.stringify(nodes).includes('https://example.com/a.md'), '链接应保留 href')
})
test('q11 应用页固定/取消固定：写进宿主白名单 window.__hamsRows，刷新后仍生效', () => {
  const { captured, window } = loadClient()
  captured.module.apply({ slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} })
  const { readPinnedApps, writePinnedApps, syncSidebarRows } = (window as any).__hams.helpers
  const rows = () => (window as any).__hamsRows
  // 默认只有四行常驻，其余入口不出现在左侧栏
  writePinnedApps([])
  assert.deepEqual(syncSidebarRows(), [])
  assert.deepEqual(rows(), ['conversations', 'schedules', 'hams', 'apps'])
  // 固定一个第三方入口后，白名单里多出它
  writePinnedApps(['plugins'])
  assert.deepEqual(syncSidebarRows(), ['plugins'])
  assert.ok(rows().includes('plugins'), '固定的入口必须进白名单')
  // 常驻行不会被当成普通固定项重复追加
  writePinnedApps(['hams', 'plugins'])
  assert.deepEqual(readPinnedApps(), ['plugins'])
  assert.deepEqual(rows(), ['conversations', 'schedules', 'hams', 'apps', 'plugins'])
  // 取消固定 = 从白名单移走
  writePinnedApps([])
  syncSidebarRows()
  assert.ok(!rows().includes('plugins'))
})

function clientHelpers(): Record<string, (...args: any[]) => any> {
  const { captured, window } = loadClient()
  captured.module.apply({ slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} })
  return (window as any).__hams.helpers
}

test('q05 暂停卡按resume_state留原列；筛选只保留真实符合条件工作项，待复查优先', () => {
  const { boardColumn, taskFilter } = clientHelpers()
  for (const status of ['ready', 'active', 'waiting_check', 'waiting_review', 'blocked']) {
    assert.equal(boardColumn({status:'paused',resume_state:status}), status)
  }
  const rows = [
    { id:'w1', title:'温度告警', status:'active', domain:'安全', project_id:'p1', owner_human_id:'h1', priority:1 },
    { id:'w2', title:'温度复查', status:'waiting_check', domain:'安全', project_id:'p1', owner_human_id:'h1', priority:5 },
    { id:'w3', title:'温度复查', status:'waiting_check', domain:'安全', project_id:'p2', owner_human_id:'h2', priority:1 },
  ]
  assert.deepEqual(taskFilter(rows,{q:'温度',project:'p1',mine:true,me:'h1'}).map((r:any)=>r.id), ['w2','w1'])
  assert.deepEqual(taskFilter(rows,{status:'blocked'}), [])
  assert.equal(rows[0].id, 'w1', '筛选不得改变原列表顺序')
})

test('q06 指标按方向与区间判定，缺数或口径不完整始终未知', () => {
  const { metricVerdict } = clientHelpers()
  const metric={latest:{value:85},target_value:90,target_max:95,calculator_key:'manual',source_kind:'manual',direction:'higher'}
  assert.equal(metricVerdict(metric), 'miss')
  assert.equal(metricVerdict({...metric,direction:'lower'}), 'met')
  assert.equal(metricVerdict({...metric,direction:'range',latest:{value:96}}), 'miss')
  assert.equal(metricVerdict({...metric,direction:'range',latest:{value:92}}), 'met')
  assert.equal(metricVerdict({...metric,latest:{value:null}}), 'unknown')
  assert.equal(metricVerdict({...metric,calculator_key:null}), 'unknown')
  assert.equal(metricVerdict({...metric,direction:'range',target_max:null}), 'unknown')
})

test('q07 审批有效性必须同时绑定材料、判据、修订、执行代次和有效期', () => {
  const { approvalValidity } = clientHelpers()
  const approval={status:'pending',expires_at:2000,subject_revision:3,execution_epoch:2,evidence_set_hash:'h1',criteria_ref:'tv1'}
  const item={status:'waiting_review',revision:3,execution_epoch:2,evidence_set_hash:'h1',template_version_id:'tv1'}
  assert.equal(approvalValidity(approval,item,1000), null)
  assert.match(approvalValidity(approval,item,2000), /过期/)
  assert.match(approvalValidity(approval,{...item,evidence_set_hash:'h2'},1000), /证据有变化/)
  assert.match(approvalValidity(approval,{...item,revision:4},1000), /修订号/)
  assert.match(approvalValidity(approval,{...item,execution_epoch:3},1000), /代次/)
  assert.match(approvalValidity(approval,{...item,template_version_id:'tv2'},1000), /判据/)
  assert.match(approvalValidity({...approval,status:'invalidated',invalidated_reason:'evidence_changed'},item,1000), /evidence_changed/)
})

/** 在假元素树里按条件收集节点（布局断言用）。 */
function collect(node: unknown, hit: (el: { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }) => boolean, out: { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }[] = []) {
  if (node === null || node === undefined || node === false || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((entry) => collect(entry, hit, out)); return out }
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  if (typeof element.type === 'function') { collect((element.type as (props: Record<string, unknown>) => unknown)(element.props || {}), hit, out); return out }
  if (hit(element)) out.push(element)
  ;(element.children || []).forEach((entry) => collect(entry, hit, out))
  return out
}

function renderScreen(name: string, props: Record<string, unknown>): unknown {
  const { captured, window } = loadClient()
  const ctx = { slots: { inject: (_n: string, cb: () => void) => cb(), register: () => () => {}, entries: () => [] }, layout: {} }
  ;(window as { __hams?: { ctx?: unknown } }).__hams = { ctx }
  captured.module.apply(ctx)
  const components = (window as { __hams: { components: Record<string, (p: Record<string, unknown>) => unknown> } }).__hams.components
  return components[name](props)
}

test('q12 界面布局：知识两栏固定右置、任务单行列对齐、成员卡两行跨头像、任务操作在标题行', () => {
  const noop = () => {}
  const doc = (id: string, title: string, body: string) => ({
    id, kind: 'doc', title, name: title, subtitle: 'v1', revision: 1, status: 'published', bytes: body.length,
    owner_name: '本机操作者', updated_at: 0, path: `/tmp/${id}.md`, content: body, changed: false, truncated: false, allowedActions: ['edit'],
  })
  const docs = [doc('d1', '索引', '# 索引'), doc('d2', '很宽的文档', '| 列 | 说明 |\n| --- | --- |\n| 很长的一列 | 很长的内容 |')]
  const kb = renderScreen('KnowledgeScreen', {
    data: { items: docs, counts: { docs: 2, skills: 0, tables: 0 }, sources: { skill_dirs: [], docs_dir: '/tmp' } },
    detail: docs[1], busy: false, form: null, report: null, importReport: null, onForm: noop, onOpen: noop, onSync: noop,
    onCreateDoc: noop, onImport: noop, onPublish: noop, onEdit: noop, editing: false, onCancelEdit: noop, capabilities: [],
  })
  // 列表与详情挂在固定两栏 grid 里：任一文档的宽内容都不能把详情挤到列表下面。
  const kbWrap = collect(kb, (el) => el.props?.key === 'l')[0]
  assert.equal((kbWrap.props?.style as Record<string, unknown>).display, 'grid')
  assert.match(String((kbWrap.props?.style as Record<string, unknown>).gridTemplateColumns), /minmax\(0,1\.45fr\)/)
  const kbDetail = collect(kb, (el) => el.props?.style && (el.props.style as Record<string, unknown>).minWidth === 0 && (el.props.style as Record<string, unknown>).overflow === 'hidden')
  assert.ok(kbDetail.length >= 1, '详情卡要 minWidth:0 + overflow:hidden，才不会被内容最小宽度撑开')

  const members = [
    { id: 'h1', kind: 'human', name: '本机操作者', domain: null, responsibility: '协调', role: 'coordinator', status: 'active', current_version: 0, positions: [], work: { total: 3, open: 2 }, runs: { total: 0, last_at: null } },
    { id: 'b1', kind: 'bot', name: '数据巡检 agent', domain: '投资', responsibility: '采集与质检', role: 'executor', status: 'active', current_version: 1, positions: [], work: { total: 0, open: 0 }, runs: { total: 0, last_at: null } },
  ]
  const memberTree = renderScreen('MemberScreen', { members, detail: null, positions: [], busy: false, formOpen: false, filter: 'all', onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, allowedActions: ['create'] })
  const toolbar = collect(memberTree, (el) => el.props?.key === 'bar')[0]
  assert.equal((toolbar.props?.style as Record<string, unknown>).display, 'flex')
  assert.equal((toolbar.props?.style as Record<string, unknown>).alignItems, 'center')
  const toolbarKids = [].concat(...((toolbar.children as unknown[]) || [])) as { type?: unknown }[]
  assert.equal(toolbarKids[0]?.type, 'input', '搜索框与分类按钮同一行，搜索框在最前')
  const cards = collect(memberTree, (el) => el.type === 'article')
  assert.equal(cards.length, 2)
  assert.match(String((cards[0].props?.style as Record<string, unknown>).gridTemplateColumns), /^44px /)
  assert.equal(collect(cards[0], (el) => (el.props?.style as Record<string, unknown>)?.gridRow === '1 / span 2').length, 1, '头像纵向跨两行')

  const tasks = [{ id: 'w1', title: '处理 00-inbox', status: 'ready', domain: '知识', assignee_id: 'h1', owner_human_id: 'h1', priority: 3, due_at: 1763200000000, next_action_at: null }]
  const itemsTree = renderScreen('ItemsTab', { items: tasks, selected: null, onSelect: noop, onAct: noop, busy: false, onCreate: noop, canAct: true, evidenceForm: null, actionForm: null, templates: [], onCreateOpen: noop, createOpen: false, onCreateCancel: noop, projects: [], members, projectFilter: '', onProjectFilter: noop, checks: [], me: 'h1', onClose: noop, onCheck: noop })
  const rows = collect(itemsTree, (el) => el.type === 'button' && String((el.props?.style as Record<string, unknown>)?.gridTemplateColumns || '').startsWith('84px'))
  assert.equal(rows.length, 1, '列表视图一行一条')
  assert.equal(collect(itemsTree, (el) => el.props?.key === 'list-head').length, 1, '表头与行同列宽')
  assert.match(String((rows[0].props?.style as Record<string, unknown>).gridTemplateColumns), /^84px minmax\(0,1fr\) minmax\(140px,168px\) 56px minmax\(112px,132px\)$/)

  const detail = {
    id: 'w1', title: '处理 00-inbox 本周 4 篇笔记：归位或归档，清空缓冲', status: 'ready', priority: 3, revision: 1, execution_epoch: 1,
    templateVersion: { required_evidence_json: '[]' }, events: [], evidence: [], checks: [], approvals: [], runs: [],
    domain: '知识', owner_name: '本机操作者', allowedActions: ['accept', 'addEvidence', 'reportBlocker', 'cancel', 'pause'],
  }
  const detailTree = renderScreen('TaskDetail', { selected: detail, onClose: noop, onAct: noop, busy: false, canAct: true, evidenceForm: null, actionForm: null, onCheck: noop })
  const head = collect(detailTree, (el) => el.props?.key === 'head')[0]
  assert.equal((head.props?.style as Record<string, unknown>).display, 'flex')
  const headButtons = collect(head, (el) => el.type === 'button').map((el) => (el.children as string[]).join(''))
  for (const label of ['接单', '加证据', '报阻塞', '取消', '暂停']) assert.ok(headButtons.includes(label), `标题行应当有「${label}」`)
  const topLevel = collect(detailTree, (el) => el.props?.key === 'actions')
  assert.equal(topLevel.length, 0, '页尾不再重复放一排操作')
})

test('q13 智能体详情：指标与热力图同一区块、热力图格子变小、配置默认只读且有「编辑」', () => {
  const noop = () => {}
  const days = Array.from({ length: 84 }, (_, i) => ({ day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, count: i % 3 }))
  const member = {
    id: 'b1', kind: 'bot', name: '知识整理 agent', domain: '知识', responsibility: '文档 ingest',
    role: 'executor', status: 'active', current_version: 2, positions: [], capabilities: [], work: { total: 4, open: 1 },
    runs: { total: 6, last_at: 0 }, activity: { from: days[0].day, to: days[83].day, timeZone: 'Asia/Shanghai', days },
    config: { model: 'deepseek-chat', agent_preset: 'reader', memory_scope: {}, prompt: '' },
    bot_versions: [], position_history: [], permissions: [], recent_work: [], recent_runs: [], allowedActions: ['pause', 'publishConfig'],
  }
  const tree = renderScreen('MemberScreen', { members: [member], detail: member, positions: [], busy: false, formOpen: false, filter: 'all', onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onCommand: noop, initialTab: 'config' })
  // 指标 + 热力图同一个 card：两列 grid，左边 150–200px，右边自适应
  const pulse = collect(tree, (el) => el.props?.key === 'pulse')[0]
  assert.equal((pulse.props?.style as Record<string, unknown>).display, 'grid')
  assert.match(String((pulse.props?.style as Record<string, unknown>).gridTemplateColumns), /^minmax\(0,1fr\) minmax\(200px,25%\)$/, '热力图只占 1/4 宽')
  const stats = collect(pulse, (el) => el.props?.key === 'stats')[0]
  assert.match(String((stats.props?.style as Record<string, unknown>).gridTemplateColumns), /^repeat\(3,minmax\(0,1fr\)\)$/, '三个指标横排')
  assert.equal(collect(pulse, (el) => String((el.props?.style as Record<string, unknown>)?.gridTemplateRows || '') === 'repeat(7,13px)').length, 1, '热力图格子固定 13px')
  const intro = collect(pulse, (el) => el.props?.key === 'intro')[0]
  assert.equal((intro.props?.style as Record<string, unknown>).gridColumn, '1 / -1', '简介在区块最下面整行')
  const header = collect(tree, (el) => el.props?.key === 'h')[0]
  const headerButtons = collect(header, (el) => el.type === 'button').map((el) => (el.children as string[]).join(''))
  assert.ok(headerButtons.includes('暂停分派'), '状态操作与名称同一行')
  // 配置默认只读：输入/文本域全部 disabled，页面上只有「编辑」一个入口
  const configInputs = collect(tree, (el) => (el.type === 'input' || el.type === 'textarea') && ['职责', '提示词（这个 bot 的人设；会注入它的会话）', '模型', 'Agent preset', '记忆范围（JSON 对象）'].includes(String((el.props as Record<string, unknown>)?.['aria-label'])))
  assert.equal(configInputs.length, 5, '职责、提示词、模型、preset、记忆范围五项都可编辑')
  for (const input of configInputs) assert.equal((input.props as Record<string, unknown>).disabled, true, '未点编辑前配置项只读')
  const buttons = collect(tree, (el) => el.type === 'button').map((el) => (el.children as string[]).join(''))
  assert.ok(buttons.includes('编辑'), '配置卡要有「编辑」按钮')
  assert.ok(!buttons.includes('保存并发布新版本'), '只读状态下不出现保存按钮')
})

test('q14 项目详情：目标/指标/阶段合成「目标与阶段」一个页签', () => {
  const noop = () => {}
  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成可复现链路', current_target_version: 2,
    current_target: { version: 2, goal_text: '做成可复现链路', published_at: 0 },
    target_versions: [{ id: 'v2', version: 2, goal_text: '做成可复现链路', published_at: 0, metrics: [] }],
    metrics: [], phases: [], reviews: [], progress_records: {}, work_items: [], budgets: [], allowedActions: [],
  }
  const tree = renderScreen('ProjectScreen', { projects: [project], detail: project, busy: false, formOpen: false, bots: [], humans: [], onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop, onCommand: noop, allowedActions: [] })
  const tabs = collect(tree, (el) => el.type === 'button' && el.props?.role === 'tab').map((el) => (el.children as string[]).join(''))
  assert.deepEqual(tabs, ['群聊', '团队', '目标与阶段', '工作项', '记忆', '交付物', '复盘历史'])
  assert.ok(!textOf(tree).includes('目标版本历史'), '版本历史折叠块不再常驻')
  const goalsTree = renderScreen('ProjectScreen', { projects: [project], detail: project, busy: false, formOpen: false, bots: [], humans: [], onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop, onCommand: noop, allowedActions: [], initialTab: 'goals' })
  const goalsText = textOf(goalsTree)
  for (const label of ['项目目标', '编辑', '查看立项项目书', '版本历史（1）', '阶段', '新增阶段']) assert.ok(goalsText.includes(label), `目标与阶段页签应显示「${label}」`)
  assert.ok(goalsText.includes('还没有目标'), '没有目标时提示去编辑口径')
  assert.ok(goalsText.includes('自动补一个默认阶段'), '没有阶段时给出下一步提示')
})

test('q15 智能体工作记录：一行一条，状态/名称/更新时间/下一步/截止五列对齐', () => {
  const noop = () => {}
  const human = {
    id: 'h1', kind: 'human', name: '本机操作者', domain: null, responsibility: '协调全部业务域', role: 'coordinator',
    status: 'active', current_version: 0, positions: [], capabilities: [], work: { total: 5, open: 2 }, runs: { total: 3, last_at: 0 },
    activity: { days: [] }, position_history: [], permissions: [], allowedActions: [],
    login: null,
    recent_work: [
      { id: 'w1', title: '处理 00-inbox 本周 4 篇笔记', status: 'ready', project_id: null, owner_human_id: 'h1', assignee_id: 'h1', due_at: 1763755200000, next_action_at: 1763300000000, updated_at: 1763200000000 },
      { id: 'w2', title: '核对融资监控口径', status: 'waiting_check', project_id: null, owner_human_id: 'h1', assignee_id: null, due_at: null, next_action_at: null, updated_at: 1763100000000 },
    ],
    recent_runs: [],
  }
  const tree = renderScreen('MemberScreen', { members: [human], detail: human, positions: [], busy: false, formOpen: false, filter: 'all', onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onCommand: noop, initialTab: 'config' })
  const text = textOf(tree)
  for (const label of ['状态', '任务名称', '更新时间', '下一步工作', '截止时间', '处理 00-inbox 本周 4 篇笔记']) {
    assert.ok(text.includes(label), `工作记录应有「${label}」：${text.slice(0, 300)}`)
  }
  const rows = collect(tree, (el) => String((el.props?.style as Record<string, unknown>)?.gridTemplateColumns || '') === '84px minmax(0,1fr) 116px 116px 108px')
  assert.ok(rows.length >= 3, '表头 + 两条工作记录共用同一组列宽')
})

test('q16 知识库：路径只出现一次；空分类不再留空块', () => {
  const noop = () => {}
  const path = '/tmp/hams-demo/INDEX.md'
  const doc = { id: 'd1', kind: 'doc', title: '示例工作空间索引', name: '示例工作空间索引', subtitle: path, revision: 1, status: 'published', bytes: 10, owner_name: '本机操作者', owner_id: 'h1', updated_at: 0, path, content: '# 索引', changed: false, truncated: false, allowedActions: ['edit'] }
  const props = { busy: false, form: null, report: null, importReport: null, onForm: noop, onOpen: noop, onSync: noop, onCreateDoc: noop, onImport: noop, onPublish: noop, onEdit: noop, editing: false, onCancelEdit: noop, capabilities: [] }
  const tree = renderScreen('KnowledgeScreen', { ...props, detail: doc, data: { items: [doc], counts: { docs: 1, skills: 0, tables: 0 }, sources: { skill_dirs: [], docs_dir: '' } } })
  const text = textOf(tree)
  assert.equal(text.split(path).length - 1, 1, '源文件路径只显示一次（subtitle 与 path 相同时去重）')

  const empty = renderScreen('KnowledgeScreen', { ...props, detail: null, data: { items: [], counts: { docs: 0, skills: 0, tables: 0 }, sources: { skill_dirs: [], docs_dir: '' } } })
  const emptyText = textOf(empty)
  assert.ok(!emptyText.includes('暂无条目'), '空分类不留空块')
  assert.ok(!emptyText.includes('左侧选一项看详情'), '空分类也不渲染占位详情卡')
})

test('q17 对话入口：智能体默认单聊、项目默认群聊；任务可指派给 bot', () => {
  const noop = () => {}
  const bot = {
    id: 'b1', kind: 'bot', name: '研究执行 agent', domain: '投资', responsibility: '因子挖掘', role: 'executor',
    status: 'active', current_version: 1, positions: [], capabilities: [], work: { total: 1, open: 0 }, runs: { total: 0, last_at: null },
    activity: { days: [] }, config: { model: 'deepseek-chat', agent_preset: 'hams-bot', memory_scope: {} }, bot_versions: [],
    position_history: [], permissions: [], recent_work: [], recent_runs: [], login: null, allowedActions: [],
  }
  const memberTree = renderScreen('MemberScreen', {
    members: [bot], detail: bot, positions: [], busy: false, formOpen: false, filter: 'all', onFilter: noop,
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onCommand: noop,
  })
  const memberText = textOf(memberTree)
  assert.ok(memberText.includes('单聊'), '智能体详情默认打开单聊')
  assert.ok(memberText.includes('对话'), '页签里有对话')

  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成链路', current_target_version: 1, current_target: null, target_versions: [], metrics: [], phases: [],
    reviews: [], progress_records: {}, work_items: [], budgets: [], allowedActions: [],
  }
  const projectText = textOf(renderScreen('ProjectScreen', {
    projects: [project], detail: project, busy: false, formOpen: false, bots: [], humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop, onCommand: noop, allowedActions: [],
  }))
  assert.ok(projectText.includes('项目群聊'), '项目详情默认打开群聊')

  const task = {
    id: 'w1', title: '处理 00-inbox', status: 'ready', priority: 3, revision: 1, execution_epoch: 1,
    templateVersion: { required_evidence_json: '[]' }, events: [], evidence: [], checks: [], approvals: [], runs: [],
    domain: '知识', owner_name: '本机操作者', allowedActions: ['accept'],
  }
  const taskText = textOf(renderScreen('TaskDetail', { selected: task, onClose: noop, onAct: noop, busy: false, canAct: true, evidenceForm: null, actionForm: null, onCheck: noop, members: [bot] }))
  assert.ok(taskText.includes('指派给'), '待处理任务可以指派给 bot')
  assert.ok(taskText.includes('指派并开跑'))
  assert.ok(!textOf(renderScreen('TaskDetail', { selected: { ...task, status: 'active' }, onClose: noop, onAct: noop, busy: false, canAct: true, evidenceForm: null, actionForm: null, onCheck: noop, members: [bot] })).includes('指派给'), '只有待处理的任务能指派')
})

test('q18 项目「团队」页签：推进 bot、成员、拉人入群、创建临时 bot', () => {
  const noop = () => {}
  const bot = { id: 'b1', kind: 'bot', name: '研究执行 agent', status: 'active', domain: '投资', responsibility: '', role: 'executor', current_version: 1 }
  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成链路', current_target_version: 1, current_target: null, target_versions: [], metrics: [], phases: [],
    reviews: [], progress_records: {}, work_items: [], budgets: [], allowedActions: [],
  }
  const tree = renderScreen('ProjectScreen', {
    projects: [project], detail: project, busy: false, formOpen: false, bots: [bot], humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop, onCommand: noop,
    allowedActions: [], initialTab: 'team',
  })
  const text = textOf(tree)
  for (const expected of ['团队', '推进 bot 指挥', '这个项目还没有推进 bot', '+ 成员', '成员', '职责', '状态', '操作']) {
    assert.ok(text.includes(expected), `团队页签应显示「${expected}」`)
  }
  assert.ok(text.includes('子代理'), '要说明 bot 起的子代理会自动登记进团队')
})

test('q18b 团队「查看」：onOpenMember 从 ProjectScreen 一路传到团队行，按钮不能空转', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  // 组件是函数，假 React 会直接展开，没法在元素树上断言 props；这里盯住三处传参和按钮绑定。
  assert.match(source, /h\(PMProjectDetail,\s*\{[^}]*onOpenMember/, 'ProjectScreen 渲染项目详情时要带 onOpenMember')
  assert.match(source, /h\(PMTeamTab,\s*\{[^}]*onOpenMember/, '项目详情渲染团队页时要带 onOpenMember')
  assert.match(source, /function PMTeamTab\(\{[^}]*onOpenMember/, '团队页要接收 onOpenMember')
  assert.match(source, /key: 'view'[^}]*openMember\(member\)/, '「查看」按钮必须调用 openMember')
  assert.match(source, /onOpenMember\(member\.memberId, 'config'\)/, '查看要直接落到配置页')
})

test('q19 项目群聊面板：多人发言、@ 标注与群成员信息', () => {
  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成链路', current_target_version: 1, current_target: null, target_versions: [], metrics: [], phases: [],
    reviews: [], progress_records: {}, work_items: [], budgets: [], allowedActions: [],
  }
  const tree = renderScreen('ProjectScreen', {
    projects: [project], detail: project, busy: false, formOpen: false, bots: [], humans: [],
    onCreate: () => {}, onOpen: () => {}, onFormOpen: () => {}, onStatus: () => {}, onRecord: () => {}, onGotoTasks: () => {},
    onCommand: () => {}, allowedActions: [], initialTab: 'chat',
  })
  const text = textOf(tree)
  assert.ok(text.includes('项目群聊'))
  assert.ok(!text.includes('不 @ 时'), '群聊不再放说明文字')
  assert.ok(!text.includes('回车发送'), '输入说明不再常驻')
})

test('q20 项目「交付物」页签：列出文件、提示来源，可刷新', () => {
  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成链路', current_target_version: 1, current_target: null, target_versions: [], metrics: [], phases: [],
    reviews: [], progress_records: {}, work_items: [], budgets: [], allowedActions: [],
  }
  const tree = renderScreen('ProjectScreen', {
    projects: [project], detail: project, busy: false, formOpen: false, bots: [], humans: [],
    onCreate: () => {}, onOpen: () => {}, onFormOpen: () => {}, onStatus: () => {}, onRecord: () => {}, onGotoTasks: () => {},
    onCommand: () => {}, allowedActions: [], initialTab: 'deliverables',
  })
  const text = textOf(tree)
  assert.ok(text.includes('交付物'))
  assert.ok(text.includes('刷新'))
  assert.ok(text.includes('加载中') || text.includes('还没有交付物'), '首屏给出加载或空状态说明')
})

/** 在假 React 元素树里按条件找节点（复合组件按纯函数展开）。 */
function findElement(node: unknown, match: (element: { type?: unknown; props: Record<string, unknown> }) => boolean): { type?: unknown; props: Record<string, unknown> } | null {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  if (typeof element.type === 'function') return findElement((element.type as (props: Record<string, unknown>) => unknown)(element.props || {}), match)
  const candidate = { type: element.type, props: element.props || {} }
  if (match(candidate)) return candidate
  return findElement(element.children, match)
}

test('q21 新建项目：默认推进 bot 是「项目管理」，任何一步都能存草稿；归档后可删除', () => {
  const noop = () => {}
  const bots = [
    { id: 'bot-pm', kind: 'bot', name: '项目管理', status: 'active' },
    { id: 'bot-data', kind: 'bot', name: '数据分析', status: 'active' },
  ]
  const formTree = renderScreen('ProjectScreen', {
    projects: [], detail: null, busy: false, formOpen: true, draft: null, bots, humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
    onCommand: noop, onSaveDraft: noop, onPublish: noop, onContinueDraft: noop, onDelete: noop,
    allowedActions: ['create'],
  })
  const formText = textOf(formTree)
  for (const label of ['新建项目', '项目管理', '数据分析', '保存草稿', '可随时保存草稿']) {
    assert.ok(formText.includes(label), `新建向导应显示「${label}」：${formText.slice(0, 400)}`)
  }
  const select = findElement(formTree, (element) => element.type === 'select' && element.props['aria-label'] === '推进 bot')
  assert.ok(select, '向导里应有「推进 bot」选择框')
  assert.equal(select!.props.value, 'bot-pm', '默认选中「项目管理」bot')

  const draftTree = renderScreen('ProjectScreen', {
    projects: [], detail: null, busy: false, formOpen: true,
    draft: { projectId: 'p1', name: '草稿项目', type: 'one_off', goalText: '', coordinatorId: 'bot-pm', step: 2, metrics: [], savedAt: 1 },
    bots, humans: [], onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
    onCommand: noop, onSaveDraft: noop, onPublish: noop, onContinueDraft: noop, onDelete: noop, allowedActions: ['create'],
  })
  const draftText = textOf(draftTree)
  assert.ok(draftText.includes('继续完善草稿'), `草稿应能继续填：${draftText.slice(0, 300)}`)
  assert.ok(draftText.includes('草稿项目'))

  const archived = {
    id: 'p9', name: '已归档项目', type: 'continuous', status: 'archived', revision: 2, owner_human_id: 'h1', owner_name: '王',
    coordinator_id: 'bot-pm', coordinator_name: '项目管理', goal_text: '收尾', current_target_version: 1,
    current_target: null, target_versions: [], metrics: [], phases: [], reviews: [], progress_records: {}, work_items: [],
    budgets: [], draft: null, allowedActions: ['delete'],
  }
  const archivedText = textOf(renderScreen('ProjectScreen', {
    projects: [archived], detail: archived, busy: false, formOpen: false, bots, humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
    onCommand: noop, onSaveDraft: noop, onPublish: noop, onContinueDraft: noop, onDelete: noop,
    allowedActions: ['create'], initialTab: 'goals',
  }))
  assert.ok(archivedText.includes('删除项目'), `归档项目应出现删除入口：${archivedText.slice(0, 300)}`)
})

test('q22 项目「记忆」页签与 bot 侧同步记忆：标题、来源与同步标记都能看到', () => {
  const noop = () => {}
  const project = {
    id: 'p1', name: '示例项目', type: 'continuous', status: 'active', revision: 1, owner_human_id: 'h1', owner_name: '王',
    goal_text: '做成链路', current_target_version: 1, current_target: null, target_versions: [], metrics: [], phases: [],
    reviews: [], progress_records: {}, work_items: [], budgets: [], memory_count: 2, allowedActions: ['manageMemory'],
  }
  const tree = renderScreen('ProjectScreen', {
    projects: [project], detail: project, busy: false, formOpen: false,
    bots: [{ id: 'bot-pm', kind: 'bot', name: '项目管理', status: 'active' }], humans: [],
    onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onRecord: noop, onGotoTasks: noop,
    onCommand: noop, allowedActions: [], initialTab: 'memory', onRefreshDetail: noop,
  })
  const text = textOf(tree)
  for (const label of ['记忆 2', '项目记忆', '记一条', '读取记忆…', '群聊里自动发现']) {
    assert.ok(text.includes(label), `项目记忆页签应显示「${label}」：${text.slice(0, 500)}`)
  }

  const bot = {
    id: 'b1', kind: 'bot', name: '数据分析', domain: '通用', responsibility: '查数给结论', role: 'executor',
    status: 'active', current_version: 1, owner_human_id: 'h1', owner_name: '王', created_at: 0, updated_at: 0,
    positions: [], capabilities: [], work: { total: 0, open: 0, byStatus: {} }, runs: { total: 0, last_at: null },
    position_history: [], permissions: [], recent_work: [], recent_runs: [], login: null,
    bot_versions: [], activity: { days: [] }, config: { memory_scope: {} },
    memories: [{ id: 'mm1', kind: 'capability', title: '先对账再下结论', body: '先核台账，再核现场照片', project_name: '示例项目', created_at: 0 }],
    allowedActions: [],
  }
  const memberText = textOf(renderScreen('MemberScreen', {
    members: [bot], detail: bot, positions: [], busy: false, formOpen: false, filter: 'all',
    onFilter: noop, onCreate: noop, onOpen: noop, onFormOpen: noop, onStatus: noop, onCommand: noop,
    allowedActions: [], initialTab: 'memory',
  }))
  for (const label of ['从项目同步的能力记忆（1）', '先对账再下结论', '示例项目']) {
    assert.ok(memberText.includes(label), `bot 记忆页签应显示「${label}」：${memberText.slice(0, 500)}`)
  }
})
