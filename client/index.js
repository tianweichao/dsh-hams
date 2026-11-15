/**
 * dsh-hams 客户端模块（由宿主 client loader 加载，不需要打包器）。
 *
 * 约定与本地已验证插件一致：文件包一层 `window.__ModuleLoader__.load({id, factory})`，
 * React 由宿主提供（`require('react')`），`apply(ctx)` 里用 `ctx.slots.inject/register`
 * 注册左侧入口与主面板。没有 JSX：用 `React.createElement`。
 *
 * 首版四屏（只读 + 少量动作）：总览 / 追踪单 / 待我把关 / 异常。
 * 数据接口：`overview/get`、`workItem/list`、`workItem/get`、`approval/decide`、
 * `workItem/pause|resume|cancel`。失败一律显示错误码 + nextStep，不弹 alert。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hams',
  factory: (require) => {
    var module = { exports: {} };
    const React = require('react');
    const h = React.createElement;

    const name = 'hams-client';
    const inject = ['slots', 'layout'];
    const PANEL_ID = 'hams';
    const API = '/hams/api/v1/';

    /**
     * 左侧栏白名单：宿主补丁只做「按 window.__hamsRows 过滤」，具体留哪几行由这里决定。
     * 这样「应用」页的固定/取消固定才能真正增删左侧行；插件没加载时宿主不过滤（原行为）。
     */
    const SHELL_ROWS = ['conversations', 'schedules', 'hams', 'apps'];
    const PIN_STORE_KEY = 'hams.pinnedApps';
    const readPinnedApps = () => {
      try {
        const raw = window.localStorage.getItem(PIN_STORE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id && !SHELL_ROWS.includes(id)) : [];
      } catch (err) { return []; }
    };
    const writePinnedApps = (ids) => {
      try { window.localStorage.setItem(PIN_STORE_KEY, JSON.stringify(ids)); } catch (err) { /* 隐私模式写不了就只在内存里生效 */ }
    };
    const syncSidebarRows = () => {
      const pins = readPinnedApps();
      try { window.__hamsRows = [...SHELL_ROWS, ...pins]; } catch (err) { /* 忽略 */ }
      return pins;
    };
    syncSidebarRows();

    // 设计口径：靠排版和色块分层，不用矩形框线。
    // 卡片/面板 = 淡蓝底；选中 = 深一点的蓝底；分隔线只在万不得已时用最浅的一档。
    const C = {
      line: 'rgba(127,127,127,.25)',
      hair: 'rgba(127,127,127,.12)',
      soft: 'rgba(127,127,127,.08)',
      tint: 'rgba(47,91,216,.035)',
      tintHover: 'rgba(47,91,216,.055)',
      tintStrong: 'rgba(47,91,216,.08)',
      muted: 'rgba(127,127,127,.9)',
      accent: '#2F5BD8',
      ok: '#2f9e44',
      bad: '#e03131',
      warn: '#e8590c',
    };
    /** 把 #rrggbb / rgb() / rgba() 统一变成带 alpha 的 rgba；用于徽标底色。 */
    const withAlpha = (color, alpha) => {
      const value = String(color || '').trim();
      if (value.startsWith('#')) {
        const hex = value.length === 4 ? value.slice(1).split('').map((ch) => ch + ch).join('') : value.slice(1, 7);
        const num = parseInt(hex, 16);
        return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
      }
      const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
      if (rgba) {
        const parts = rgba[1].split(',').map((part) => part.trim());
        return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
      }
      return value;
    };

    let seq = 0;
    function newKey(prefix) {
      seq += 1;
      return `${prefix}-${Date.now().toString(36)}-${seq}`;
    }

    async function call(command, options = {}) {
      const body = {
        commandId: newKey('ui'),
        idempotencyKey: options.idempotencyKey || newKey('ui-idem'),
        objectId: options.objectId,
        expectedRevision: options.expectedRevision,
        payload: options.payload,
      };
      const response = await fetch(API + command, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        // 宿主没发会话 cookie：这一页不是从带 ?token= 的地址打开的（或 cookie 过期）。
        throw {
          code: 'POLICY_DENIED',
          message: '浏览器会话未认证',
          nextStep: '用 dsh 打印的带 ?token= 的地址重新打开页面（或刷新）后再操作',
        };
      }
      if (response.status === 403) {
        throw {
          code: 'POLICY_DENIED',
          message: '面板还没有绑定本机操作者，或请求来源不被信任',
          nextStep: '从本机 127.0.0.1/localhost 打开面板；若仍失败，检查 hams_user(auth_source=local_host) 或插件配置 localPrincipalId',
        };
      }
      let json;
      try {
        json = await response.json();
      } catch {
        if (response.status === 404 || response.status === 405) {
          // 页面刚刷新、插件服务端还是旧版本时就是这个签名：新界面调用不到新接口。
          throw {
            code: 'HOST_CAPABILITY_MISSING',
            message: `插件服务端没有这个接口（HTTP ${response.status}：${command}）`,
            nextStep: '重启 DeepSeek Harness（刷新页面不够，服务端代码要重启才生效）；重启后再试',
          };
        }
        throw { code: 'STATE_INVALID', message: `响应不是 JSON（HTTP ${response.status}）`, nextStep: '刷新后重试' };
      }
      if (json.ok === false) throw json.error || { code: 'STATE_INVALID', message: '未知失败', nextStep: '刷新后重试' };
      return json.data !== undefined ? json.data : json;
    }

    const styles = {
      rail: { width: 188, flex: '0 0 188px', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 4, boxSizing: 'border-box' },
      railBrand: { fontSize: 12, fontWeight: 600, letterSpacing: .2, color: C.muted, padding: '0 8px 10px' },
      railItem: (active) => ({
        textAlign: 'left', padding: '7px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
        border: 'none',
        background: active ? C.tintStrong : 'transparent',
        color: active ? C.accent : 'inherit',
      }),
      // 页面标题固定在壳里，只有 contentBody 滚动：长列表/详情滚到底，标题也不会被带走。
      content: { flex: 1, minWidth: 0, minHeight: 0, padding: '20px 0 0', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: 'inherit', overflow: 'hidden' },
      contentBody: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', overflowX: 'hidden', padding: '0 24px 20px' },
      pageHeader: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', flex: '0 0 auto', padding: '0 24px 10px' },
      header: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      muted: { color: C.muted, fontSize: 12 },
      tabs: { display: 'flex', gap: 6, paddingBottom: 4, flexWrap: 'wrap' },
      tabStrip: { display: 'flex', gap: 6, paddingBottom: 6, flexWrap: 'wrap', borderBottom: `1px solid ${C.hair}` },
      tab: (active) => ({
        padding: '5px 10px',
        borderRadius: 8,
        border: 'none',
        background: active ? C.tintStrong : 'transparent',
        color: active ? C.accent : 'inherit',
        cursor: 'pointer',
        fontSize: 13,
      }),
      page: { display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 },
      card: { border: 'none', padding: '2px 0', display: 'flex', flexDirection: 'column', gap: 8 },
      row: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
      stat: { border: 'none', borderRadius: 10, padding: '8px 10px', background: 'transparent' },
      num: { fontSize: 22, fontWeight: 600 },
      list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
      item: { border: 'none', borderRadius: 10, padding: '10px 12px', background: 'transparent', display: 'flex', flexDirection: 'column', gap: 6 },
      badge: (color) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, color, border: 'none', background: withAlpha(color, .12), whiteSpace: 'nowrap' }),
      button: (primary) => ({
        padding: '4px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: 'none',
        background: primary ? C.accent : C.tintHover,
        color: primary ? '#fff' : 'inherit',
      }),
      err: { border: 'none', borderRadius: 10, padding: '10px 12px', color: C.bad, background: 'rgba(224,49,49,.08)' },
      empty: { color: C.muted, padding: '24px 12px', textAlign: 'center' },
      notice: { padding: '10px 12px', borderRadius: 8, background: C.tint, fontSize: 12, lineHeight: 1.6 },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, maxHeight: 320, overflow: 'auto' },
      input: {
        padding: '6px 9px', borderRadius: 8, fontSize: 12, color: 'inherit',
        border: 'none', background: C.tint, minWidth: 0,
      },
    };

    const STATUS_COLOR = {
      ready: C.accent, active: C.ok, waiting_check: C.warn, waiting_review: C.warn,
      blocked: C.bad, paused: C.muted, completed: C.ok, failed: C.bad, cancelled: C.muted,
    };

    /** 动作名 → 中文按钮文案（服务端给的是语义名，界面不直接展示英文）。 */
    const LABELS = {
      accept: '接单', claim: '认领', addEvidence: '加证据', requestClosure: '申请关单',
      pause: '暂停', resume: '继续', cancel: '取消', reopen: '重开', retry: '重试',
      reportBlocker: '报阻塞', unblock: '解除阻塞', decideApproval: '去总览审批',
    };

    /**
     * 界面已经接上的动作 → 命令。表里没有的动作仍然展示但禁用，
     * 并在 title 写清「用工具代替」，避免点了才报 POLICY_DENIED。
     */
    const ACTIONS = {
      accept: { command: 'workItem/accept' },
      pause: { command: 'workItem/pause' },
      resume: { command: 'workItem/resume' },
      cancel: { command: 'workItem/cancel' },
      reopen: { command: 'workItem/reopen' },
      retry: { command: 'workItem/retry' },
      requestClosure: { command: 'workItem/requestClosure', reason: true },
      assign: { command: 'workItem/assign' },
      reportBlocker: { command: 'workItem/reportBlocker', reason: true },
      unblock: { command: 'workItem/unblock' },
      addEvidence: { command: 'workItem/addEvidence', form: true },
    };

    const badge = (text, color) => h('span', { style: styles.badge(color || C.muted) }, text);
    const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
    /** 表格里的日期列只放日期，完整时间进 title：一行放得下，也不会把列撑开。 */
    const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '—');
    /** 头像只用姓名首字：本机没有头像文件，也不该为几个字去拉网络图片。 */
    const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase();
    const avatar = (name, size, kind) => h('span', {
      'aria-hidden': 'true',
      style: {
        width: size, height: size, flex: 'none', borderRadius: '50%', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
        background: kind === 'bot' ? C.tintStrong : withAlpha(C.ok, .14), border: 'none',
        color: kind === 'bot' ? C.accent : C.ok, fontSize: Math.round(size * 0.42), fontWeight: 600,
      },
    }, initials(name));
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    function ErrorBox({ error, onDismiss }) {
      if (!error) return null;
      return h('div', { style: styles.err }, [
        h('div', { key: 'h', style: { fontWeight: 600 } }, `${error.code || 'CONNECTION_LOST'}：${error.message || '连接中断，请稍后刷新'}`),
        h('div', { key: 'n', style: { fontSize: 12, marginTop: 4 } }, `下一步：${error.nextStep || '刷新后重试'}`),
        onDismiss ? h('button', { key: 'd', style: { ...styles.button(false), marginTop: 6 }, onClick: onDismiss }, '知道了') : null,
      ]);
    }

    function Stat({ label, value }) {
      return h('div', { style: styles.stat }, [
        h('div', { key: 'l', style: styles.muted }, label),
        h('div', { key: 'v', style: styles.num }, String(value)),
      ]);
    }

    function approvalValidity(approval, item, now = Date.now()) {
      if (approval.status !== 'pending') return approval.invalidated_reason ? `本申请已失效：${approval.invalidated_reason}` : '本申请已结束，请查看审批记录';
      if (approval.expires_at <= now) return `本申请已于 ${fmtTime(approval.expires_at)} 过期，未批准`;
      if (!item) return '正在载入申请材料';
      if (item.evidence_set_hash !== approval.evidence_set_hash) return '申请后证据有变化，请按新材料重新申请';
      if (item.revision !== approval.subject_revision) return '对象修订号有变化，请重新申请';
      if (item.execution_epoch !== approval.execution_epoch) return '执行代次已变化，请在当前代次重新处置';
      if (item.template_version_id !== approval.criteria_ref) return '判据版本已变化，请重新申请';
      if (item.status !== 'waiting_review') return '工作项当前不在待验收状态';
      return null;
    }
    function ApprovalDrawer({ approval, item, busy, onClose, onApprove, onOpenTask, me, canApprove }) {
      const [note,setNote] = useDraft(`approval:${approval.id}`, '');
      const invalid = approval.subject_kind !== 'work_item_close' ? '此类审批尚未接入材料核对，请使用对应业务页面' : approvalValidity(approval,item);
      const allowed = !invalid && canApprove && !!me && approval.approver_id === me;
      const template = item && item.templateVersion;
      return h('div',{className:'hams-drawer-backdrop',onClick:onClose},h('section',{className:'hams-drawer',role:'dialog','aria-modal':true,'aria-label':'审批材料核对',onClick:e=>e.stopPropagation()},[
        h('div',{key:'head',style:styles.row},[h('h2',{key:'title',style:{margin:0,fontSize:17}},'待我把关 · 审批材料'),rowButton('关闭',onClose,{key:'close'})]),
        h('strong',{key:'subject'},item ? item.title : approval.reason_text),
        h('div',{key:'binding',style:{...styles.notice,wordBreak:'break-all'}},[
          h('div',{key:'v'},`对象修订 v${approval.subject_revision} · 执行代次 ${approval.execution_epoch}`),
          h('div',{key:'h'},`申请证据哈希 ${approval.evidence_set_hash || '无'}`),
          h('div',{key:'c'},`判据版本 ${approval.criteria_ref || '未指定'} · 有效期至 ${fmtTime(approval.expires_at)}`),
        ]),
        invalid ? h('div',{key:'invalid',style:styles.err},[invalid,item && item.evidence_set_hash!==approval.evidence_set_hash ? h('div',{key:'new',style:{wordBreak:'break-all'}},`当前证据哈希 ${item.evidence_set_hash}`):null,rowButton('查看当前工作项',()=>onOpenTask(approval.subject_id),{key:'go'})]) : null,
        h('div',{key:'materials',className:'hams-approval-columns'},[
          h('div',{key:'criteria',style:styles.list},[
            h('strong',{key:'h'},'判据与证据'),
            h('pre',{key:'c',style:styles.pre},JSON.stringify(safeJSON(approval.criteria_json,[]),null,2)),
            ...((item && item.evidence) || []).map(row=>h('div',{key:row.id,style:styles.item},[badge(row.kind,C.accent),h('div',{key:'ref',style:{wordBreak:'break-all'}},row.ref),h('div',{key:'at',style:styles.muted},fmtTime(row.observed_at))])),
            item && !(item.evidence || []).length ? h('div',{key:'empty',style:styles.empty},'暂无证据') : null,
          ]),
          h('div',{key:'decision',style:styles.list},[
            h('strong',{key:'h'},'申请理由'),h('p',{key:'reason',style:{margin:0,lineHeight:1.7}},approval.reason_text || '未填写'),
            h('label',{key:'note',style:styles.list},[h('span',{key:'l'},'决策说明（要求补充或退回处理必填）'),h('textarea',{key:'text',style:{...styles.input,minHeight:120},value:note,onChange:e=>setNote(e.target.value),'aria-label':'决策说明'})]),
            h('div',{key:'tip',style:styles.notice},'要求补充：转为缺证据阻塞。退回处理：回到执行中重新处置。批准关闭：本次审批与关单同时完成。'),
          ]),
        ]),
        h('div',{key:'actions',style:{...styles.row,justifyContent:'flex-end'}},[
          rowButton('要求补充',()=>onApprove(approval,'return',note),{key:'return',disabled:busy || !allowed || !note.trim()}),
          rowButton('退回处理',()=>onApprove(approval,'reject',note),{key:'reject',disabled:busy || !allowed || !note.trim()}),
          rowButton('批准关闭',()=>onApprove(approval,'approve',note),{key:'approve',style:styles.button(true),disabled:busy || !allowed,title:invalid || undefined}),
        ]),
      ]));
    }
    function ProposalDecision({ proposal, busy, me, templates, onDecide }) {
      const [note,setNote]=useDraft(`proposal:${proposal.id}`, '');
      const [template,setTemplate]=React.useState((templates.find(t=>t.published_version_id)||{}).published_version_id || '');
      const body=proposal.body || ''; const rationale=safeJSON(proposal.rationale_json);
      return h('article',{style:styles.item},[
        h('div',{key:'h',style:styles.row},[h('strong',{key:'t'},proposal.title),badge('提议待决定',C.warn)]),
        h('div',{key:'subject',style:styles.muted},`${proposal.kind} · ${proposal.subject_key || ''}`),
        h('p',{key:'body',style:{margin:0,lineHeight:1.7}},typeof body==='string'?body:JSON.stringify(body)),
        h('pre',{key:'rationale',style:styles.pre},JSON.stringify(rationale,null,2)),
        h(Field,{key:'note',label:'决定理由',value:note,onChange:setNote}),
        proposal.kind==='create_task' ? h('select',{key:'template',style:styles.input,value:template,onChange:e=>setTemplate(e.target.value),'aria-label':'采纳提议的判据模板'},[h('option',{key:'none',value:''},'选择判据模板'),...templates.filter(t=>t.published_version_id).map(t=>h('option',{key:t.id,value:t.published_version_id},t.name))]) : null,
        h('div',{key:'actions',style:{...styles.row,justifyContent:'flex-start'}},[
          rowButton(proposal.kind==='create_task'?'采纳并建任务':'采纳记录，相关变更另行执行',()=>onDecide(proposal,'accept',note,template),{key:'yes',style:styles.button(true),disabled:busy || !note.trim() || (proposal.kind==='create_task' && !template) || proposal.decider_id!==me}),
          rowButton('不采纳',()=>onDecide(proposal,'reject',note),{key:'no',disabled:busy || !note.trim() || proposal.decider_id!==me}),
        ]),
      ]);
    }
    function OverviewTab({ overview, onOpenApproval, onOpenTask, onProposal, onReview, busy, projects=[], templates=[], me }) {
      const [mode,setMode]=React.useState('all');
      if (!overview) return h('div',{style:styles.empty},'正在读取工作台…');
      const pending=overview.approvals.length+overview.proposals.length+(overview.reviews || []).length;
      return h('div',{style:styles.list},[
        h('div',{key:'stats',style:styles.grid},[
          h(Stat,{key:'pending',label:'待我把关',value:pending}),h(Stat,{key:'due',label:'到期复查',value:overview.dueChecks.length}),h(Stat,{key:'open',label:'我的未结',value:overview.counts.myOpen}),h(Stat,{key:'runs',label:'进行中运行',value:overview.counts.activeRuns}),
        ]),
        h('section',{key:'pending',style:styles.card},[
          h('div',{key:'h',style:styles.row},[h('strong',{key:'t'},`待我把关 · ${pending}`),h('span',{key:'note',style:styles.muted},'超时失效后可重新申请，不会自动通过')]),
          h('div',{key:'filter',style:styles.tabStrip},[['all','全部'],['approval','审批'],['proposal','提议'],['review','复盘']].map(([key,label])=>rowButton(label,()=>setMode(key),{key,style:styles.tab(mode===key)}))),
          ...(['all','approval'].includes(mode)?overview.approvals.map(ap=>h('article',{key:ap.id,style:styles.item},[
            h('div',{key:'h',style:styles.row},[h('strong',{key:'t'},ap.reason_text || '工作项关单申请'),badge(ap.expires_at<=Date.now()?'已过期':'待审批',C.warn)]),
            h('div',{key:'binding',style:styles.muted},`对象 v${ap.subject_revision} · 判据 ${ap.criteria_ref || '—'} · 到期 ${fmtTime(ap.expires_at)}`),
            rowButton('核对材料',()=>onOpenApproval(ap),{key:'open',disabled:busy}),
          ])):[]),
          ...(['all','proposal'].includes(mode)?overview.proposals.map(p=>h(ProposalDecision,{key:p.id,proposal:p,busy,me,templates,onDecide:onProposal})):[]),
          ...(['all','review'].includes(mode)?(overview.reviews || []).map(review=>h('article',{key:review.id,style:styles.item},[
            h('strong',{key:'title'},`${review.projectName || review.project_name || '项目'} · 待确认复盘`),h('div',{key:'period',style:styles.muted},`${fmtTime(review.period_start)} — ${fmtTime(review.period_end)}`),
            rowButton('查看冻结快照',()=>onReview(review),{key:'open'}),
          ])):[]),
          !pending?h('div',{key:'empty',style:styles.empty},'暂时没有等你决定的事项'):null,
        ]),
        h('div',{key:'bottom',className:'hams-overview-grid'},[
          h('section',{key:'due',style:styles.card},[h('strong',{key:'h'},'到期复查'),...overview.dueChecks.map(check=>rowButton(`${check.title} · ${fmtTime(check.planned_due_at)}`,()=>onOpenTask(check.work_item_id),{key:check.id,style:{...styles.item,textAlign:'left',background:'transparent',color:'inherit',cursor:'pointer'}})),!overview.dueChecks.length?h('div',{key:'empty',style:styles.empty},'暂无到期复查'):null]),
          h('section',{key:'goals',style:styles.card},[h('strong',{key:'h'},'项目目标与推进'),...projects.filter(p=>p.status==='active').map(p=>h('div',{key:p.id,style:styles.item},[h('strong',{key:'n'},p.name),h('div',{key:'g',style:styles.muted},p.goal_text),h('div',{key:'w',style:styles.muted},`未结 ${p.work_items.open} / ${p.work_items.total} · 目标 v${p.current_target_version}`)])),!projects.length?h('div',{key:'empty',style:styles.empty},'尚无项目，先建立目标与指标'):null]),
          h('section',{key:'runs',style:styles.card},[h('strong',{key:'h'},'执行与异常'),...overview.executions.map(run=>rowButton(`${run.title} · ${run.status}`,()=>onOpenTask(run.workItemId),{key:run.runId})),...overview.attention.map(item=>h('div',{key:item.id,style:styles.notice},[h('strong',{key:'reason'},item.reason),h('div',{key:'detail'},item.detail),item.workItemId?rowButton('查看工作项',()=>onOpenTask(item.workItemId),{key:'open'}):null])),!overview.executions.length && !overview.attention.length?h('div',{key:'empty',style:styles.empty},'暂无执行或异常'):null]),
        ]),
      ]);
    }

    const STATUS_LABEL = { ready: '待处理', active: '执行中', waiting_check: '待复查', waiting_review: '待验收', blocked: '阻塞', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' };
    const BLOCK_LABEL = { needs_evidence: '缺证据', external: '等外部', dependency: '等依赖', permission: '缺权限', human_input: '等人输入', data_source: '缺数据源' };
    const statusBadge = (status) => badge(STATUS_LABEL[status] || status, STATUS_COLOR[status]);
    const rowButton = (label, onClick, props = {}) => h('button', { type: 'button', style: styles.button(false), onClick, ...props }, label);
    const drafts = new Map();
    function useDraft(key, initial) {
      const [value, setValue] = React.useState(() => drafts.has(key) ? drafts.get(key) : initial);
      const update = next => setValue(old => { const value = typeof next === 'function' ? next(old) : next; drafts.set(key, value); return value; });
      return [value, update];
    }
    function clearDraft(prefix) { for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key); }
    function safeJSON(value, fallback = {}) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return fallback; } }
    function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    function boardColumn(item) { return item.status === 'paused' ? (item.resume_state || 'active') : item.status; }
    function taskFilter(items, filters) {
      const q = (filters.q || '').trim().toLowerCase();
      return items.filter((item) => (!q || `${item.title} ${item.id} ${item.asset_id || ''}`.toLowerCase().includes(q))
        && (!filters.status || item.status === filters.status) && (!filters.domain || item.domain === filters.domain)
        && (!filters.project || item.project_id === filters.project)
        && (!filters.mine || item.owner_human_id === filters.me || item.assignee_id === filters.me))
        .sort((a,b) => ((a.status === 'waiting_check' ? 0 : 1) - (b.status === 'waiting_check' ? 0 : 1))
          || ((a.next_action_at || a.due_at || Infinity) - (b.next_action_at || b.due_at || Infinity)) || (a.priority - b.priority));
    }
    function BlockerForm({ busy, onSubmit }) {
      const [category, setCategory] = React.useState('needs_evidence');
      const [note, setNote] = React.useState('');
      return h('div', { style: styles.card }, [h('strong', { key:'h' }, '报告阻塞'),
        h('select', { key:'c', style:styles.input, value:category, onChange:e=>setCategory(e.target.value), 'aria-label':'阻塞类别' }, Object.entries(BLOCK_LABEL).map(([key,label])=>h('option',{key,value:key},label))),
        h(Field,{key:'n',label:'阻塞说明',value:note,onChange:setNote}),
        rowButton('提交阻塞',()=>onSubmit({category,note}),{key:'s',disabled:busy || !note.trim()})]);
    }
    function TaskDetail({ selected, onClose, onAct, busy, canAct, evidenceForm, actionForm, onCheck, members = [] }) {
      const [tab,setTab] = React.useState('summary');
      const [assignee, setAssignee] = React.useState('');
      if (!selected) return null;
      const tabs = [['summary','概览'],['events','处理记录'],['evidence','证据'],['runs','执行'],['approvals','审批']];
      const template = selected.templateVersion || {};
      const required = safeJSON(template.required_evidence_json, []);
      const events = selected.events || [];
      const evidence = selected.evidence || [];
      const checks = selected.checks || [];
      const actions = selected.allowedActions || [];
      return h('section', { className:'hams-detail', style:styles.page, 'aria-label':'工作项详情' }, [
        // 操作与标题同一行（原来在页尾，长页面要滚到底才看得见）。窄屏时按钮换行、标题先占满整行。
        h('div',{key:'head',style:{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',minWidth:0}},[
          statusBadge(selected.status),
          h('strong',{key:'t',style:{fontSize:16,flex:'1 1 220px',minWidth:0}},selected.title),
          h('span',{key:'v',style:{...styles.muted,flex:'none'}},`修订 v${selected.revision} · 执行代次 ${selected.execution_epoch}`),
          actions.length ? h('div',{key:'a',style:{display:'flex',gap:6,flexWrap:'wrap',justifyContent:'flex-end'}},actions.map(action=>rowButton(LABELS[action] || action,()=>onAct(action,selected),{key:action,disabled:busy || !canAct || (!ACTIONS[action] && action!=='decideApproval'),title:!ACTIONS[action] && action!=='decideApproval' ? '由业务智能体执行' : undefined}))) : null,
          onClose ? rowButton('← 返回任务列表',onClose,{key:'close'}) : null,
        ]),
        selected.status==='paused' ? h('div',{key:'pause',style:styles.notice},`追踪单已暂停，暂停前为${STATUS_LABEL[boardColumn(selected)] || '执行中'}。恢复后到期复查会重新入队。`) : null,
        selected.blocked_reason ? h('div',{key:'block',style:styles.notice},`现在还不能关单：${BLOCK_LABEL[selected.blocked_reason] || selected.blocked_reason}`) : null,
        h('div',{key:'tabs',style:styles.tabStrip,role:'tablist'},tabs.map(([id,label])=>rowButton(label,()=>setTab(id),{key:id,role:'tab','aria-selected':tab===id,style:styles.tab(tab===id)}))),
        tab==='summary' ? h('div',{key:'summary',style:styles.list},[
          h('div',{key:'meta',style:styles.grid},[h(Stat,{key:'p',label:'优先级',value:`P${selected.priority || 3}`}),h(Stat,{key:'due',label:'下一步时间',value:fmtTime(selected.next_action_at)}),h(Stat,{key:'d',label:'任务截止',value:fmtTime(selected.due_at)})]),
          h('div',{key:'owner',style:styles.muted},`业务域 ${selected.domain} · 负责人 ${selected.owner_name || selected.owner_human_id} · 执行人 ${selected.assignee_name || selected.assignee_id || '未分配'}`),
          selected.status === 'ready' && members.filter((m) => m.kind === 'bot' && m.status === 'active').length
            ? h('div', { key: 'assign', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                h('span', { key: 'l', style: styles.muted }, '指派给'),
                h('select', {
                  key: 's', 'aria-label': '指派给哪个智能体', value: assignee,
                  style: styles.input, onChange: (event) => setAssignee(event.target.value),
                }, [h('option', { key: '', value: '' }, '选择 bot'), ...members.filter((m) => m.kind === 'bot' && m.status === 'active').map((m) => h('option', { key: m.id, value: m.id }, m.name))]),
                h(PMButton, { key: 'go', primary: true, disabled: busy || !canAct || !assignee, onClick: () => onAct('assign', selected, { memberId: assignee }) }, '指派并开跑'),
                h('span', { key: 'hint', style: styles.muted }, '指派后由 bot 在自己的会话里认领并执行这一轮。'),
              ])
            : null,
          h('strong',{key:'criteria'},'关单判据'),
          h('div',{key:'template'},selected.template_version_id ? `判据版本 ${selected.template_version_id}` : '未绑定判据模板，需绑定后才能申请关单'),
          h('pre',{key:'required',style:styles.pre},JSON.stringify(required,null,2)),
          h('div',{key:'hash',style:{...styles.muted,wordBreak:'break-all'}},`当前证据哈希 ${selected.evidence_set_hash || '无证据'}`),
          h('strong',{key:'ch'},'复查计划'),
          checks.length ? checks.map(check=>h('div',{key:check.id,style:styles.item},[
            h('div',{key:'d'},`${fmtTime(check.planned_due_at)} · ${check.status} · ${safeJSON(check.result_json).verdict || '尚未判定'}`),
            ['scheduled','running'].includes(check.status) && onCheck ? rowButton('核验证据并复查',()=>onCheck(check.id),{key:'go',disabled:busy || !canAct || !(selected.canEvaluateCheck)}) : null,
          ])) : h('div',{key:'empty',style:styles.empty},'暂无复查计划'),
        ]) : null,
        tab==='events' ? h('div',{key:'events',style:styles.list},events.length ? events.map(event=>h('article',{key:event.id,style:styles.item},[
          h('div',{key:'h',style:styles.row},[h('strong',{key:'k'},event.kind),h('time',{key:'at',style:styles.muted},fmtTime(event.created_at))]),
          h('div',{key:'who',style:styles.muted},`操作人 ${event.actor_name || event.actor_id || '系统'} · 修订 ${event.revision || '—'}`),
          h('pre',{key:'p',style:styles.pre},JSON.stringify(safeJSON(event.payload_json),null,2)),
        ])) : h('div',{style:styles.empty},'暂无处理记录')) : null,
        tab==='evidence' ? h('div',{key:'evidence',style:styles.list},evidence.length ? evidence.map(row=>h('article',{key:row.id,style:styles.item},[
          h('div',{key:'h',style:styles.row},[badge(row.kind,C.accent),h('time',{key:'at',style:styles.muted},fmtTime(row.observed_at))]),
          h('div',{key:'ref',style:{wordBreak:'break-all'}},row.ref),
          h('div',{key:'source',style:styles.muted},`来源 ${row.source || '未注明'} · ${row.supersedes_id ? `替代 ${row.supersedes_id}` : '原始记录'}${row.purged_at ? ' · 附件已到期清理，留存哈希' : ''}`),
        ])) : h('div',{style:styles.empty},'尚未提交证据，可用下方「加证据」追加')) : null,
        tab==='runs' ? h('div',{key:'runs',style:styles.list},[
          h('div',{key:'thread',style:styles.notice},selected.current_thread ? `第 ${selected.current_thread.generation} 代 · 会话 ${selected.current_thread.session_id || '尚未关联宿主会话'}` : '尚未关联宿主会话'),
          ...(selected.runs || []).map(run=>h('article',{key:run.id,style:styles.item},[
            h('strong',{key:'h'},`${run.status} · ${run.trigger || '运行'}`),h('div',{key:'at',style:styles.muted},`${fmtTime(run.started_at || run.created_at)} → ${fmtTime(run.finished_at)}`),
            h('div',{key:'id',style:styles.muted},`运行 ${run.id} · 成员 ${run.member_id}`),
          ])),
          !(selected.runs || []).length ? h('div',{key:'empty',style:styles.empty},'暂无执行记录') : null,
        ]) : null,
        tab==='approvals' ? h('div',{key:'approvals',style:styles.list},(selected.approvals || []).length ? selected.approvals.map(ap=>h('article',{key:ap.id,style:styles.item},[
          h('strong',{key:'state'},`${ap.status === 'pending' && ap.expires_at<=Date.now() ? '已过期，未批准' : ap.status} · ${fmtTime(ap.created_at)}`),
          h('div',{key:'binding',style:{...styles.muted,wordBreak:'break-all'}},`对象 v${ap.subject_revision} · 证据 ${ap.evidence_set_hash} · 判据 ${ap.criteria_ref || '—'} · 执行代次 ${ap.execution_epoch}`),
          h('div',{key:'reason'},ap.reason_text || ''),h('div',{key:'note',style:styles.muted},ap.decision_note || `有效期至 ${fmtTime(ap.expires_at)}`),
        ])) : h('div',{style:styles.empty},'尚无审批申请')) : null,
        evidenceForm && evidenceForm.workItemId===selected.id ? h(EvidenceForm,{key:'ef',form:evidenceForm,busy:busy || !canAct,onSubmit:input=>onAct('addEvidence',selected,input)}) : null,
        actionForm && actionForm.workItemId===selected.id ? actionForm.action==='reportBlocker'
          ? h(BlockerForm,{key:'bf',busy:busy || !canAct,onSubmit:input=>onAct('reportBlocker',selected,input)})
          : h(ReasonForm,{key:actionForm.action,draftKey:`action:${selected.id}:${actionForm.action}`,busy:busy || !canAct,required:true,label:actionForm.action==='requestClosure' ? '申请关单理由' : '操作原因',onSubmit:reason=>onAct(actionForm.action,selected,{reason})}) : null,
      ]);
    }
    function TaskCalendar({ items, checks, onSelect }) {
      const [month,setMonth] = React.useState(()=>{const d=new Date();d.setDate(1);d.setHours(0,0,0,0);return d.getTime();});
      const current=new Date(month); const start=new Date(month);start.setDate(1-((start.getDay()+6)%7));
      const events=[];
      items.forEach(item=>{if(item.due_at)events.push({id:`due-${item.id}`,itemId:item.id,title:item.title,at:item.due_at,kind:'截止'});});
      (checks || []).forEach(check=>{ const item=items.find(row=>row.id===check.work_item_id); if(item && ['scheduled','running'].includes(check.status))events.push({id:check.id,itemId:item.id,title:item.title,at:check.planned_due_at,kind:'复查'}); });
      const move=delta=>{const d=new Date(month);d.setMonth(d.getMonth()+delta);setMonth(d.getTime());};
      return h('div',{style:styles.list},[
        h('div',{key:'head',style:styles.row},[rowButton('上个月',()=>move(-1),{key:'prev'}),h('strong',{key:'month'},`${current.getFullYear()} 年 ${current.getMonth()+1} 月`),rowButton('下个月',()=>move(1),{key:'next'})]),
        h('div',{key:'week',style:{display:'grid',gridTemplateColumns:'repeat(7,minmax(0,1fr))'}},['一','二','三','四','五','六','日'].map(d=>h('div',{key:d,style:{padding:8,color:C.muted}},d))),
        h('div',{key:'grid',className:'hams-calendar'},Array.from({length:42},(_,index)=>{const d=new Date(start);d.setDate(start.getDate()+index);const key=dayKey(d);return h('div',{key,style:{minHeight:100,padding:7,border:'none',borderRadius:8,background:d.getMonth()===current.getMonth()?'transparent':C.tint}},[
          h('div',{key:'day',style:{fontSize:12,color:key===dayKey(Date.now())?C.accent:C.muted,fontWeight:600}},d.getDate()),
          ...events.filter(ev=>dayKey(ev.at)===key).map(ev=>rowButton(`${ev.kind} · ${ev.title}`,()=>onSelect(ev.itemId),{key:ev.id,style:{...styles.button(false),display:'block',width:'100%',fontSize:11,marginTop:5,textAlign:'left',whiteSpace:'normal',background:ev.kind==='复查'?withAlpha(C.warn,.14):C.soft},title:fmtTime(ev.at)})),
        ]);})),
        h('div',{key:'note',style:styles.muted},'日历以任务截止和复查计划原定时间为准。未安排日期的任务仍可在列表查看。'),
      ]);
    }
    function ItemsTab({ items, selected, onSelect, onAct, busy, onCreate, canAct, canCreate=true, evidenceForm, actionForm, templates, onCreateOpen, createOpen, onCreateCancel, projects=[], members=[], projectFilter='', onProjectFilter, checks=[], me, onClose, onCheck }) {
      const [view,setView]=React.useState('list'); const [q,setQ]=React.useState('');const [status,setStatus]=React.useState('');const [domain,setDomain]=React.useState('');const [mine,setMine]=React.useState(false);
      const visible=taskFilter(items,{q,status,domain,mine,project:projectFilter,me});
      const memberName=id=>(members.find(m=>m.id===id)||{}).name || id || '未分配';
      const card=item=>h('button',{key:item.id,type:'button',onClick:()=>onSelect(item.id),style:{...styles.item,background:selected && selected.id===item.id?C.tintStrong:'transparent',color:'inherit',textAlign:'left',width:'100%',cursor:'pointer',borderColor:'transparent'}},[
        h('div',{key:'title',style:styles.row},[h('strong',{key:'t'},item.title),statusBadge(item.status)]),
        h('div',{key:'meta',style:styles.muted},`${item.domain} · ${memberName(item.assignee_id || item.owner_human_id)} · P${item.priority || 3}`),
        item.status==='paused' ? h('div',{key:'paused',style:styles.muted},`最后更新 ${fmtTime(item.updated_at)} · 恢复后继续原流程`) : null,
        h('div',{key:'due',style:styles.muted},`下一步 ${fmtTime(item.next_action_at || item.due_at)}`),
      ]);
      /**
       * 列表视图：一行一条，五列固定宽度，行与行对齐（看板仍用上面的卡片）。
       * 列宽按最长内容预留：状态标签 84 / 标题弹性 / 处理人 140–168 / 优先级 56 / 截止 112–132。
       */
      const LIST_COLS='84px minmax(0,1fr) minmax(140px,168px) 56px minmax(112px,132px)';
      const who2=item=>{
        const id=item.assignee_id || item.owner_human_id;
        const member=members.find(m=>m.id===id);
        return {name:(member && member.name) || memberName(id),kind:member && member.kind};
      };
      const listHead=h('div',{key:'list-head',style:{display:'grid',gridTemplateColumns:LIST_COLS,gap:12,alignItems:'center',padding:'0 13px',color:C.muted,fontSize:11}},[
        h('span',{key:'s'},'状态'),h('span',{key:'t'},'任务'),h('span',{key:'o'},'处理人'),h('span',{key:'p'},'优先级'),h('span',{key:'d'},'截止'),
      ]);
      const listRow=item=>{
        const who=who2(item);
        const due=item.due_at || item.next_action_at;
        return h('button',{key:item.id,type:'button',onClick:()=>onSelect(item.id),style:{
          display:'grid',gridTemplateColumns:LIST_COLS,gap:12,alignItems:'center',width:'100%',boxSizing:'border-box',
          padding:'9px 10px',borderRadius:10,fontSize:12.5,minWidth:0,
          border:'none',
          background: selected && selected.id===item.id?C.tintStrong:'transparent',
          background:'transparent',color:'inherit',textAlign:'left',cursor:'pointer',
        }},[
          h('span',{key:'s',style:{justifySelf:'start',minWidth:0}},statusBadge(item.status)),
          h('span',{key:'t',title:item.title,style:{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500}},item.title),
          h('span',{key:'o',style:{display:'flex',alignItems:'center',gap:6,minWidth:0}},[
            avatar(who.name,22,who.kind),
            h('span',{key:'n',style:{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},who.name),
          ]),
          h('span',{key:'p',style:{fontVariantNumeric:'tabular-nums'}},`P${item.priority || 3}`),
          h('span',{key:'d',title:fmtTime(due),style:{color:C.muted,fontVariantNumeric:'tabular-nums',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},fmtDay(due)),
        ]);
      };
      const select=(label,value,change,rows)=>h('select',{'aria-label':label,style:styles.input,value,onChange:e=>change(e.target.value)},[h('option',{key:'all',value:''},label),...rows.map(([id,text])=>h('option',{key:id,value:id},text))]);
      // 新建工作项独立成页：提交或取消都回到列表
      if (createOpen) {
        return h(PMPage,{key:'task-create',backLabel:'← 返回任务列表',onBack:onCreateCancel || (()=>{}),crumb:'任务 / 新建工作项'},
          h(CreateForm,{key:'create',busy:busy || !canCreate,onSubmit:onCreate,onCancel:onCreateCancel,templates,projects,projectId:projectFilter}));
      }
      // 选中任务时，详情页占满整个页面（列表→详情→返回列表）
      if (selected) {
        return h(PMPage,{key:`task-${selected.id}`,backLabel:'← 返回任务列表',onBack:onClose || (()=>{}),crumb:`任务 / ${selected.title}`},
          h(TaskDetail,{key:selected.id,selected,onClose:null,onAct,busy,canAct,evidenceForm,actionForm,onCheck,members}));
      }
      return h('div',{style:styles.list},[
        h('div',{key:'toolbar',style:styles.row},[h('div',{key:'tabs',style:styles.tabs},[['list','列表'],['board','看板'],['calendar','日历']].map(([key,label])=>rowButton(label,()=>setView(key),{key,style:styles.tab(view===key),'aria-pressed':view===key}))),rowButton('新建工作项',onCreateOpen,{key:'new',disabled:busy || !canCreate,style:styles.button(true)})]),
        h('div',{key:'filters',style:{...styles.row,justifyContent:'flex-start'}},[
          h('input',{key:'search',style:styles.input,type:'search',value:q,onChange:e=>setQ(e.target.value),placeholder:'搜索标题、编号、资产','aria-label':'搜索任务'}),
          select('全部状态',status,setStatus,Object.entries(STATUS_LABEL)), select('全部业务域',domain,setDomain,[...new Set(items.map(i=>i.domain))].map(d=>[d,d])),
          select('全部项目',projectFilter,onProjectFilter || (()=>{}),projects.map(p=>[p.id,p.name])),
          h('label',{key:'mine',style:{display:'flex',gap:5}},[h('input',{key:'i',type:'checkbox',checked:mine,onChange:e=>setMine(e.target.checked)}),'只看我的']),h('span',{key:'count',style:styles.muted},`${visible.length} 条`),
        ]),
        view==='list' ? h('div',{key:'list',style:styles.list},visible.length?[listHead,...visible.map(listRow)]:h('div',{style:styles.empty},'没有符合条件的工作项')) : null,
        view==='board' ? h('div',{key:'board',className:'hams-board'},['ready','active','waiting_check','waiting_review','blocked'].map(column=>{const rows=visible.filter(item=>boardColumn(item)===column);return h('section',{key:column,style:{background:C.tint,borderRadius:10,padding:10,display:'flex',flexDirection:'column',gap:8,minWidth:185}},[
          h('strong',{key:'title',style:{fontSize:12,padding:4}},`${STATUS_LABEL[column]} · ${rows.length}`),...rows.map(card),!rows.length?h('div',{key:'empty',style:styles.empty},'暂无工作项'):null,
        ]);})) : null,
        view==='board' ? h('div',{key:'note',style:styles.muted},'已暂停卡保留在暂停前的列。已完成、失败与已取消可切到列表筛选查看。') : null,
        view==='calendar' ? h(TaskCalendar,{key:'calendar',items:visible,checks,onSelect}) : null,
      ]);
    }

    /** 阻塞原因按列取；没有就是 null。 */
    function blockedReason(item) {
      return item && item.blocked_reason ? item.blocked_reason : null;
    }

    function Field({ label, value, onChange, placeholder, type }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }, [
        h('span', { key: 'l', style: styles.muted }, label),
        h('input', {
          key: 'i',
          type: type || 'text',
          value,
          placeholder,
          style: styles.input,
          onChange: (event) => onChange(event.target.value),
        }),
      ]);
    }

    /** 需要一句话理由的动作：面板内填，不用 window.prompt（宿主 webview 不支持 prompt）。 */
    function ReasonForm({ label, busy, required, onSubmit, draftKey }) {
      const [reason, setReason] = useDraft(draftKey || 'reason:general', '');
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' } }, [
        h(Field, { key: 'r', label, value: reason, onChange: setReason, placeholder: '用来说明这一动作的原因' }),
        h('button', {
          key: 's', style: styles.button(true), disabled: busy || (required && !reason.trim()),
          onClick: () => onSubmit(reason.trim()),
        }, busy ? '提交中…' : '提交'),
      ]);
    }

    /** 人工建单：只要服务层要求的最小字段；绑一个已发布模板，单才关得掉。 */
    function CreateForm({ busy, onSubmit, onCancel, templates, projects = [], projectId: initialProjectId = '' }) {
      const [projectId, setProjectId] = useDraft(`task-create:${initialProjectId}:project`, initialProjectId);
      const [dueAt, setDueAt] = useDraft(`task-create:${initialProjectId}:due`, '');
      const pickable = (templates || []).filter((t) => t.published_version_id);
      const [domain, setDomain] = useDraft(`task-create:${initialProjectId}:domain`, '研究');
      const [category, setCategory] = useDraft(`task-create:${initialProjectId}:category`, '研究推进');
      const [title, setTitle] = useDraft(`task-create:${initialProjectId}:title`, '');
      const [priority, setPriority] = useDraft(`task-create:${initialProjectId}:priority`, '3');
      const [templateVersionId, setTemplateVersionId] = React.useState(pickable.length ? pickable[0].published_version_id : '');
      return h('div', { style: styles.card }, [
        h('strong', { key: 't' }, '新建工作项'),
        h('div', { key: 'g', style: styles.grid }, [
          h(Field, { key: 'd', label: '业务域', value: domain, onChange: setDomain }),
          h(Field, { key: 'c', label: '类别', value: category, onChange: setCategory }),
          h(Field, { key: 'p', label: '优先级（1 高–5 低）', value: priority, onChange: setPriority, type: 'number' }),
        ]),
        h('label', { key: 'project', style: styles.list }, [
          h('span', { key: 'l', style: styles.muted }, '所属项目'),
          h('select', { key: 's', style: styles.input, value: projectId, onChange: e => setProjectId(e.target.value), 'aria-label': '所属项目' }, [h('option', {key:'none',value:''}, '不关联项目'), ...projects.map(p => h('option', {key:p.id,value:p.id},p.name))]),
        ]),
        h(Field, {key:'due',label:'截止时间（可选）',type:'datetime-local',value:dueAt,onChange:setDueAt}),
        h(Field, { key: 'ti', label: '标题', value: title, onChange: setTitle, placeholder: '例如：给政策信号追踪补失败告警' }),
        h('label', { key: 'tp', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }, [
          h('span', { key: 'l', style: styles.muted }, '判据模板（决定要哪些证据、怎么复查、谁审批）'),
          h('select', {
            key: 's',
            style: styles.input,
            value: templateVersionId,
            onChange: (event) => setTemplateVersionId(event.target.value),
          }, [
            h('option', { key: '', value: '' }, pickable.length ? '（不绑定模板，将无法申请关单）' : '（还没有已发布模板）'),
            ...pickable.map((t) => h('option', { key: t.published_version_id, value: t.published_version_id },
              `${t.name} v${t.version} · ${t.domain}/${t.category}`)),
          ]),
        ]),
        h('div', { key: 'a', style: { display: 'flex', gap: 7 } }, [
          h('button', {
            key: 's', style: styles.button(true), disabled: busy || !title.trim(),
            onClick: () => onSubmit({
              domain, category, title: title.trim(), projectId: projectId || undefined, dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
              priority: Number(priority) || undefined,
              templateVersionId: templateVersionId || undefined,
            }),
          }, busy ? '提交中…' : '创建'),
          h('button', { key: 'c', style: styles.button(false), disabled: busy, onClick: onCancel }, '取消'),
        ]),
        h('div', { key: 'h', style: styles.muted },
          pickable.length
            ? '创建后为待处理，接单后开始执行。'
            : '尚无已发布的判据模板，创建后暂时无法申请关单。'),
      ]);
    }

    /** 加证据：类型 + 引用 + 说明，时间取现在。 */
    function EvidenceForm({ form, busy, onSubmit }) {
      const [kind, setKind] = useDraft(`evidence:${form.workItemId}:kind`, 'reading');
      const [ref, setRef] = useDraft(`evidence:${form.workItemId}:ref`, '');
      return h('div', { key: 'ef', style: { ...styles.card } }, [
        h('strong', { key: 't' }, '追加证据'),
        h('div', { key: 'g', style: styles.grid }, [
          h('label', { key: 'k', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }, [
            h('span', { key: 'l', style: styles.muted }, '类型'),
            h('select', {
              key: 's', value: kind, style: styles.input,
              onChange: (event) => setKind(event.target.value),
            }, ['reading', 'photo', 'receipt', 'log', 'doc'].map((k) => h('option', { key: k, value: k }, k))),
          ]),
          h(Field, { key: 'r', label: '引用（路径 / URL / 编号）', value: ref, onChange: setRef, placeholder: 'evidence/2026-11-14/bms.png' }),
        ]),
        h('button', {
          key: 's', style: styles.button(true), disabled: busy || !ref.trim(),
          onClick: () => onSubmit({ kind, ref: ref.trim(), observedAt: Date.now(), source: form && form.source }),
        }, busy ? '提交中…' : '提交证据'),
        h('div', { key: 'h', style: styles.muted }, '证据只追加；填错了要另起一条并注明替代关系，不能改旧行。'),
      ]);
    }

    function AttentionTab({ overview }) {
      if (!overview) return h('div', { style: styles.empty }, '加载中…');
      if (!overview.attention.length) return h('div', { style: styles.empty }, '没有需要人关注的事项');
      return h('ul', { style: styles.list }, overview.attention.map((item) =>
        h('li', { key: item.id, style: styles.item }, [
          h('div', { style: styles.row }, [h('span', { key: 'r' }, item.reason), badge('未解决', C.bad)]),
          h('div', { key: 'd', style: styles.muted }, item.detail),
          h('div', { key: 't', style: styles.muted }, fmtTime(item.createdAt)),
        ])));
    }

    const NAV = [
      ['overview', '总览'],
      ['projects', '项目'],
      ['tasks', '任务'],
      ['agents', '智能体'],
      ['knowledge', '知识'],
    ];

    // ── M6：项目 / 智能体 / 知识三屏 ────────────────────────────────────────
    // 三屏都只读后端真实数据：project/*、member/*、knowledge/*。
    // 空态不造假数据，直接给「下一步做什么」。

    const PROJECT_STATUS_LABEL = { draft: '草稿', active: '进行中', paused: '已暂停', archived: '已归档' };
    const MEMBER_KIND_LABEL = { human: '人', bot: 'bot' };
    const MEMBER_STATUS_LABEL = { active: '在岗', paused: '暂停', retired: '已退休' };
    const KNOWLEDGE_KIND_LABEL = { doc: '文档', skill: '技能', table: '数据表' };
    const KNOWLEDGE_STATUS_LABEL = { draft: '草稿', published: '已发布', archived: '已归档', retired: '已退役' };
    const BOT_CAPABILITIES = [
      ['work_item.create', '建工作项'],
      ['work_item.claim', '认领工作项'],
      ['work_item.execute', '执行'],
      ['work_item.request_closure', '申请关单'],
      ['evidence.append', '加证据'],
      ['check.evaluate', '复查判定'],
      ['proposal.create', '提议'],
      ['connector.ingest', '入站告警'],
      ['metric.record', '记指标读数'],
    ];

    function Chips({ items, color, empty }) {
      if (!items || !items.length) return h('span', { style: styles.muted }, empty || '—');
      return h('span', { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
        items.map((item) => h('span', { key: item, style: styles.badge(color || C.muted) }, item)));
    }

/* Plain JS fragment for the existing client factory. Replace ProjectCreateForm,
 * ProjectScreen, MemberScreen and MemberCreateForm; insert all PM* helpers once.
 * Shared React/h/styles/C/badge/fmtTime/ErrorBox/Chips/Stat/MetricRow are reused.
 * onCommand(command,payload): Promise<data>; reject on failure, refresh selected object
 * after writes; keep tryMetric read-only. Parent sets objectId + expectedRevision.
 */
const PM_CALCULATORS = [['manual_latest', '最近一条人工读数', 'manual'], ['work_item_count', '工作项数量', 'work_item'], ['work_item_completion_rate', '工作项完成率', 'work_item']];
const PM_PROJECT_TABS = [['goals', '目标与阶段'], ['work', '工作项'], ['memory', '记忆'], ['deliverables', '交付物'], ['reviews', '复盘历史']];
const PM_MEMORY_KINDS = [['fact', '事实'], ['decision', '决策'], ['preference', '偏好'], ['lesson', '教训'], ['capability', '能力']];
const PM_MEMORY_KIND_COLOR = { fact: C.muted, decision: C.accent, preference: C.warn, lesson: C.ok, capability: C.accent };
const PM_MEMORY_ORIGIN = { auto: '自动发现', manual: '手工记录', tool: 'bot 记录' };
function PMMemoryKindLabel(kind) { return (PM_MEMORY_KINDS.find(([key]) => key === kind) || [null, kind || '未知'])[1]; }
const PM_MEMBER_TABS = [['config', '配置'], ['skills', '技能'], ['memory', '记忆'], ['permissions', '权限'], ['versions', '版本历史'], ['runs', '运行历史']];
function PMAllowed(object, action) {
  return !!object && Array.isArray(object.allowedActions) && [action, `project/${action}`, `member/${action}`].some((key) => object.allowedActions.includes(key));
}
function PMParse(value, fallback) { if (typeof value !== 'string') return value == null ? fallback : value; try { return JSON.parse(value); } catch { return fallback; } }
function PMMetricVerdict(metric) {
  if (!metric.calculator_key || !metric.source_kind) return 'unknown';
  const value = metric.latest ? metric.latest.value : metric.actual_value !== undefined ? metric.actual_value : metric.value;
  const target = metric.target_value !== undefined ? metric.target_value : metric.targetValue;
  const max = metric.target_max !== undefined ? metric.target_max : metric.targetMax;
  if (value == null || target == null || !Number.isFinite(Number(value)) || !Number.isFinite(Number(target))) return 'unknown';
  if (metric.direction === 'range' && (max == null || !Number.isFinite(Number(max)))) return 'unknown';
  return (metric.direction === 'lower' ? Number(value) <= Number(target) : metric.direction === 'range' ? Number(value) >= Number(target) && Number(value) <= Number(max) : Number(value) >= Number(target)) ? 'met' : 'missed';
}
function PMFilterProjects(projects, filters) {
  const query = (filters.query || '').trim().toLocaleLowerCase();
  return (projects || []).filter((p) => (!query || [p.name, p.goal_text, p.owner_name, p.coordinator_name].some((v) => String(v || '').toLocaleLowerCase().includes(query))) && (!filters.type || p.type === filters.type) && (!filters.owner || p.owner_human_id === filters.owner) && (!filters.mine || p.needs_my_action === true || Number(p.pending_my_count) > 0));
}
function PMActivityDays(activity) {
  if (!activity || !Array.isArray(activity.days) || !activity.to) return [];
  const parsed = new Date(activity.to);
  if (!Number.isFinite(parsed.getTime())) return [];
  const end = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  const map = new Map(activity.days.map((day) => [String(day.day).slice(0, 10), day]));
  const startDate = activity.from ? new Date(activity.from) : null;
  const start = startDate && Number.isFinite(startDate.getTime()) ? startDate.toISOString().slice(0, 10) : null;
  return Array.from({ length: 84 }, (_, i) => {
    const day = new Date(end - (83 - i) * 86400000).toISOString().slice(0, 10);
    const raw = map.get(day);
    return { day, count: raw && Number.isFinite(Number(raw.count)) && Number(raw.count) >= 0 ? Number(raw.count) : start && day >= start ? 0 : null };
  });
}
function PMInput({ label, value, onChange, type, multiline, disabled, placeholder }) {
  return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 } }, [h('span', { key: 'l', style: styles.muted }, label), h(multiline ? 'textarea' : 'input', { key: 'i', 'aria-label': label, type: type || 'text', value: value == null ? '' : value, disabled, placeholder, style: { ...styles.input, ...(multiline ? { minHeight: 72, resize: 'vertical' } : {}) }, onChange: (e) => onChange(e.target.value) })]);
}
function PMSelect({ label, value, onChange, options, disabled }) {
  return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 } }, [h('span', { key: 'l', style: styles.muted }, label), h('select', { key: 's', 'aria-label': label, value: value || '', disabled, style: styles.input, onChange: (e) => onChange(e.target.value) }, options.map(([key, text]) => h('option', { key, value: key }, text)))]);
}
function PMButton({ children, onClick, disabled, primary, title, style }) {
  return h('button', { type: 'button', style: { ...styles.button(primary), ...(disabled ? { opacity: .45, cursor: 'not-allowed' } : {}), ...(style || {}) }, disabled, title: title || (disabled ? '当前状态、权限或必填信息不允许此操作' : undefined), onClick }, children);
}
function PMTabs({ tabs, value, onChange, label }) {
  return h('div', { role: 'tablist', 'aria-label': label, style: styles.tabStrip }, tabs.map(([key, text]) => h('button', { key, type: 'button', role: 'tab', 'aria-selected': value === key, style: styles.tab(value === key), onClick: () => onChange(key) }, text)));
}
function PMEmpty({ children }) { return h('div', { style: styles.empty }, children); }
// 整页外壳：顶部固定返回入口，下面是被查看/编辑的对象。列表 → 详情/新建 → 返回列表，四屏一致。
function PMPage({ backLabel, onBack, crumb, children }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }, [
    h('div', { key: 'back', style: { ...styles.row, justifyContent: 'flex-start', gap: 10 } }, [
      h(PMButton, { key: 'b', onClick: onBack || (() => {}) }, backLabel),
      crumb ? h('span', { key: 'c', style: styles.muted }, crumb) : null,
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}
function PMJson({ value }) { return h('pre', { style: { ...styles.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 } }, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function PMVerdict({ verdict }) { return badge({ met: '达标', missed: '未达标', unknown: '未知' }[verdict] || '未知', { met: C.ok, missed: C.warn, unknown: C.muted }[verdict] || C.muted); }
function usePMCommand(onCommand) {
  const [error, setError] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const guard = React.useRef(false);
  const execute = async (command, payload, after) => {
    if (!onCommand || guard.current) return;
    guard.current = true; setPending(true); setError(null);
    try { const result = await onCommand(command, payload); if (result && result.ok === false) throw result.error; if (after) after(result); return result; }
    catch (err) { setError({ code: err.code || 'COMMAND_FAILED', message: err.message || String(err), nextStep: err.nextStep || '保留填写内容，刷新对象后重试。' }); }
    finally { guard.current = false; setPending(false); }
  };
  return { error, pending, execute, dismiss: () => setError(null) };
}
function usePMDraft(key, initial) { return typeof useDraft === 'function' ? useDraft(key, initial) : React.useState(initial); }
function PMClearDraft(prefix) { if (typeof clearDraft === 'function') clearDraft(prefix); }
function PMBlankMetric() { return { name: '', direction: 'higher', targetValue: '', targetMax: '', unit: '', windowKind: 'week', calculatorKey: '', sourceRef: '', trial: null }; }
function PMMetricValid(row) { return !!row.name.trim() && (row.targetValue === '' || Number.isFinite(Number(row.targetValue))) && (row.direction !== 'range' || (row.targetValue !== '' && row.targetMax !== '' && Number.isFinite(Number(row.targetMax)) && Number(row.targetMax) >= Number(row.targetValue))); }
function PMMetricPayload(row) {
  return { name: row.name.trim(), direction: row.direction, targetValue: row.targetValue === '' ? null : Number(row.targetValue), targetMax: row.direction === 'range' && row.targetMax !== '' ? Number(row.targetMax) : null, unit: row.unit.trim() || null, windowKind: row.windowKind, calculatorKey: row.calculatorKey || undefined, calculatorParams: row.calculatorParams || {}, sourceKind: (PM_CALCULATORS.find(([key]) => key === row.calculatorKey) || [null, null, 'manual'])[2], sourceRef: row.sourceRef.trim() || undefined };
}
function PMMetricsEditor({ metrics, onChange, busy, onCommand, projectId, canTry }) {
  const state = usePMCommand(onCommand);
  const patch = (index, key, value) => onChange((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value, trial: null } : row));
  const locked = busy || state.pending;
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
    h('div', { key: 'head', style: styles.row }, [h('strong', { key: 't' }, `目标与证据来源（${metrics.length}/3）`), h(PMButton, { key: 'add', disabled: locked || metrics.length >= 3, onClick: () => onChange((rows) => [...rows, PMBlankMetric()]) }, metrics.length >= 3 ? '已达上限 3 个' : '添加目标')]),
    h(ErrorBox, { key: 'err', error: state.error, onDismiss: state.dismiss }),
    ...metrics.map((row, index) => h('section', { key: index, style: styles.card }, [
      h('div', { key: 'basic', style: styles.grid }, [h(PMInput, { key: 'n', label: '目标名称', value: row.name, onChange: (v) => patch(index, 'name', v), disabled: locked }), h(PMSelect, { key: 'd', label: '方向', value: row.direction, options: [['higher', '越高越好'], ['lower', '越低越好'], ['range', '区间']], onChange: (v) => patch(index, 'direction', v), disabled: locked }), h(PMInput, { key: 'v', label: row.direction === 'range' ? '目标下界' : '目标值', type: 'number', value: row.targetValue, onChange: (v) => patch(index, 'targetValue', v), disabled: locked }), row.direction === 'range' ? h(PMInput, { key: 'max', label: '目标上界', type: 'number', value: row.targetMax, onChange: (v) => patch(index, 'targetMax', v), disabled: locked }) : null, h(PMInput, { key: 'u', label: '单位', value: row.unit, onChange: (v) => patch(index, 'unit', v), disabled: locked })]),
      h('div', { key: 'source', style: styles.grid }, [h(PMSelect, { key: 'c', label: '预置计算方式', value: row.calculatorKey, options: [['', '未定义（未知）'], ...PM_CALCULATORS.map(([key, text]) => [key, text])], onChange: (v) => patch(index, 'calculatorKey', v), disabled: locked }), h(PMSelect, { key: 'w', label: '计算窗口', value: row.windowKind, options: [['day', '近 1 天'], ['week', '近 7 天'], ['month', '近 30 天'], ['snapshot', '时点快照']], onChange: (v) => patch(index, 'windowKind', v), disabled: locked }), row.calculatorKey === 'manual_latest' ? h(PMInput, { key: 'r', label: '人工读数来源引用', value: row.sourceRef, onChange: (v) => patch(index, 'sourceRef', v), disabled: locked }) : h('div', { key: 'r', style: styles.muted }, row.calculatorKey ? '数据来源：本项目真实工作项' : '尚未选择数据来源')]),
      h('div', { key: 'trial', role: 'status', style: styles.muted }, row.trial ? row.trial.complete && row.trial.value != null ? `试算值 ${row.trial.value}${row.unit} · ${row.trial.verdict === 'met' ? '达标' : row.trial.verdict === 'missed' ? '未达标' : '判定未知'} · ${fmtTime(row.trial.windowStart)} — ${fmtTime(row.trial.windowEnd)}` : `未知 · ${row.trial.reason || '缺少可计算数据，不参与达标率分母'}` : '尚未试算：缺数或口径未定义时保持未知，不参与达标率分母。'),
      h('div', { key: 'actions', style: { display: 'flex', gap: 8 } }, [h(PMButton, { key: 'try', disabled: locked || !onCommand || !canTry || !PMMetricValid(row) || !row.calculatorKey || (row.calculatorKey === 'manual_latest' && !row.sourceRef.trim()), onClick: () => { const signature = JSON.stringify(PMMetricPayload(row)); state.execute('project/tryMetric', { projectId, metric: PMMetricPayload(row) }, (trial) => onChange((rows) => rows.map((r, i) => i === index && JSON.stringify(PMMetricPayload(r)) === signature ? { ...r, trial: trial || { complete: false, reason: '接口未返回试算结果' } } : r))); } }, state.pending ? '试算中…' : '试算最近一期'), h(PMButton, { key: 'rm', disabled: locked, onClick: () => onChange((rows) => rows.filter((_, i) => i !== index)) }, '移除')]),
    ])),
    metrics.length ? null : h(PMEmpty, { key: 'empty' }, '尚未定义指标。可先保存草稿，之后发布新目标口径。'),
  ]);
}
function PMDraftMetricRow(metric) {
  return {
    name: metric.name || '', direction: metric.direction || 'higher',
    targetValue: metric.targetValue == null ? '' : String(metric.targetValue),
    targetMax: metric.targetMax == null ? '' : String(metric.targetMax),
    unit: metric.unit || '', windowKind: metric.windowKind || 'week',
    calculatorKey: metric.calculatorKey || '', calculatorParams: metric.calculatorParams || {},
    sourceKind: metric.sourceKind || 'manual', sourceRef: metric.sourceRef || '', trial: null,
  };
}
/** 新建向导：任何一步都能存草稿；草稿项目出现在项目列表里，点开继续填。 */
function ProjectCreateForm({ bots = [], draft = null, busy, onSubmit, onCancel, onCommand, onSaveDraft, onPublish, allowedActions = [] }) {
  const projectBots = bots.filter((b) => b.status === 'active');
  const defaultCoordinator = draft && draft.coordinatorId
    ? draft.coordinatorId
    : ((projectBots.find((b) => b.name === '项目管理') || {}).id || '');
  const prefix = 'pm/project-create/';
  const [step, setStep] = usePMDraft(prefix + 'step', draft && Number.isFinite(Number(draft.step)) ? Number(draft.step) : 0);
  const [name, setName] = usePMDraft(prefix + 'name', draft ? draft.name || '' : '');
  const [type, setType] = usePMDraft(prefix + 'type', draft ? draft.type || 'continuous' : 'continuous');
  const [goal, setGoal] = usePMDraft(prefix + 'goal', draft ? draft.goalText || '' : '');
  const [coordinatorId, setCoordinatorId] = usePMDraft(prefix + 'coordinatorId', defaultCoordinator);
  const [coordinatorTouched, setCoordinatorTouched] = React.useState(Boolean(draft && draft.coordinatorId));
  const [metrics, setMetrics] = usePMDraft(prefix + 'metrics', ((draft && draft.metrics) || []).map(PMDraftMetricRow));
  const [draftId, setDraftId] = React.useState((draft && draft.projectId) || null);
  const [savedAt, setSavedAt] = React.useState((draft && draft.savedAt) || null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const locked = busy || saving;
  const canCreate = PMAllowed({ allowedActions }, 'create');
  const steps = ['名称与类型', '目标与范围', '指标与证据', '验收人与把关点', '复盘节奏'];
  const valid = metrics.every(PMMetricValid);
  const payload = () => ({
    projectId: draftId || undefined, name: name.trim(), type, goalText: goal.trim(),
    // 没动过选择时把「用默认推进 bot」交给服务端；动过且清空才是显式「不指定」。
    coordinatorId: coordinatorId ? coordinatorId : coordinatorTouched ? null : undefined,
    metrics: metrics.map(PMMetricPayload), step,
  });
  const saveDraft = async () => {
    if (locked || !canCreate || !name.trim()) return;
    setSaving(true); setError(null);
    try {
      if (onSaveDraft) {
        const receipt = await onSaveDraft(payload());
        if (receipt && receipt.objectId) setDraftId(receipt.objectId);
      } else if (onCommand) {
        const receipt = await onCommand('project/saveDraft', payload());
        if (receipt && receipt.objectId) setDraftId(receipt.objectId);
      } else if (onSubmit) {
        onSubmit({ ...payload(), publish: false });
      }
      setSavedAt(Date.now());
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const publish = async () => {
    if (locked || !canCreate || !name.trim() || !goal.trim() || !valid) return;
    setSaving(true); setError(null);
    try {
      if (onPublish) await onPublish(payload());
      else if (onCommand) await onCommand('project/create', { ...payload(), publish: true });
      else if (onSubmit) onSubmit({ ...payload(), publish: true });
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const savedLabel = savedAt ? `草稿已保存 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '可随时保存草稿，下次从项目列表继续';
  return h('section', { style: styles.card }, [
    h('div', { key: 'h', style: styles.row }, [h('h2', { key: 't', style: styles.title }, draft ? '继续完善草稿' : '新建项目'), h('span', { key: 's', style: styles.muted }, `第 ${step + 1} 步，共 5 步 · ${savedLabel}`)]),
    h('ol', { key: 'steps', style: { ...styles.tabs, listStyle: 'none', paddingLeft: 0 } }, steps.map((label, i) => h('li', { key: label, style: { color: i === step ? C.accent : C.muted, fontWeight: i === step ? 600 : 400 } }, `${i < step ? '✓' : i + 1} ${label}`))),
    h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }),
    step === 0 ? h('div', { key: 's0', style: styles.grid }, [
      h(PMInput, { key: 'n', label: '项目名称', value: name, onChange: setName, disabled: locked }),
      h(PMSelect, { key: 'ty', label: '项目类型', value: type, onChange: setType, disabled: locked, options: [['continuous', '持续运营'], ['one_off', '一次性项目']] }),
      h(PMSelect, { key: 'co', label: '推进 bot', value: coordinatorId, onChange: (value) => { setCoordinatorTouched(true); setCoordinatorId(value); }, disabled: locked, options: [['', '不指定（由我推进）'], ...projectBots.map((b) => [b.id, b.name])] }),
    ]) : null,
    step === 0 ? h('span', { key: 'cohint', style: styles.muted }, '默认用「项目管理」bot 推进；改选别的 bot 或「不指定」都可以。') : null,
    step === 1 ? h(PMInput, { key: 's1', label: '项目目标与业务范围（从多少到多少、什么时候、靠什么）', multiline: true, value: goal, onChange: setGoal, disabled: locked }) : null,
    step === 2 ? h(PMMetricsEditor, { key: 's2', metrics, onChange: setMetrics, busy: locked, onCommand, canTry: canCreate }) : null,
    step === 3 ? h('div', { key: 's3', style: styles.card }, [h('strong', { key: 'h' }, '验收人与把关点'), h('p', { key: 'n', style: { margin: 0, lineHeight: 1.8 } }, '创建后在「阶段目标」中填写验收标准，指定阶段验收人；到期不会自动通过。每次发起复盘时单独指定确认人，未指定时使用项目负责人。')]) : null,
    step === 4 ? h('div', { key: 's4', style: styles.card }, [h('strong', { key: 'n' }, name || '未命名项目'), h('div', { key: 'g' }, goal || '尚未填写目标'), h('div', { key: 'm', style: styles.muted }, `${type === 'continuous' ? '持续运营' : '一次性项目'} · ${metrics.length} 个指标`), h('p', { key: 'r', style: { margin: 0, lineHeight: 1.8 } }, '创建后可手动发起周度、月度、季度或阶段复盘；每次冻结当期快照并等待确认。')]) : null,
    h('div', { key: 'footer', style: { ...styles.row, justifyContent: 'flex-start' } }, [
      h(PMButton, { key: 'prev', disabled: locked || step === 0, onClick: () => setStep(step - 1) }, '上一步'),
      h(PMButton, { key: 'draft', disabled: locked || !canCreate || !name.trim(), onClick: saveDraft }, saving ? '保存中…' : '保存草稿'),
      step < 4
        ? h(PMButton, { key: 'next', primary: true, disabled: locked || (step === 0 && !name.trim()) || (step === 1 && !goal.trim()) || (step === 2 && !valid), onClick: () => setStep(step + 1) }, `下一步：${steps[step + 1]}`)
        : h(PMButton, { key: 'publish', primary: true, disabled: locked || !canCreate || !name.trim() || !goal.trim() || !valid, onClick: publish }, saving ? '提交中…' : '创建并发布 v1'),
      h(PMButton, { key: 'cancel', disabled: locked, onClick: onCancel }, '取消'),
    ]),
    draftId ? h('span', { key: 'draftid', style: styles.muted }, '草稿项目已建立；返回项目列表可以从「草稿」继续。') : null,
    !canCreate ? h('span', { key: 'readonly', style: styles.muted }, '当前没有创建项目权限。') : null,
  ]);
}
function PMPhaseForm({ detail, humans, busy, execute, onCancel }) {
  const [name, setName] = usePMDraft(`pm/phase/${detail.id}/` + 'name', ''); const [start, setStart] = usePMDraft(`pm/phase/${detail.id}/` + 'start', ''); const [end, setEnd] = usePMDraft(`pm/phase/${detail.id}/` + 'end', '');
  const [description, setDescription] = usePMDraft(`pm/phase/${detail.id}/` + 'description', ''); const [verifier, setVerifier] = usePMDraft(`pm/phase/${detail.id}/` + 'verifier', ''); const [checks, setChecks] = usePMDraft(`pm/phase/${detail.id}/` + 'checks', '');
  return h('section', { style: styles.card }, [h('strong', { key: 'h' }, '新增阶段目标'),
    h('div', { key: 'g', style: styles.grid }, [h(PMInput, { key: 'n', label: '阶段名称', value: name, onChange: setName, disabled: busy }), h(PMInput, { key: 's', label: '开始时间', type: 'datetime-local', value: start, onChange: setStart, disabled: busy }), h(PMInput, { key: 'e', label: '结束时间', type: 'datetime-local', value: end, onChange: setEnd, disabled: busy }), h(PMSelect, { key: 'v', label: '验收人', value: verifier, onChange: setVerifier, disabled: busy, options: [['', '请选择'], ...humans.map((p) => [p.id, p.name])] })]),
    h(PMInput, { key: 't', label: '阶段目标与验收标准', multiline: true, value: description, onChange: setDescription, disabled: busy }), h(PMInput, { key: 'c', label: '检查项（每行一项）', multiline: true, value: checks, onChange: setChecks, disabled: busy }),
    h('div', { key: 'a', style: styles.row }, [h(PMButton, { key: 's', primary: true, disabled: busy || !PMAllowed(detail, 'createPhase') || !name.trim() || !description.trim() || !verifier || !start || !end || new Date(end) < new Date(start), onClick: () => execute('project/createPhase', { projectId: detail.id, name: name.trim(), startsAt: new Date(start).getTime(), endsAt: new Date(end).getTime(), confirmerId: verifier, targets: [{ description: description.trim(), verifierHumanId: verifier }], checks: checks.split('\n').map((v) => v.trim()).filter(Boolean) }, () => { PMClearDraft(`pm/phase/${detail.id}/`); onCancel(); }) }, '创建阶段'), h(PMButton, { key: 'c', disabled: busy, onClick: onCancel }, '取消')])]);
}
function PMReviewForm({ detail, humans, busy, execute, onCancel }) {
  const [kind, setKind] = usePMDraft(`pm/review/${detail.id}/` + 'kind', 'monthly'); const [start, setStart] = usePMDraft(`pm/review/${detail.id}/` + 'start', ''); const [end, setEnd] = usePMDraft(`pm/review/${detail.id}/` + 'end', '');
  const [conclusion, setConclusion] = usePMDraft(`pm/review/${detail.id}/` + 'conclusion', ''); const [confirmer, setConfirmer] = usePMDraft(`pm/review/${detail.id}/` + 'confirmer', '');
  return h('section', { style: styles.card }, [h('strong', { key: 'h' }, '发起复盘 · 冻结当期快照'),
    h('div', { key: 'g', style: styles.grid }, [h(PMSelect, { key: 'k', label: '复盘类型', value: kind, onChange: setKind, disabled: busy, options: [['weekly', '周度'], ['monthly', '月度'], ['quarterly', '季度'], ['phase', '阶段']] }), h(PMInput, { key: 's', label: '周期开始', value: start, type: 'datetime-local', onChange: setStart, disabled: busy }), h(PMInput, { key: 'e', label: '周期结束', value: end, type: 'datetime-local', onChange: setEnd, disabled: busy }), h(PMSelect, { key: 'c', label: '确认人', value: confirmer, onChange: setConfirmer, disabled: busy, options: [['', '当前项目负责人'], ...humans.map((p) => [p.id, p.name])] })]),
    h(PMInput, { key: 't', label: '复盘结论', multiline: true, value: conclusion, onChange: setConclusion, disabled: busy }),
    end && new Date(end).getTime() > Date.now() ? h('span', { key: 'future', style: { color: C.warn } }, '复盘结束时间不能晚于现在，请选择已发生的周期。') : null,
    h('div', { key: 'a', style: styles.row }, [h(PMButton, { key: 's', primary: true, disabled: busy || !PMAllowed(detail, 'createReview') || !start || !end || new Date(end) < new Date(start) || new Date(end).getTime() > Date.now(), onClick: () => execute('project/createReview', { projectId: detail.id, kind, periodStart: new Date(start).getTime(), periodEnd: new Date(end).getTime(), conclusionText: conclusion.trim(), confirmerId: confirmer || undefined }, () => { PMClearDraft(`pm/review/${detail.id}/`); onCancel(); }) }, '冻结快照并待确认'), h(PMButton, { key: 'c', disabled: busy, onClick: onCancel }, '取消')])]);
}
function PMTargetForm({ detail, busy, onCommand, execute, onCancel }) {
  const [goal, setGoal] = usePMDraft(`pm/target/${detail.id}/` + 'goal', detail.goal_text || '');
  const [metrics, setMetrics] = usePMDraft(`pm/target/${detail.id}/` + 'metrics', (detail.metrics || []).map((m) => ({ name: m.name, direction: m.direction, targetValue: m.target_value == null ? '' : String(m.target_value), targetMax: m.target_max == null ? '' : String(m.target_max), unit: m.unit || '', windowKind: m.window_kind || 'week', calculatorKey: m.calculator_key || '', calculatorParams: PMParse(m.calculator_params_json, {}), sourceRef: m.source_ref || '', trial: null })));
  return h('section', { style: styles.card }, [h('strong', { key: 'h' }, '发布新目标版本'), h(PMInput, { key: 'g', label: '目标说明（立项项目书的第一段）', value: goal, onChange: setGoal, multiline: true, disabled: busy }), h(PMMetricsEditor, { key: 'm', metrics, onChange: setMetrics, busy, onCommand, projectId: detail.id, canTry: PMAllowed(detail, 'publishTarget') }), h('div', { key: 'a', style: styles.row }, [h(PMButton, { key: 's', primary: true, disabled: busy || !PMAllowed(detail, 'publishTarget') || !goal.trim() || !metrics.every(PMMetricValid), onClick: () => execute('project/publishTarget', { projectId: detail.id, goalText: goal.trim(), metrics: metrics.map(PMMetricPayload) }, () => { PMClearDraft(`pm/target/${detail.id}/`); onCancel(); }) }, '发布新版本'), h(PMButton, { key: 'c', disabled: busy, onClick: onCancel }, '取消')]), h('span', { key: 'n', style: styles.muted }, '当前版本和既有复盘保留原口径。')]);
}
function PMWorkList({ items = [], onOpen }) {
  const labels = { ready: '待处理', active: '执行中', waiting_check: '待复查', waiting_review: '待验收', blocked: '阻塞', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' };
  if (!items.length) return h(PMEmpty, null, '还没有关联工作项');
  // 一行一条，列宽固定，和任务列表同一套读法：状态 / 名称 / 更新时间 / 下一步 / 截止。
  const cols = '84px minmax(0,1fr) 116px 116px 108px';
  const cell = (key, text, extra) => h('span', { key, title: extra && extra.title, style: { color: C.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', ...(extra && extra.style) } }, text);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, [
    h('div', { key: 'hdr', style: { display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '0 11px', color: C.muted, fontSize: 11 } }, [
      h('span', { key: 's' }, '状态'), h('span', { key: 't' }, '任务名称'), h('span', { key: 'u' }, '更新时间'), h('span', { key: 'n' }, '下一步工作'), h('span', { key: 'd' }, '截止时间'),
    ]),
    ...items.map((item) => {
      // 已指派但超过 90 秒还没被派发器认领：把「卡住」显式画出来，而不是一直显示“待处理”。
      const waitingDispatch = item.status === 'ready' && item.assignee_id && Date.now() - Number(item.updated_at || 0) > 90_000;
      return h('div', {
      key: item.id,
      style: { display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center', padding: '8px 10px', border: 'none', borderRadius: 10, background: C.tint, fontSize: 12.5, minWidth: 0 },
    }, [
      h('span', { key: 's', style: { justifySelf: 'start' } }, badge(labels[item.status] || item.status, STATUS_COLOR[item.status])),
      onOpen ? h('button', {
        key: 't', type: 'button', title: item.title, onClick: () => onOpen(item.id),
        style: { textAlign: 'left', padding: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, font: 'inherit' },
      }, item.title) : h('strong', { key: 't', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
      cell('u', fmtDay(item.updated_at)),
      waitingDispatch
        ? cell('n', '等待派发', { title: '已指派，但派发器还没认领；若长时间不动，重启 DSH 或查看派发器日志', style: { color: C.warn } })
        : cell('n', item.next_action_at ? fmtDay(item.next_action_at) : '—'),
      cell('d', item.due_at ? fmtDay(item.due_at) : '—'),
    ]);
    }),
  ]);
}
/** 宿主能力目录：agent preset 与模型。拿不到就退回手填，不阻塞配置。 */
function useHostCatalog() {
  const [catalog, setCatalog] = React.useState({ available: false, presets: [], models: [], reason: '' });
  React.useEffect(() => {
    let alive = true;
    call('host/catalog', { payload: {} })
      .then((data) => { if (alive) setCatalog(data || { available: false, presets: [], models: [] }); })
      .catch((err) => { if (alive) setCatalog({ available: false, presets: [], models: [], reason: err.message || '读不到宿主目录' }); });
    return () => { alive = false; };
  }, []);
  return catalog;
}

/** 模型/宿主 preset：有目录就下拉，没有就退回手填（老实例没有接 agents 服务时也能编辑配置）。 */
function ModelSelect({ catalog, value, onChange, disabled, labelKeys }) {
  const models = (catalog && catalog.models) || [];
  const curated = models.map((row) => [row.provider ? `${row.provider}/${row.model}` : row.model, row.label || row.model]);
  if (!curated.length) return h(PMInput, { label: labelKeys.model, value: value || '', onChange, disabled, placeholder: '留空 = 跟随宿主默认模型' });
  // 当前配置可能写的是裸模型名（宿主允许），目录里对不上时也要如实显示，而不是悄悄回落成默认。
  const options = value && !curated.some(([option]) => option === value) ? [[value, `${value}（当前配置）`], ...curated] : curated;
  return h(PMSelect, { label: labelKeys.model, value: value || '', onChange, disabled, options: [['', '跟随宿主默认模型'], ...options] });
}
function PresetSelect({ catalog, value, onChange, disabled }) {
  const presets = ((catalog && catalog.presets) || []).filter((row) => row && row.id);
  if (!presets.length) return h(PMInput, { label: 'Agent preset', value: value || '', onChange, disabled, placeholder: '留空 = hams-bot' });
  const known = presets.some((row) => row.id === value);
  return h(PMSelect, {
    label: 'Agent preset',
    value: known ? value : '',
    onChange,
    disabled,
    options: [['', '默认（hams-bot）'], ...presets.map((row) => [row.id, `${row.name || row.id}${row.broken ? '（不可用）' : ''}`])],
  });
}

/** 行内 Markdown：`code` / **粗** / *斜* / [文字](https 链接)。其余原样保留。 */
function mdInline(text, keyBase) {
  const source = String(text == null ? '' : text);
  const nodes = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0; let match; let index = 0;
  while ((match = pattern.exec(source))) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const token = match[0]; const key = `${keyBase}-i${index++}`;
    if (token.startsWith('`')) nodes.push(h('code', { key, style: { padding: '1px 4px', borderRadius: 4, background: C.soft, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 } }, token.slice(1, -1)));
    else if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
    else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\((https?:[^)]+)\)$/.exec(token);
      nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener', style: { color: C.accent, textDecoration: 'underline' } }, link[1]));
    }
    last = match.index + token.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

/**
 * 极简 Markdown 渲染：代码块、标题、有序/无序列表、引用、分隔线 + 行内样式。
 * 不引入外部库（客户端是手写模块），也不拼接 HTML（消息来自模型，避免 XSS）。
 */
function Markdown({ text }) {
  const source = String(text == null ? '' : text);
  const lines = source.split('\n');
  const blocks = [];
  let buffer = [];
  let i = 0;
  const key = (suffix) => `md-${blocks.length}-${suffix}`;
  const flush = () => {
    if (!buffer.length) return;
    blocks.push(h('div', { key: key('p'), style: { whiteSpace: 'pre-wrap' } }, mdInline(buffer.join('\n'), key('p'))));
    buffer = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1 }
      i += 1;
      blocks.push(h('pre', { key: key('c'), style: { margin: 0, padding: '8px 10px', background: C.soft, border: 'none', borderRadius: 8, overflowX: 'auto', fontSize: 11.5, lineHeight: 1.6 } },
        h('code', null, code.join('\n'))));
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i += 1; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      flush();
      const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : 'left';
      });
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(splitRow(lines[i])); i += 1 }
      const cellStyle = { border: 'none', padding: '6px 9px', verticalAlign: 'top', textAlign: 'left' };
      blocks.push(h('div', { key: key('tbl'), style: { overflowX: 'auto', minWidth: 0 } },
        h('table', { style: { borderCollapse: 'collapse', width: '100%', minWidth: 360, fontSize: 11.5, lineHeight: 1.6 } }, [
          h('thead', { key: 'th' }, h('tr', null, header.map((cell, index) => h('th', {
            key: `th-${index}`,
            style: { ...cellStyle, textAlign: aligns[index] || 'left', background: C.tintStrong, fontWeight: 600, whiteSpace: 'nowrap', borderRadius: 6 },
          }, mdInline(cell, `th-${index}`))))),
          h('tbody', { key: 'tb' }, body.map((cells, rowIndex) => h('tr', { key: `tr-${rowIndex}` },
            cells.map((cell, index) => h('td', { key: `td-${rowIndex}-${index}`, style: { ...cellStyle, textAlign: aligns[index] || 'left', background: rowIndex % 2 ? C.tint : 'transparent' } }, mdInline(cell, `td-${rowIndex}-${index}`)))))),
        ])));
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      flush();
      const depth = line.match(/^#+/)[0].length;
      blocks.push(h(depth <= 2 ? 'h3' : 'h4', { key: key('h'), style: { margin: 0, fontSize: depth <= 2 ? 13.5 : 12.5, fontWeight: 650 } }, mdInline(line.replace(/^#+\s+/, ''), key('h'))));
      i += 1; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i += 1 }
      blocks.push(h('ul', { key: key('ul'), style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 } },
        items.map((item, index) => h('li', { key: `${key('ul')}-${index}` }, mdInline(item, `${key('ul')}-${index}`)))));
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i += 1 }
      blocks.push(h('ol', { key: key('ol'), style: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 } },
        items.map((item, index) => h('li', { key: `${key('ol')}-${index}` }, mdInline(item, `${key('ol')}-${index}`)))));
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push(h('blockquote', { key: key('q'), style: { margin: 0, padding: '6px 10px', border: 'none', borderRadius: 6, background: C.tint, color: C.muted } }, mdInline(quote.join('\n'), key('q'))));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push(h('div', { key: key('hr'), style: { height: 8 } }));
      i += 1; continue;
    }
    buffer.push(line); i += 1;
  }
  flush();
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.75 } }, blocks);
}

/** 聊天里的一条消息：靠左、无气泡；名字 + 时间在上，正文按 Markdown 渲染。 */
function ChatRow({ name, at, note, text }) {
  const time = at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, padding: '12px 0' } }, [
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } }, [
      h('strong', { key: 'n', style: { fontSize: 12, fontWeight: 600 } }, name),
      time ? h('span', { key: 't', style: { ...styles.muted, fontSize: 10.5 } }, time) : null,
      note ? h('span', { key: 'x', style: { ...styles.muted, fontSize: 11, color: C.accent } }, note) : null,
    ]),
    h('div', { key: 'b', style: { minWidth: 0, paddingLeft: 14 } }, h(Markdown, { text })),
  ]);
}

/**
 * 对话面板：单聊（kind=member）与项目群聊（kind=project）。
 * 消息正文在宿主会话里，这里轮询读；HAMS 只存会话指针。
 */
function ChatPane({ kind, targetId, title }) {
  const [data, setData] = React.useState(null);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState(null);
  const [sending, setSending] = React.useState(false);
  const alive = React.useRef(true);
  const scroller = React.useRef(null);

  const poll = React.useCallback(async () => {
    try {
      const next = await call('chat/messages', { payload: { kind, targetId } });
      if (alive.current) { setData(next); setError(null); }
    } catch (err) {
      if (alive.current) setError(err);
    }
  }, [kind, targetId]);

  React.useEffect(() => {
    alive.current = true;
    setData(null); setError(null); setText('');
    let timer = null;
    const start = async () => {
      try { await call('chat/open', { payload: { kind, targetId } }); }
      catch (err) { if (alive.current) setError(err); }
      if (!alive.current) return;
      await poll();
      if (alive.current) timer = setInterval(poll, 1500);
    };
    start();
    return () => { alive.current = false; if (timer) clearInterval(timer); };
  }, [kind, targetId]);

  // 只有本来就在底部时才跟随新消息；往上翻看历史时不能被拽回去。
  const stick = React.useRef(true);
  const onListScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };
  React.useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true); setError(null);
    try {
      await call('chat/send', { payload: { kind, targetId, text: value } });
      setText('');
      await poll();
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    setError(null);
    try { await call('chat/stop', { payload: { kind, targetId } }); await poll(); }
    catch (err) { setError(err); }
  };

  const messages = (data && data.messages) || [];
  const running = Boolean(data && data.running);
  const available = !data || data.available !== false;
  const thread = data && data.thread;

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, padding: '2px 0' } }, [
    h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, kind === 'project' ? '项目群聊' : '单聊'),
      h('span', { key: 'w', style: { ...styles.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        thread ? (kind === 'project' ? `回答：${thread.memberName} · 会话 ${thread.sessionId.slice(0, 18)}` : `会话 ${thread.sessionId.slice(0, 18)}`) : '建立会话…'),
      running ? h('span', { key: 'run', style: { ...styles.muted, color: C.warn } }, '运行中…') : null,
      running ? h(PMButton, { key: 'stop', onClick: stop }, '停止') : null,
    ]),
    error ? h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }) : null,
    !available ? h('div', { key: 'na', style: styles.notice }, data && data.reason ? data.reason : '宿主没有提供 agent 会话服务') : null,
    data && data.error ? h('div', { key: 'turnError', style: { ...styles.notice, color: '#B42318', background: 'rgba(224,49,49,.08)' } }, `这一轮没跑起来：${data.error}`) : null,
    h('div', { key: 'list', ref: scroller, onScroll: onListScroll, style: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 260, maxHeight: 'calc(100vh - 380px)', overflowY: 'auto', padding: '8px 16px', border: 'none', borderRadius: 12, background: 'transparent' } },
      messages.length ? messages.map((message) => h(ChatRow, {
        key: message.id,
        name: message.role === 'user' ? '你' : ((thread && thread.memberName) || 'bot'),
        at: message.at,
        text: message.text,
      })) : h('div', { key: 'empty', style: { ...styles.muted, padding: '12px 4px' } }, '还没有消息。交代一件事，这个 bot 会在自己的工作目录里推进。')),
    h('div', { key: 'compose', style: { display: 'flex', gap: 8, alignItems: 'flex-end' } }, [
      h('textarea', {
        key: 'i',
        value: text,
        'aria-label': kind === 'project' ? '给项目群聊发消息' : '给智能体发消息',
        placeholder: available ? (kind === 'project' ? '对这个项目说点什么…' : '对这个 bot 说点什么…') : '宿主会话服务不可用，发不出去',
        disabled: !available || sending,
        rows: 2,
        style: { ...styles.input, flex: '1 1 auto', minWidth: 0, resize: 'vertical', minHeight: 44, lineHeight: 1.6 },
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } },
      }),
      h(PMButton, { key: 'send', primary: true, disabled: !available || sending || !text.trim(), onClick: send }, sending ? '发送中…' : '发送'),
    ]),
  ]);
}

/**
 * 项目群聊：多人多会话。推进 bot 是指挥，其他成员被 @ 后在自己的会话里回答；
 * 所有发言都合并进 HAMS 的 project_message，界面只读这一份记录。
 */
function GroupChatPane({ projectId, title, bots = [] }) {
  const [data, setData] = React.useState(null);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState(null);
  const [sending, setSending] = React.useState(false);
  const scroller = React.useRef(null);

  const poll = React.useCallback(async () => {
    try {
      const next = await call('chat/group/messages', { payload: { projectId } });
      setData(next); setError(null);
    } catch (err) { setError(err); }
  }, [projectId]);

  React.useEffect(() => {
    let alive = true; let timer = null;
    const start = async () => {
      await poll();
      timer = setInterval(() => { if (alive) poll(); }, 2000);
    };
    start();
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [projectId]);

  // 只有本来就在底部时才跟随新消息；往上翻看历史时不能被拽回去。
  const stick = React.useRef(true);
  const onListScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };
  React.useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true); setError(null);
    try {
      await call('chat/group/send', { payload: { projectId, text: value } });
      setText('');
      await poll();
    } catch (err) { setError(err); } finally { setSending(false); }
  };

  const messages = (data && data.messages) || [];
  const coordinator = data && data.coordinator;
  const members = (data && data.members) || [];
  const running = Boolean(data && data.running);
  const available = !data || data.available !== false;
  const authorColor = (message) => message.authorKind === 'human' ? C.accent : '#fff';
  const authorText = (message) => message.authorKind === 'human' ? '#fff' : 'inherit';
  const mentionables = [coordinator, ...members].filter((row) => row && row.status === 'active');
  const addMention = (name) => setText((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${name} `);

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, padding: '2px 0' } }, [
    h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, '项目群聊'),
      h('span', { key: 'w', style: { ...styles.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        data === null ? (error ? '读取失败：见下方原因' : '加载中…') : coordinator ? `推进：${coordinator.name} · 团队 ${members.length + 1} 人` : '这个项目还没有推进 bot'),
      running ? h('span', { key: 'run', style: { ...styles.muted, color: C.warn } }, '运行中…') : null,
    ]),
    error ? h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }) : null,
    data && data.error ? h('div', { key: 'turnError', style: { ...styles.notice, color: '#B42318', background: 'rgba(224,49,49,.08)' } }, `这一轮没跑起来：${data.error}`) : null,
    !available ? h('div', { key: 'na', style: styles.notice }, data && data.reason ? data.reason : '宿主没有提供 agent 会话服务') : null,
    h('div', { key: 'list', ref: scroller, onScroll: onListScroll, style: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 280, maxHeight: 'calc(100vh - 400px)', overflowY: 'auto', padding: '8px 16px', border: 'none', borderRadius: 12, background: 'transparent' } },
      messages.length ? messages.map((message) => {
        const target = message.toMemberId ? ([...(members || []), coordinator].find((m) => m && m.memberId === message.toMemberId) || {}).name : null;
        // 正文里已经写了 @名字 时不再重复标一次；只有旧数据依赖 toMemberId 时才补标记。
        const note = message.kind === 'mention' && !(target && String(message.text).startsWith(`@${target}`)) ? `@${target || '成员'}` : null;
        return h(ChatRow, {
          key: message.id,
          name: message.authorName,
          at: message.at,
          note,
          text: message.text,
        });
      }) : h('div', { key: 'empty', style: { ...styles.muted, padding: '12px 4px' } },
        '还没有消息。说点什么，推进 bot 会拆任务、@ 团队成员、把进展带回来。')),
    mentionables.length ? h('div', { key: 'mentions', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } }, [
      h('span', { key: 'l', style: { ...styles.muted, fontSize: 11 } }, '点名排查：'),
      ...mentionables.map((row) => h(PMButton, { key: row.memberId, disabled: sending, onClick: () => addMention(row.name), title: `在消息里 @${row.name}` }, `@${row.name}`)),
    ]) : null,
    h('div', { key: 'compose', style: { display: 'flex', gap: 8, alignItems: 'flex-end' } }, [
      h('textarea', {
        key: 'i', value: text, 'aria-label': '给项目群聊发消息',
        placeholder: available ? '对项目说点什么；@某个 bot 可以直接点名它去排查…' : '宿主会话服务不可用，发不出去',
        disabled: !available || sending, rows: 2,
        style: { ...styles.input, flex: '1 1 auto', minWidth: 0, resize: 'vertical', minHeight: 44, lineHeight: 1.6 },
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } },
      }),
      h(PMButton, { key: 'send', primary: true, disabled: !available || sending || !text.trim(), onClick: send }, sending ? '发送中…' : '发送'),
    ]),
  ]);
}

/** 团队页签：推进 bot + 手动加入的常驻 bot + 项目内临时 bot。三列对齐：成员 / 职责 / 操作。 */
function PMTeamTab({ project, bots = [], onOpenMember }) {
  const [team, setTeam] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [pick, setPick] = React.useState('');
  const [name, setName] = React.useState('');
  const [brief, setBrief] = React.useState('');

  const load = React.useCallback(async () => {
    try { setTeam(await call('chat/team', { payload: { projectId: project.id } })); setError(null); }
    catch (err) { setError(err); }
  }, [project.id]);
  // 团队页要跟得上 bot 新起的子代理：5 秒轮询一次（查询很轻，只读成员/会话状态）。
  React.useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [load]);

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); return true; } catch (err) { setError(err); return false; } finally { setBusy(false); }
  };

  const coordinator = (team && team.coordinator) || null;
  const members = (team && team.members) || [];
  const joined = new Set([...(coordinator ? [coordinator.memberId] : []), ...members.map((row) => row.memberId)]);
  const candidates = (bots || []).filter((bot) => bot.kind === 'bot' && bot.status === 'active' && !joined.has(bot.id));
  const columns = 'minmax(190px, 1.1fr) minmax(0, 1.8fr) 76px 132px';

  const memberCell = (member) => h('div', { key: 'm', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, whiteSpace: 'nowrap' } }, [
    badge(member.kind === 'coordinator' ? '推进' : member.kind === 'subagent' ? '子代理' : member.kind === 'temp' ? '临时' : '成员', member.kind === 'coordinator' ? C.accent : member.kind === 'subagent' ? C.ok : member.kind === 'temp' ? C.warn : C.muted),
    h('strong', { key: 'n', style: { fontSize: 12.5, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, member.name),
    member.status !== 'active' ? h('span', { key: 's', style: { ...styles.muted, fontSize: 11 } }, member.status) : null,
    member.running ? h('span', { key: 'r', style: { ...styles.muted, color: C.warn, fontSize: 11 } }, '运行中') : null,
  ]);

  const openMember = (member) => {
    if (typeof onOpenMember === 'function') { onOpenMember(member.memberId, 'config'); return; }
    // 兜底：宿主老版本没把回调传进来时，走深链接整页打开成员配置。
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('hamsView', 'agents');
      url.searchParams.set('hamsMember', member.memberId);
      window.location.assign(url.toString());
    } catch (err) { console.error('[hams] 打开成员失败：', err); }
  };
  const row = (member) => h('div', {
    key: member.memberId,
    role: onOpenMember ? 'button' : undefined,
    tabIndex: onOpenMember ? 0 : undefined,
    title: onOpenMember ? '打开成员详情：看配置、改提示词（临时 bot 也能改）' : member.brief || '',
    onClick: onOpenMember ? () => openMember(member) : undefined,
    onKeyDown: onOpenMember ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMember(member); } } : undefined,
    style: { display: 'grid', gridTemplateColumns: columns, alignItems: 'center', gap: 12, padding: '10px 2px', border: 'none', borderRadius: 10, background: 'transparent', minWidth: 0, cursor: onOpenMember ? 'pointer' : 'default' },
  }, [
    memberCell(member),
    h('span', { key: 'd', title: member.brief || '', style: { ...styles.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, member.brief || '—'),
    h('div', { key: 'st', style: { display: 'flex', justifyContent: 'flex-start' } },
      member.status !== 'active'
        ? badge({ paused: '暂停', retired: '已退休' }[member.status] || member.status, C.muted)
        : member.running
          ? badge('运行中', C.ok)
          : badge('空闲', C.muted)),
    h('div', { key: 'a', style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } }, [
      h(PMButton, { key: 'view', disabled: busy, onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); openMember(member); } }, '查看'),
      member.kind === 'coordinator' || member.kind === 'subagent' ? null : h(PMButton, { key: 'x', disabled: busy, onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); run(() => call('chat/team/remove', { payload: { projectId: project.id, memberId: member.memberId } })); } }, '移出'),
    ]),
  ]);

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } }, [
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, '团队'),
      h('span', { key: 'd', style: { ...styles.muted, minWidth: 0 } }, '推进 bot 指挥；成员被 @ 时在自己的会话里回答；临时 bot 只属于这个项目；子代理由 bot 的 subagent 调用自动登记。'),
      h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
      h(PMButton, { key: 'add', primary: true, disabled: busy, onClick: () => setAddOpen((open) => !open) }, addOpen ? '收起' : '+ 成员'),
    ]),
    error ? h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }) : null,
    addOpen ? h('div', { key: 'addPanel', style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0', border: 'none', borderRadius: 10, background: 'transparent' } }, [
      h('div', { key: 'pull', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
        h('span', { key: 'l', style: { fontSize: 12 } }, '拉一个在岗 bot 进群'),
        h('select', {
          key: 's', 'aria-label': '选择要加入群聊的 bot', value: pick, disabled: busy,
          style: { ...styles.input, maxWidth: 260 }, onChange: (event) => setPick(event.target.value),
        }, [h('option', { key: '', value: '' }, '选择 bot'), ...candidates.map((bot) => h('option', { key: bot.id, value: bot.id }, bot.name))]),
        h(PMButton, { key: 'go', disabled: busy || !pick, onClick: async () => { if (await run(() => call('chat/team/add', { payload: { projectId: project.id, memberId: pick } }))) { setPick(''); setAddOpen(false); } } }, '加入'),
      ]),
      h('div', { key: 'spawn', style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } }, [
        h('div', { key: 'n', style: { maxWidth: 200 } }, h(PMInput, { label: '临时 bot 名字', value: name, onChange: setName, placeholder: '如：因子核验员' })),
        h('div', { key: 'b', style: { maxWidth: 360 } }, h(PMInput, { label: '职责（一句话）', value: brief, onChange: setBrief, placeholder: '只查这一周的因子' })),
        h(PMButton, { key: 'go', disabled: busy || !name.trim(), onClick: async () => { if (await run(() => call('chat/team/spawn', { payload: { projectId: project.id, name: name.trim(), brief: brief.trim() } }))) { setName(''); setBrief(''); setAddOpen(false); } } }, '创建临时 bot'),
      ]),
      h('span', { key: 'hint', style: styles.muted }, '临时 bot 由你创建、只属于本项目；推进 bot 自己也可以建（hams_group_spawn_bot）。bot 用 subagent 起的子代理会自动登记为「子代理」，跑完也留在这里可追溯。'),
    ]) : null,
    h('div', { key: 'cols', style: { display: 'grid', gridTemplateColumns: columns, gap: 12, padding: '0 12px', ...styles.muted, fontSize: 11 } }, [
      h('span', { key: 'c1' }, '成员'), h('span', { key: 'c2' }, '职责'), h('span', { key: 'c3' }, '状态'), h('span', { key: 'c4', style: { textAlign: 'right' } }, '操作'),
    ]),
    h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
      coordinator ? row(coordinator) : h('div', { key: 'noc', style: styles.notice }, '这个项目还没有推进 bot，群聊没有指挥者。'),
      ...members.map(row),
    ]),
  ]);
}

/**
 * 交付物：项目推进过程中 bot 在工作项目录里产出的文件。
 * 只读 HAMS 数据目录下的 bots/<成员>/work/<工作项>/，文本可预览（.md 按 Markdown 渲染）。
 */
function PMDeliverablesTab({ project }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  const [fileError, setFileError] = React.useState(null);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      setData(await call('project/deliverables', { payload: { projectId: project.id } }));
      setError(null);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }, [project.id]);
  React.useEffect(() => { load(); }, [load]);

  const open = async (item) => {
    setFileError(null);
    try {
      const file = await call('project/deliverable', { payload: { projectId: project.id, path: item.relPath } });
      setSelected({ ...file, label: item.label, source: item.source, memberName: item.memberName });
    } catch (err) { setFileError(err); }
  };

  const items = (data && data.items) || [];
  const fmtBytes = (size) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  const isMarkdown = selected && /\.(md|markdown)$/i.test(selected.name || '');

  return h('div', { role: 'tabpanel', style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } }, [
    h('div', { key: 'bar', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, '交付物'),
      h('span', { key: 'c', style: styles.muted }, data
        ? `${items.length} 个文件 · 工作项 ${items.filter((row) => row.source === 'work').length} · 群聊 ${items.filter((row) => row.source === 'chat').length}${data.truncated ? '（已截断）' : ''}`
        : '加载中…'),
      h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
      h(PMButton, { key: 'r', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'),
    ]),
    error ? h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }) : null,
    fileError ? h(ErrorBox, { key: 'ferr', error: fileError, onDismiss: () => setFileError(null) }) : null,
    data && !items.length
      ? h('div', { key: 'empty', style: styles.notice }, '还没有交付物。bot 在工作项里产出的文件会出现在这里（工作区 bots/<成员>/work/<工作项>）。')
      : null,
    items.length ? h('div', { key: 'two', style: { display: 'grid', gridTemplateColumns: 'minmax(320px,1fr) minmax(0,1.4fr)', gap: 14, alignItems: 'stretch', height: 'calc(100vh - 300px)', minHeight: 300 } }, [
      h('div', { key: 'list', style: { minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 } },
        items.map((item) => h('div', {
          key: item.relPath,
          role: 'button',
          title: item.relPath,
          onClick: () => open(item),
          style: {
            display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', minWidth: 0,
            background: selected && selected.relPath === item.relPath ? C.tintStrong : 'transparent',
          },
        }, [
          h('span', { key: 'n', style: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
          h('span', { key: 'm', style: { ...styles.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `${item.memberName} · ${fmtBytes(item.size)} · ${fmtTime(item.mtime)} · ${item.label}`),
          h('span', { key: 's', style: { display: 'none' } }, item.source),
        ]))),
      selected
        ? h('div', { key: 'preview', style: { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
              h('strong', { key: 'n', style: { fontSize: 12.5, wordBreak: 'break-all' } }, selected.name),
              h('span', { key: 's', style: styles.muted }, `${fmtBytes(selected.size)} · ${fmtTime(selected.mtime)} · ${selected.memberName}`),
            ]),
            h('span', { key: 'p', style: { ...styles.muted, wordBreak: 'break-all', fontSize: 11 } }, selected.relPath),
            h('div', { key: 'b', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
              selected.binary
                ? h('div', { key: 'bin', style: styles.notice }, '二进制文件（图片 / 压缩包 / 数据文件等）不能在这里预览，去工作区用对应工具打开。')
                : h(React.Fragment, null, [
                    isMarkdown
                      ? h('div', { key: 'md', style: { fontSize: 12.5 } }, renderMarkdown(selected.content, `dl-${selected.relPath}`))
                      : h('pre', { key: 'raw', style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.6 } }, selected.content),
                    selected.truncated ? h('div', { key: 'tr', style: { ...styles.muted, paddingTop: 6 } }, '只显示前 256KB。') : null,
                  ])),
          ])
        : h('div', { key: 'hint', style: { ...styles.muted, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' } }, '左侧选一个文件看内容'),
    ]) : null,
  ]);
}

/**
 * 立项项目书：当前目标口径的只读全文（说明 + 每个目标的定义与目标值 + 最新读数/达标情况 + 发布信息），
 * 以及历史版本。就是「这个项目当初立项时定了什么」的那份文档。
 */
function PMProjectCharter({ detail, metrics = [], versions = [], onClose }) {
  const fmtDirection = (direction) => ({ higher: '越高越好', lower: '越低越好', range: '区间' })[direction] || direction || '方向未定';
  const fmtTarget = (metric) => metric.target_value == null ? '目标未设' : `${metric.target_value}${metric.unit || ''}${metric.target_max == null ? '' : `–${metric.target_max}${metric.unit || ''}`}`;
  return h('div', { role: 'tabpanel', style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } }, [
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
      h(PMButton, { key: 'back', onClick: onClose }, '← 返回目标与阶段'),
      h('strong', { key: 't', style: { fontSize: 14 } }, '立项项目书'),
      h('span', { key: 's', style: styles.muted }, detail.current_target ? `口径 v${detail.current_target.version} · ${fmtTime(detail.current_target.published_at)} 冻结` : '尚未发布口径'),
    ]),
    h('div', { key: 'goal', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, '目标说明'),
      h('p', { key: 'g', style: { margin: 0, lineHeight: 1.8 } }, detail.goal_text || '尚未填写目标说明'),
    ]),
    h('div', { key: 'targets', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, `目标（${metrics.length}）`),
      ...metrics.map((metric, index) => h('div', { key: metric.id || index, style: { display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 2 } }, [
        h('div', { key: 'r', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
          h('strong', { key: 'n', style: { fontSize: 12.5 } }, `目标 ${index + 1}：${metric.name}`),
          h(PMVerdict, { key: 'v', verdict: PMMetricVerdict(metric) }),
        ]),
        h('span', { key: 'd', style: styles.muted },
          `${fmtDirection(metric.direction)} · ${fmtTarget(metric)} · 窗口 ${({ day: '近 1 天', week: '近 7 天', month: '近 30 天', snapshot: '时点快照' })[metric.window_kind] || metric.window_kind || '未设'} · 来源 ${metric.calculator_key || metric.source_kind || '未定义'}`),
        metric.definition_text ? h('span', { key: 'def', style: { ...styles.muted, lineHeight: 1.7 } }, `定义：${metric.definition_text}`) : null,
        h('span', { key: 'l', style: styles.muted },
          metric.latest && metric.latest.value != null ? `最新读数 ${metric.latest.value}${metric.unit || ''}（${fmtTime(metric.latest.observed_at)}）` : '还没有读数：缺数时保持未知，不参与达标率分母'),
      ])),
      metrics.length ? null : h(PMEmpty, { key: 'e' }, '这份口径还没有定义目标'),
    ]),
    h('div', { key: 'versions', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
      h('strong', { key: 't', style: { fontSize: 13 } }, `历史版本（${versions.length}）`),
      ...versions.map((version) => h('div', { key: version.id || version.version, style: { display: 'flex', flexDirection: 'column', gap: 3 } }, [
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
          h('strong', { key: 'v', style: { fontSize: 12.5 } }, `v${version.version}`),
          version.version === detail.current_target_version ? badge('当前', C.accent) : badge('历史', C.muted),
          h('span', { key: 't', style: styles.muted }, `${fmtTime(version.published_at)} · 发布人 ${version.published_by_name || version.published_by || '未记录'} · ${(version.metrics || []).length} 个目标`),
        ]),
        h('span', { key: 'g', style: { ...styles.muted, lineHeight: 1.7 } }, version.goal_text || '未写目标'),
      ])),
    ]),
  ]);
}

/**
 * 「目标与阶段」：项目 → 阶段 → 目标 → 检验记录。
 *
 * 提交检验 = 申请审批：项目经理提交（验证摘要 + 报告链接），指定审批人批准后目标才算达成；
 * 驳回会留下原因。每个项目至少有一个「默认阶段 + 首个目标」（服务端建项目时补齐）。
 */
function PMGoalsTab({ detail, metrics, phases, humans = [], me, busy, locked, can, state, onPublishTarget, onRecord, form, onForm }) {
  const [showVersions, setShowVersions] = React.useState(false);
  const [openTarget, setOpenTarget] = React.useState('');
  const [charterOpen, setCharterOpen] = React.useState(false);
  const [rejecting, setRejecting] = React.useState('');
  const [rejectNote, setRejectNote] = React.useState('');
  const [editing, setEditing] = React.useState('');
  const [editDraft, setEditDraft] = React.useState({});
  const [adding, setAdding] = React.useState('');
  const [addDraft, setAddDraft] = React.useState({});
  const [draft, setDraft] = React.useState({});
  const versions = detail.target_versions || [];
  const valid = metrics.filter((m) => PMMetricVerdict(m) !== 'unknown');
  const met = valid.filter((m) => PMMetricVerdict(m) === 'met');
  const PHASE_STATUS = { planned: '待开始', active: '进行中', awaiting_confirm: '待确认', confirmed: '已确认', done: '已确认' };
  const VERDICT = { approved: '已通过', rejected: '已驳回', pending: '待审批' };
  const canManage = can('createPhase');
  const humanOptions = (humans || []).map((human) => [human.id, human.name || human.id]);
  const metricOptions = [['', '不关联指标'], ...metrics.map((m) => [m.id, m.name])];
  const draftOf = (id) => draft[id] || { summary: '', reportUrl: '', note: '', approverId: '' };
  const patchDraft = (id, key, value) => setDraft((prev) => ({ ...prev, [id]: { ...draftOf(id), [key]: value } }));
  const addDraftOf = () => addDraft;
  const patchAdd = (key, value) => setAddDraft((prev) => ({ ...prev, [key]: value }));
  const targetStatus = (target) => target.achieved ? '已达成' : target.pending ? '待审批' : target.rejected ? '已驳回' : '推进中';
  const targetColor = (target) => target.achieved ? C.ok : target.pending ? C.warn : target.rejected ? C.bad : C.muted;
  const fmtLimit = (endsAt) => (endsAt && endsAt > 253000000000000 ? '无限制' : fmtDay(endsAt));
  // 项目目标状态：全部达标=已达成；有读数未达标=推进中；没有可判定目标=未量化
  const goalLabel = !valid.length ? '未量化' : met.length === valid.length ? '已达成' : '推进中';
  const goalColor = !valid.length ? C.muted : met.length === valid.length ? C.ok : C.warn;

  if (charterOpen) {
    return h(PMProjectCharter, { key: 'charter', detail, metrics, versions, onClose: () => setCharterOpen(false) });
  }

  return h('div', { role: 'tabpanel', style: { display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 } }, [
    // ── 项目目标：状态徽标 + 一行摘要 + 说明（≤2 行）+ 最多 3 个目标（浅色块）──
    h('div', { key: 'goal', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
      h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
        badge(goalLabel, goalColor),
        h('strong', { key: 'n', style: { fontSize: 13.5 } }, '项目目标'),
        h('span', { key: 'v', style: styles.muted }, detail.current_target ? `口径 v${detail.current_target.version}` : '口径未发布'),
        h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
        h(PMButton, { key: 'edit', primary: true, disabled: busy || !can('publishTarget'), onClick: () => onPublishTarget && onPublishTarget() }, '编辑'),
        h(PMButton, { key: 'charter', onClick: () => setCharterOpen(true) }, '查看立项项目书'),
        h(PMButton, { key: 'hist', disabled: busy, onClick: () => setShowVersions((open) => !open) }, showVersions ? '收起版本历史' : `版本历史（${versions.length}）`),
      ]),
      h('div', {
        key: 'desc',
        title: detail.goal_text || '',
        style: {
          ...styles.muted, lineHeight: 1.6,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        },
      }, detail.goal_text || '尚未填写目标说明'),
      metrics.length
        ? h('div', { key: 'targets', style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 } },
            metrics.slice(0, 3).map((metric, index) => {
              const verdict = PMMetricVerdict(metric);
              const latest = metric.latest && metric.latest.value != null ? `${metric.latest.value}${metric.unit || ''}` : '没有读数';
              const targetText = metric.target_value == null ? '目标未设' : `目标 ${metric.target_value}${metric.unit || ''}${metric.target_max == null ? '' : `–${metric.target_max}${metric.unit || ''}`}`;
              return h('div', {
                key: metric.id,
                style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: C.tintStrong, borderRadius: 10, padding: '9px 12px' },
              }, [
                badge(({ met: '达标', missed: '未达标', unknown: '未知' })[verdict], verdict === 'met' ? C.ok : verdict === 'missed' ? C.bad : C.muted),
                h('span', { key: 'd', style: { fontWeight: 500 } }, `目标 ${index + 1}：${metric.name}`),
                h('span', { key: 'l', style: styles.muted }, `最新 ${latest} · ${targetText}`),
              ]);
            }))
        : h('span', { key: 'none', style: styles.muted }, '还没有目标：点「编辑」，在目标口径里写 1–3 条可衡量的目标'),
      metrics.length > 3 ? h('span', { key: 'cap', style: styles.muted }, `当前口径有 ${metrics.length} 个目标，这里只显示前 3 个；请到「编辑」里收敛到最多 3 个。`) : null,
      metrics.length && metrics.length < 3 ? h('span', { key: 'add', style: styles.muted }, '还可以再加：点「编辑」新增目标（最多 3 个）。') : null,
      showVersions ? h('div', { key: 'versions', style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 } },
        versions.map((v) => h('div', { key: v.id || v.version, style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
            h('strong', { key: 'v', style: { fontSize: 12.5 } }, `v${v.version}`),
            v.version === detail.current_target_version ? badge('当前', C.accent) : null,
            h('span', { key: 't', style: styles.muted }, `${fmtTime(v.published_at)} · 发布人 ${v.published_by_name || v.published_by || '未记录'}`),
          ]),
          h('span', { key: 'g', style: { lineHeight: 1.7 } }, v.goal_text || '未写目标'),
          ...(v.metrics || []).map((m, i) => h('div', { key: m.id || i, style: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } }, [
            h('span', { key: 'n', style: styles.muted }, m.name || m.metric_id || `目标 ${i + 1}`),
            h('span', { key: 'd', style: styles.muted }, `目标 ${m.target_value == null ? '未设' : `${m.target_value}${m.unit || ''}`}`),
          ])),
        ]))) : null,
    ]),
    // ── 阶段（缩进块）──
    ...phases.map((phase) => {
      const targets = phase.targets || [];
      const achieved = targets.filter((target) => target.achieved).length;
      const phaseTone = phase.status === 'active' ? C.ok : phase.status === 'awaiting_confirm' ? C.warn : C.muted;
      return h('div', { key: phase.id, style: { display: 'flex', flexDirection: 'column', gap: 10, borderLeft: `2px solid ${C.hair}`, paddingLeft: 14 } }, [
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          badge(PHASE_STATUS[phase.status] || phase.status, phaseTone),
          h('strong', { key: 'n', style: { fontSize: 13 } }, `阶段 ${phase.seq}：${phase.name}`),
          h('span', { key: 'd', style: styles.muted }, `截止 ${fmtLimit(phase.ends_at)}`),
          h('span', { key: 'a', style: styles.muted }, `已达成 ${achieved}/${targets.length}`),
          h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
          h('div', { key: 'a', style: { display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' } }, [
            !['confirmed', 'done'].includes(phase.status) ? h(PMButton, {
              key: 'advance', disabled: locked || !can('updatePhase') || phase.status === 'awaiting_confirm',
              onClick: () => state.execute('project/updatePhase', { projectId: detail.id, phaseId: phase.id, status: phase.status === 'active' ? 'awaiting_confirm' : 'active' }),
            }, phase.status === 'active' ? '提交阶段验收' : '开始阶段') : null,
            phase.status === 'awaiting_confirm' ? h(PMButton, {
              key: 'confirm', primary: true, disabled: locked || !can('confirmPhase'),
              onClick: () => state.execute('project/confirmPhase', { projectId: detail.id, phaseId: phase.id }),
            }, '确认阶段通过') : null,
            h(PMButton, { key: 'add', disabled: locked || !canManage, onClick: () => { setAdding(adding === phase.id ? '' : phase.id); setAddDraft({ description: '', detail: '', targetValue: '', verifierHumanId: (humanOptions[0] || [''])[0], metricId: '' }); } }, adding === phase.id ? '收起' : '+目标'),
          ]),
        ]),
        adding === phase.id ? h('div', { key: 'addForm', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0 2px 12px', borderLeft: `2px solid ${C.hair}` } }, [
          h('div', { key: 'd', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('div', { key: 'desc', style: { flex: '1 1 360px', minWidth: 220 } }, h(PMInput, { label: '目标（一句话）', value: addDraftOf().description || '', onChange: (value) => patchAdd('description', value), disabled: busy })),
            h('div', { key: 'val', style: { width: 140 } }, h(PMInput, { label: '目标值（可空）', type: 'number', value: addDraftOf().targetValue || '', onChange: (value) => patchAdd('targetValue', value), disabled: busy })),
          ]),
          h('div', { key: 'det', style: { flex: '1 1 auto' } }, h(PMInput, { label: '目标详情：计算方式与验收要求', multiline: true, value: addDraftOf().detail || '', onChange: (value) => patchAdd('detail', value), disabled: busy })),
          h('div', { key: 'a', style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } }, [
            humanOptions.length ? h('div', { key: 'w', style: { width: 200 } }, h(PMSelect, { label: '验收人', value: addDraftOf().verifierHumanId || '', options: humanOptions, onChange: (value) => patchAdd('verifierHumanId', value), disabled: busy })) : null,
            h('div', { key: 'm', style: { width: 200 } }, h(PMSelect, { label: '关联指标（可空）', value: addDraftOf().metricId || '', options: metricOptions, onChange: (value) => patchAdd('metricId', value), disabled: busy })),
            h(PMButton, {
              key: 'go', primary: true, disabled: busy || !(addDraftOf().description || '').trim(),
              onClick: () => state.execute('project/addTarget', {
                projectId: detail.id, phaseId: phase.id, description: (addDraftOf().description || '').trim(),
                detail: (addDraftOf().detail || '').trim(),
                targetValue: (addDraftOf().targetValue || '').trim() === '' ? null : Number(addDraftOf().targetValue),
                ...(addDraftOf().verifierHumanId ? { verifierHumanId: addDraftOf().verifierHumanId } : {}),
                ...(addDraftOf().metricId ? { metricId: addDraftOf().metricId } : {}),
              }, () => { setAdding(''); setAddDraft({}); }),
            }, '添加目标'),
          ]),
        ]) : null,
        ...targets.map((target, index) => {
          const open = openTarget === target.id;
          const checks = target.checks || [];
          const d = draftOf(target.id);
          const linkedMetric = target.metric_id ? metrics.find((m) => m.id === target.metric_id) : null;
          const targetTone = targetColor(target);
          return h('div', { key: target.id || index, style: { display: 'flex', flexDirection: 'column', gap: 6, borderLeft: `2px solid ${C.hair}`, paddingLeft: 12 } }, [
            h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
              badge(targetStatus(target), targetTone),
              h('span', { key: 'd', style: { fontWeight: 500 } }, `目标 ${index + 1}：${target.description}`),
              target.target_value != null ? h('span', { key: 'v', style: styles.muted }, `目标值 ${target.target_value}`) : null,
              h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
              h('div', { key: 'a', style: { display: 'flex', gap: 6, flexShrink: 0 } }, [
                h(PMButton, { key: 'detail', onClick: () => setOpenTarget(open ? '' : target.id) }, open ? '收起' : '目标详情'),
                canManage ? h(PMButton, { key: 'edit', disabled: busy, onClick: () => { setOpenTarget(target.id); setEditing(target.id); setEditDraft({ description: target.description || '', detail: target.detail || '', targetValue: target.target_value == null ? '' : String(target.target_value), verifierHumanId: target.verifier_human_id || '' }); } }, '编辑') : null,
                canManage ? h(PMButton, { key: 'submit', primary: true, disabled: busy, onClick: () => setOpenTarget(target.id) }, '申请验证') : null,
              ]),
            ]),
            h('div', { key: 'dd', style: { ...styles.muted, lineHeight: 1.7 } }, `目标详情：${target.detail || '（尚未填写计算方式与验收要求）'}${linkedMetric ? ` · 关联指标：${linkedMetric.name}` : ''}`),
            (target.checks || []).length ? h('div', { key: 'checks', style: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 10, borderLeft: `1px solid ${C.hair}` } }, checks.map((check) => h('div', { key: check.id, style: { display: 'flex', flexDirection: 'column', gap: 3 } }, [
              h('div', { key: 'r', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
                badge(VERDICT[check.status] || check.status, check.status === 'approved' ? C.ok : check.status === 'rejected' ? C.bad : C.warn),
                h('span', { key: 't', style: { ...styles.muted, fontSize: 11.5 } }, fmtTime(check.submitted_at)),
                h('span', { key: 'm', style: { fontSize: 12 } }, check.summary),
                check.report_url ? h('a', { key: 'u', href: check.report_url, target: '_blank', rel: 'noreferrer noopener', style: { color: C.accent, fontSize: 12 } }, '验证报告') : null,
                check.status === 'pending' ? h('span', { key: 'w', style: { ...styles.muted, fontSize: 11.5 } }, `待 ${check.approver_name || '审批人'} 审批`) : null,
                check.decision_note ? h('span', { key: 'n', style: { ...styles.muted, fontSize: 11.5 } }, `审批意见：${check.decision_note}`) : null,
              ]),
              check.status === 'pending' && check.approval_id && me && check.approver_id === me
                ? h('div', { key: 'act', style: { display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 2 } }, [
                    h(PMButton, { key: 'ok', primary: true, disabled: busy, onClick: () => state.execute('approval/decide', { approvalId: check.approval_id, decision: 'approve', note: '' }) }, '通过验证'),
                    h(PMButton, { key: 'no', disabled: busy || rejecting === check.id, onClick: () => { setRejecting(check.id); setRejectNote(''); } }, '驳回'),
                    rejecting === check.id ? h(React.Fragment, null, [
                      h('div', { key: 'n', style: { flex: '1 1 240px', minWidth: 160 } }, h(PMInput, { label: '驳回原因（必填）', value: rejectNote, onChange: setRejectNote, disabled: busy })),
                      h(PMButton, { key: 'go', disabled: busy || !rejectNote.trim(), onClick: () => state.execute('approval/decide', { approvalId: check.approval_id, decision: 'reject', note: rejectNote.trim() }, () => { setRejecting(''); setRejectNote(''); }) }, '确认驳回'),
                      h(PMButton, { key: 'c', disabled: busy, onClick: () => setRejecting('') }, '取消'),
                    ]) : null,
                  ])
                : null,
            ]))) : null,
            open ? h('div', { key: 'panel', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0 2px 10px', borderLeft: `1px solid ${C.hair}` } }, [
              canManage && editing === target.id ? h('div', { key: 'editForm', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                h('div', { key: 'd', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                  h('div', { key: 'desc', style: { flex: '1 1 340px', minWidth: 200 } }, h(PMInput, { label: '目标（一句话）', value: editDraft.description || '', onChange: (value) => setEditDraft((prev) => ({ ...prev, description: value })), disabled: busy })),
                  h('div', { key: 'val', style: { width: 140 } }, h(PMInput, { label: '目标值（可空）', type: 'number', value: editDraft.targetValue || '', onChange: (value) => setEditDraft((prev) => ({ ...prev, targetValue: value })), disabled: busy })),
                ]),
                h('div', { key: 'det' }, h(PMInput, { label: '目标详情：计算方式与验收要求', multiline: true, value: editDraft.detail || '', onChange: (value) => setEditDraft((prev) => ({ ...prev, detail: value })), disabled: busy })),
                h('div', { key: 'a', style: { display: 'flex', gap: 8, alignItems: 'flex-end' } }, [
                  humanOptions.length ? h('div', { key: 'w', style: { width: 200 } }, h(PMSelect, { label: '验收人', value: editDraft.verifierHumanId || '', options: humanOptions, onChange: (value) => setEditDraft((prev) => ({ ...prev, verifierHumanId: value })), disabled: busy })) : null,
                  h(PMButton, { key: 'save', primary: true, disabled: busy || !(editDraft.description || '').trim(), onClick: () => state.execute('project/updateTarget', {
                    projectId: detail.id, targetId: target.id,
                    description: (editDraft.description || '').trim(), detail: (editDraft.detail || '').trim(),
                    targetValue: (editDraft.targetValue || '').trim() === '' ? null : Number(editDraft.targetValue),
                    ...(editDraft.verifierHumanId ? { verifierHumanId: editDraft.verifierHumanId } : {}),
                  }, () => setEditing('')) }, '保存'),
                  h(PMButton, { key: 'cancel', disabled: busy, onClick: () => setEditing('') }, '取消'),
                ]),
              ]) : null,
              canManage ? h('div', { key: 'submitForm', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                h('span', { key: 't', style: styles.muted }, '申请验证 = 发起一次审批：审批人通过后这个目标才算达成。'),
                h(PMInput, { label: '验证摘要（审批人看到的就是这句）', value: d.summary, onChange: (value) => patchDraft(target.id, 'summary', value), disabled: busy }),
                h('div', { key: 'a', style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } }, [
                  h('div', { key: 'u', style: { flex: '1 1 280px', minWidth: 180 } }, h(PMInput, { label: '验证报告链接（http/https，可空）', value: d.reportUrl, onChange: (value) => patchDraft(target.id, 'reportUrl', value), disabled: busy, placeholder: 'https://…' })),
                  humanOptions.length ? h('div', { key: 'p', style: { width: 200 } }, h(PMSelect, { label: '指定审批人', value: d.approverId || '', options: [['', '选择审批人'], ...humanOptions], onChange: (value) => patchDraft(target.id, 'approverId', value), disabled: busy })) : null,
                  h(PMButton, {
                    key: 'go', primary: true,
                    disabled: busy || !d.approverId || !d.summary.trim() || (!!d.reportUrl.trim() && !/^https?:\/\//i.test(d.reportUrl.trim())),
                    onClick: () => state.execute('project/submitTargetCheck', {
                      projectId: detail.id, targetId: target.id, approverId: d.approverId,
                      summary: d.summary.trim(), reportUrl: d.reportUrl.trim(), note: d.note.trim(),
                    }, () => setDraft((prev) => ({ ...prev, [target.id]: { summary: '', reportUrl: '', note: '', approverId: '' } }))),
                  }, '发起验证审批'),
                ]),
                h(PMInput, { label: '说明（可空）', value: d.note, onChange: (value) => patchDraft(target.id, 'note', value), disabled: busy }),
              ]) : h('div', { key: 'ro', style: styles.muted }, '申请验证需要项目经理权限'),
            ]) : null,
          ]);
        }),
        (phase.checks || []).length ? h('div', { key: 'chk', style: { display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 12, borderLeft: `1px solid ${C.hair}` } }, (phase.checks || []).map((check) => h('label', { key: check.id, style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
          h('input', { key: 'i', type: 'checkbox', checked: !!check.checked, disabled: locked || !can('updatePhase') || ['confirmed', 'done'].includes(phase.status), onChange: (event) => state.execute('project/updatePhase', { projectId: detail.id, phaseId: phase.id, checkId: check.id, checked: event.target.checked }) }),
          h('span', { key: 't' }, check.label),
        ]))) : null,
      ]);
    }),
    h('div', { key: 'addPhase', style: { display: 'flex', gap: 10, alignItems: 'baseline' } }, [
      h('span', { key: 'c', style: styles.muted }, `${phases.length} 个阶段 · 日期到了不会自动通过`),
      h('div', { key: 'sp', style: { flex: '1 1 auto' } }),
      h(PMButton, { key: 'new', disabled: locked || !can('createPhase'), onClick: () => onForm('phase') }, '新增阶段'),
    ]),
    form === 'phase' ? h(PMPhaseForm, { key: 'form', detail, humans, busy: locked, execute: state.execute, onCancel: () => onForm('') }) : null,
    phases.length ? null : h(PMEmpty, { key: 'e' }, '还没有阶段——项目建好后会自动补一个默认阶段，如果没有，点下面「新增阶段」。'),
  ]);
}

/** 项目「记忆」页签：群聊自动发现 + 手工补充；能力类记忆会同步给 bot。 */
function PMMemoryTab({ project, bots = [], canManage, onRefresh }) {
  const [items, setItems] = React.useState(null);
  const [status, setStatus] = React.useState('active');
  const [kind, setKind] = React.useState('');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const prefix = `pm/memory/${project.id}/`;
  const [title, setTitle] = usePMDraft(prefix + 'title', '');
  const [body, setBody] = usePMDraft(prefix + 'body', '');
  const [memKind, setMemKind] = usePMDraft(prefix + 'kind', 'fact');
  const [botId, setBotId] = usePMDraft(prefix + 'botId', project.coordinator_id || '');
  const activeBots = bots.filter((bot) => bot.status === 'active');

  const load = React.useCallback(async () => {
    try {
      const next = await call('project/memory/list', { payload: { projectId: project.id, status, kind: kind || undefined } });
      setItems(Array.isArray(next) ? next : []);
      setError(null);
    } catch (err) { setError(err); }
  }, [project.id, status, kind]);
  React.useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!canManage || busy || !title.trim() || !body.trim()) return;
    setBusy(true); setError(null);
    try {
      await call('project/memory/create', {
        objectId: project.id,
        payload: {
          projectId: project.id, kind: memKind, title: title.trim(), body: body.trim(),
          memberId: memKind === 'capability' ? (botId || null) : null,
        },
      });
      PMClearDraft(prefix); setTitle(''); setBody(''); setFormOpen(false);
      await load(); if (onRefresh) onRefresh();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const setItemStatus = async (item, next) => {
    if (!canManage || busy) return;
    setBusy(true); setError(null);
    try {
      await call('project/memory/update', { objectId: item.id, payload: { memoryId: item.id, status: next } });
      await load(); if (onRefresh) onRefresh();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const rows = items || [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }, [
    h('div', { key: 'h', style: styles.row }, [
      h('div', { key: 't', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 } }, [
        h('strong', { key: 'n', style: { fontSize: 13 } }, '项目记忆'),
        h('span', { key: 'd', style: styles.muted }, '群聊里自动发现决定/偏好/教训/能力；能力类会同步一份给对应 bot。'),
      ]),
      h('div', { key: 'a', style: { display: 'flex', gap: 6 } }, [
        h(PMButton, { key: 'r', disabled: busy, onClick: load }, '刷新'),
        canManage ? h(PMButton, { key: 'new', primary: true, disabled: busy, onClick: () => setFormOpen((open) => !open) }, formOpen ? '收起' : '记一条') : null,
      ]),
    ]),
    h(ErrorBox, { key: 'err', error, onDismiss: () => setError(null) }),
    h('div', { key: 'filters', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } }, [
      h('div', { key: 's', style: { width: 150 } }, h(PMSelect, { label: '状态', value: status, onChange: setStatus, options: [['active', '有效'], ['archived', '已归档'], ['', '全部']] })),
      h('div', { key: 'k', style: { width: 150 } }, h(PMSelect, { label: '类型', value: kind, onChange: setKind, options: [['', '全部类型'], ...PM_MEMORY_KINDS] })),
      h('span', { key: 'c', style: { marginLeft: 'auto', ...styles.muted } }, `${rows.length} 条${canManage ? '' : ' · 只读'}`),
    ]),
    formOpen && canManage ? h('section', { key: 'form', style: styles.card }, [
      h('div', { key: 'g', style: styles.grid }, [
        h(PMInput, { key: 't', label: '标题（一句话）', value: title, onChange: setTitle, disabled: busy }),
        h(PMSelect, { key: 'k', label: '类型', value: memKind, onChange: setMemKind, disabled: busy, options: PM_MEMORY_KINDS }),
      ]),
      memKind === 'capability' ? h(PMSelect, { key: 'bot', label: '同步给哪个 bot', value: botId, onChange: setBotId, disabled: busy, options: [['', '不同步给 bot'], ...activeBots.map((bot) => [bot.id, bot.name])] }) : null,
      h(PMInput, { key: 'b', label: '内容（保留事实、原因、以后怎么做）', value: body, onChange: setBody, multiline: true, disabled: busy }),
      h('div', { key: 'a', style: styles.row }, [
        h(PMButton, { key: 's', primary: true, disabled: busy || !title.trim() || !body.trim(), onClick: submit }, busy ? '保存中…' : '保存记忆'),
        h(PMButton, { key: 'c', disabled: busy, onClick: () => setFormOpen(false) }, '取消'),
      ]),
    ]) : null,
    items === null
      ? h('div', { key: 'loading', style: styles.muted }, '读取记忆…')
      : rows.length
        ? h('div', { key: 'list', style: styles.list }, rows.map((item) => h('article', { key: item.id, style: styles.card }, [
            h('div', { key: 'h', style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } }, [
              badge(PMMemoryKindLabel(item.kind), PM_MEMORY_KIND_COLOR[item.kind] || C.muted),
              h('strong', { key: 't', style: { fontSize: 13, minWidth: 0 } }, item.title),
              badge(PM_MEMORY_ORIGIN[item.origin] || item.origin || '记忆', C.muted),
              item.kind === 'capability' && item.member_name ? badge(`同步给 ${item.member_name}`, C.ok) : null,
              canManage ? h(PMButton, { key: 'x', style: { marginLeft: 'auto' }, disabled: busy, onClick: () => setItemStatus(item, item.status === 'active' ? 'archived' : 'active') }, item.status === 'active' ? '归档' : '恢复') : null,
            ]),
            h('div', { key: 'b', style: { lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.body),
            h('div', { key: 'm', style: styles.muted }, `${fmtTime(item.created_at)} · ${item.created_by_name || item.created_by || '未知'}${item.source_ref && String(item.source_ref).startsWith('message:') ? ' · 来自群聊' : item.origin === 'tool' ? ' · 来自 bot' : ''}`),
          ])))
        : h(PMEmpty, { key: 'e' }, status === 'archived' ? '还没有归档的记忆。' : '还没有记忆。群聊里出现决定、偏好、教训或能力经验时会自动收到这里；也可以点「记一条」手动补。'),
  ]);
}
function PMProjectDetail({ detail, humans = [], bots = [], me, busy, onCommand, onStatus, onRecord, onGotoTasks, onOpenWorkItem, onClose, initialTab, onPublishTarget, onContinueDraft, onDelete, onRefreshDetail, onOpenMember }) {
  const [tab, setTab] = React.useState(initialTab || 'chat'); const [form, setForm] = React.useState(''); const [progressFilter, setProgressFilter] = React.useState('all'); const [confirmDelete, setConfirmDelete] = React.useState(false);
  const state = usePMCommand(onCommand); const locked = busy || state.pending;
  const metrics = detail.metrics || []; const phases = detail.phases || []; const reviews = detail.reviews || []; const progress = detail.progress_records || {};
  const items = detail.workItems || detail.projectWorkItems || (Array.isArray(detail.work_items) ? detail.work_items : detail.recent_items || []);
  const fullWorkItems = !!(detail.workItems || detail.projectWorkItems || Array.isArray(detail.work_items));
  const can = (action) => PMAllowed(detail, action);
  const valid = metrics.filter((m) => PMMetricVerdict(m) !== 'unknown'); const met = valid.filter((m) => PMMetricVerdict(m) === 'met');
  const status = (action) => onCommand ? state.execute('project/status', { projectId: detail.id, status: { publish: 'active', pause: 'paused', resume: 'active', archive: 'archived' }[action] }) : onStatus && onStatus(action);
  return h('section', { style: styles.page }, [
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 } }, [
      badge(PROJECT_STATUS_LABEL[detail.status] || detail.status, detail.status === 'active' ? C.ok : C.muted),
      h('h2', { key: 'n', style: { ...styles.title, margin: 0, flex: '1 1 240px', minWidth: 0 } }, detail.name),
      h('div', { key: 'a', style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
        can('continueDraft') ? h(PMButton, { key: 'continue', primary: true, disabled: locked || !onContinueDraft, onClick: () => onContinueDraft && onContinueDraft(detail) }, '继续完善草稿') : null,
        ...['publish', 'pause', 'resume', 'archive'].filter(can).map((action) => h(PMButton, { key: action, disabled: locked || (!onCommand && !onStatus), onClick: () => status(action) }, { publish: '发布目标', pause: '暂停推进', resume: '继续推进', archive: '归档项目' }[action])),
        can('delete') ? h(PMButton, { key: 'delete', disabled: locked, onClick: () => setConfirmDelete(true) }, '删除项目') : null,
        h(PMButton, { key: 'review', primary: !can('continueDraft'), disabled: locked || !onCommand || !can('createReview'), onClick: () => { setTab('reviews'); setForm('review'); } }, '发起复盘'),
      ]),
      onClose ? h(PMButton, { key: 'close', onClick: onClose }, '✕ 关闭') : null,
    ]),
    h('div', { key: 'meta', style: styles.muted }, `${detail.type === 'continuous' ? '持续运营' : '一次性'} · 负责人 ${detail.owner_name || detail.owner_human_id || '未指定'} · 推进 ${detail.coordinator_name || '未指定'} · 修订 ${detail.revision}`),
    detail.status === 'draft' ? h('div', { key: 'draftNote', style: styles.notice }, '这是草稿：目标口径还没发布。点「继续完善草稿」回到向导，填完目标与指标后创建并发布 v1；也可以继续保存草稿。') : null,
    confirmDelete ? h('div', { key: 'deleteConfirm', style: { ...styles.notice, background: 'rgba(224,49,49,.08)', color: '#B42318', display: 'flex', flexDirection: 'column', gap: 8 } }, [
      h('strong', { key: 'h' }, `确认删除《${detail.name}》？`),
      h('span', { key: 'n' }, '删除后项目从项目列表与群聊消失，项目下的工作项转入「无项目」继续保留；证据与审计不会被删除。'),
      h('div', { key: 'b', style: { display: 'flex', gap: 8 } }, [
        h(PMButton, { key: 'yes', primary: true, disabled: locked, onClick: () => state.execute('project/delete', { projectId: detail.id, reason: '界面删除归档项目' }, () => { if (onDelete) onDelete(detail.id); }) }, '确认删除'),
        h(PMButton, { key: 'no', disabled: locked, onClick: () => setConfirmDelete(false) }, '取消'),
      ]),
    ]) : null,
    h(ErrorBox, { key: 'err', error: state.error, onDismiss: state.dismiss }),
    h(PMTabs, { key: 'tabs', tabs: [['chat', '群聊'], ['team', '团队'], ...PM_PROJECT_TABS.map(([key, label]) => key === 'memory' && Number(detail.memory_count) > 0 ? [key, `${label} ${detail.memory_count}`] : [key, label])], value: tab, onChange: setTab, label: '项目页签' }),
    tab === 'chat' ? h(GroupChatPane, { key: 'chat', projectId: detail.id, title: detail.name, bots }) : null,
    tab === 'team' ? h(PMTeamTab, { key: 'team', project: detail, bots, onOpenMember }) : null,
    tab === 'deliverables' ? h(PMDeliverablesTab, { key: 'deliverables', project: detail }) : null,
    tab === 'goals' ? h(PMGoalsTab, { key: 'goals', detail, metrics, phases, humans, me, busy: locked, locked, can, state, onPublishTarget, onRecord, form, onForm: setForm }) : null,
    tab === 'work' ? h('div', { key: 'work', role: 'tabpanel', style: styles.list }, [h('div', { key: 'bar', style: styles.row }, [h('span', { key: 'n', style: styles.muted }, `${items.length} 条${fullWorkItems ? '关联' : '近期'}工作项`), h(PMButton, { key: 'new', primary: true, disabled: locked || !can('createWorkItem') || !onGotoTasks, onClick: () => onGotoTasks(detail.id) }, '新建工作项')]), ...Array.from(new Set(items.map((i) => i.domain || '未分域'))).map((domain) => h('section', { key: domain, style: styles.card }, [h('strong', { key: 'h' }, domain), h(PMWorkList, { key: 'list', items: items.filter((i) => (i.domain || '未分域') === domain), onOpen: onOpenWorkItem })])), !items.length ? h(PMEmpty, { key: 'e' }, '还没有关联工作项') : null, h('details', { key: 'progress', style: { paddingTop: 4 } }, [h('summary', { key: 's' }, '推进记录（提议 / 决定 / 项目变更）'), h('div', { key: 'p', style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } }, [h(PMSelect, { key: 'filter', label: '推进记录筛选', value: progressFilter, onChange: setProgressFilter, options: [['all', '全部'], ['open', '待决定'], ['accepted', '已采纳'], ['rejected', '已驳回']] }), ...(progress.proposals || []).filter((p) => progressFilter === 'all' || p.status === progressFilter).map((p) => { const ds = (progress.decisions || []).filter((d) => d.proposal_id === p.id); return h('article', { key: p.id, style: styles.card }, [h('strong', { key: 't' }, p.title), h('span', { key: 'p' }, `提议：${p.body || '未附说明'}`), h('span', { key: 'd', style: styles.muted }, `决定：${ds.length ? ds.map((d) => `${d.decision || d.status} · ${d.reason_text || d.note_text || d.note || ''} · ${fmtTime(d.created_at)}`).join('；') : p.status === 'open' ? '等待决定' : p.status || '未知'}`), h('span', { key: 'r', style: styles.muted }, `结果：${p.result_text || p.result_work_item_id || p.work_item_id || '尚无结果记录'}`)]); }), ...(progress.events || []).map((e, i) => h('div', { key: e.id || i, style: styles.item }, [h('span', { key: 't' }, e.summary || e.action || e.event_type || '项目变更'), h('span', { key: 'd', style: styles.muted }, fmtTime(e.created_at))])), !(progress.proposals || []).length && !(progress.events || []).length ? h(PMEmpty, { key: 'e' }, '还没有推进记录。提议决定汇总在总览「待我把关」。') : null])])]) : null,
    tab === 'memory' ? h(PMMemoryTab, { key: 'memory', project: detail, bots, canManage: detail.status !== 'archived' && can('manageMemory'), onRefresh: onRefreshDetail }) : null,
    tab === 'reviews' ? h('div', { key: 'reviews', role: 'tabpanel', style: styles.list }, [
      form === 'review' ? h(PMReviewForm, { key: 'form', detail, humans, busy: locked, execute: state.execute, onCancel: () => setForm('') }) : null,
      ...reviews.map((r) => h('article', { key: r.id, style: styles.card }, [h('div', { key: 'h', style: styles.row }, [h('strong', { key: 't' }, `${({ weekly: '周度', monthly: '月度', quarterly: '季度', phase: '阶段' })[r.kind] || r.kind || '周期'}复盘`), badge(r.status === 'awaiting_confirm' ? '待确认' : r.status === 'confirmed' ? '已确认' : r.status)]), h('span', { key: 'p', style: styles.muted }, `${fmtTime(r.period_start)} — ${fmtTime(r.period_end)} · 目标版本 ${r.target_version || r.target_version_id || '未知'} · 冻结 ${fmtTime(r.created_at)}`), h('div', { key: 'c' }, r.conclusion_text || '尚未填写结论'), ...(r.metrics || []).map((m, i) => h('div', { key: m.id || m.metric_id || i, style: styles.row }, [h('span', { key: 'n' }, m.name || m.metric_id), h('span', { key: 'v' }, `实际 ${m.actual_value == null ? '未知' : m.actual_value}${m.unit || ''} · 目标 ${m.target_value == null ? '未定义' : m.target_value}`), h(PMVerdict, { key: 'verdict', verdict: m.verdict || PMMetricVerdict(m) }), m.evidence_ref ? h('span', { key: 'e', style: styles.muted }, `证据 ${m.evidence_ref}`) : null])), r.status === 'awaiting_confirm' ? h(PMButton, { key: 'confirm', primary: true, disabled: locked || !onCommand || !can('confirmReview') || (r.allowedActions && !PMAllowed(r, 'confirmReview')), onClick: () => state.execute('project/confirmReview', { projectId: detail.id, reviewId: r.id }) }, '确认本期复盘') : null])),
      reviews.length ? null : h(PMEmpty, { key: 'e' }, '暂无复盘。发起后保留当期指标快照与目标口径。'),
    ]) : null,
  ]);
}
function ProjectScreen({ projects = [], detail, busy, formOpen, draft = null, bots = [], humans = [], me, onCreate, onOpen, onFormOpen, onStatus, onRecord, onGotoTasks, onCommand, onSaveDraft, onPublish, onContinueDraft, onDelete, allowedActions = [], onOpenWorkItem, onClose, initialTab, onRefreshDetail, onOpenMember }) {
  const [query, setQuery] = React.useState(''); const [type, setType] = React.useState(''); const [owner, setOwner] = React.useState(''); const [mine, setMine] = React.useState(false); const [view, setView] = React.useState('list');
  // 发布新目标口径是独立页：取消/发布后回到「目标与阶段」页签，不再嵌在页签里。
  const [targetOpen, setTargetOpen] = React.useState(false); const [returnTab, setReturnTab] = React.useState('chat');
  const state = usePMCommand(onCommand);
  const openTarget = () => { setReturnTab('goals'); setTargetOpen(true); };
  const visible = PMFilterProjects(projects, { query, type, owner, mine });
  const owners = Array.from(new Map(projects.filter((p) => p.owner_human_id).map((p) => [p.owner_human_id, p.owner_name || p.owner_human_id])).entries());
  
  // 新建项目独立成页：保存或取消都回到列表
  if (formOpen) {
    return h(PMPage, { key: 'project-create', backLabel: '← 返回项目列表', onBack: onFormOpen, crumb: '项目 / 新建项目' },
      h(ProjectCreateForm, { key: 'form', bots, draft, busy, onSubmit: onCreate, onCancel: onFormOpen, onCommand, onSaveDraft, onPublish, allowedActions }));
  }

  // 发布新版本独立成整页：返回按钮回到版本列表
  if (detail && targetOpen) {
    return h(PMPage, { key: 'project-target', backLabel: '← 返回目标与阶段', onBack: () => setTargetOpen(false), crumb: `项目 / ${detail.name} / 发布新目标口径` },
      h(PMTargetForm, { key: 'target', detail, busy: busy || state.pending, onCommand, execute: state.execute, onCancel: () => setTargetOpen(false) }));
  }

  // 详情独立成页：整页只显示详情，顶部给返回入口
  if (detail) {
    return h(PMPage, { key: `project-${detail.id}`, backLabel: '← 返回项目列表', onBack: () => { setTargetOpen(false); if (onClose) onClose(); }, crumb: `项目 / ${detail.name}` },
      h(PMProjectDetail, { key: detail.id, detail, busy, humans, bots, me, onCommand, onStatus, onRecord, onGotoTasks, onOpenWorkItem, onOpenMember, initialTab: initialTab || returnTab, onPublishTarget: openTarget, onContinueDraft, onDelete, onRefreshDetail }));
  }

  // 没有详情时显示列表
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [
    h('div', { key: 'h', style: styles.row }, [h('h1', { key: 't', style: styles.title }, '项目'), h(PMButton, { key: 'new', primary: true, disabled: busy || (!PMAllowed({ allowedActions }, 'create') && !formOpen), onClick: onFormOpen }, '新建项目')]),
    h('div', { key: 'filters', style: { ...styles.grid, alignItems: 'end' } }, [h(PMInput, { key: 'q', label: '搜索项目', value: query, onChange: setQuery, placeholder: '名称、目标或负责人' }), h(PMSelect, { key: 'type', label: '类型', value: type, onChange: setType, options: [['', '全部类型'], ['continuous', '持续运营'], ['one_off', '一次性项目']] }), h(PMSelect, { key: 'owner', label: '负责人', value: owner, onChange: setOwner, options: [['', '全部负责人'], ...owners] }), h('label', { key: 'mine', style: { display: 'flex', gap: 6, alignItems: 'center', minHeight: 28 } }, [h('input', { key: 'i', type: 'checkbox', checked: mine, onChange: (e) => setMine(e.target.checked) }), '待我处理']), h('div', { key: 'view', style: { display: 'flex', gap: 4 } }, ['list', 'cards'].map((key) => h(PMButton, { key, primary: view === key, onClick: () => setView(key) }, key === 'list' ? '列表' : '卡片')))]),
    h('span', { key: 'count', style: styles.muted }, `${visible.length} / ${projects.length} 个项目`),
    visible.length ? h('div', { key: 'list', style: view === 'cards' ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 } : styles.list }, visible.map((p) => h('article', { key: p.id, style: styles.item }, [h('div', { key: 'r', style: styles.row }, [h(PMButton, { key: 'open', onClick: () => onOpen(p.id) }, p.name), badge(PROJECT_STATUS_LABEL[p.status] || p.status, p.status === 'active' ? C.ok : C.muted)]), h('span', { key: 'd', style: styles.muted }, `${p.type === 'continuous' ? '持续运营' : '一次性'} · ${p.owner_name || p.owner_human_id || '未指定负责人'} · 指标 ${p.metric_count == null ? '未知' : p.metric_count} · 未结工作 ${p.work_items ? `${p.work_items.open}/${p.work_items.total}` : '未知'}`), h('div', { key: 'g' }, p.goal_text || '尚未定义目标')]))) : h(PMEmpty, { key: 'empty' }, projects.length ? '没有符合筛选条件的项目' : '还没有项目，创建后定义目标与指标。'),
  ]);
}
/** 热力图下面那行说明：日期范围、总量、峰值。 */
function PMHeatLegend(activity) {
  const days = PMActivityDays(activity);
  if (!days.length) return '';
  const max = Math.max(0, ...days.map((d) => d.count || 0));
  const total = days.reduce((sum, d) => sum + (d.count || 0), 0);
  return `${days[0].day} — ${days[83].day}（${activity.timeZone || '服务端日期'}） · 共 ${total} 次活动 · 峰值 ${max} 次/天 · 虚线格为未知`;
}
function PMHeatmap({ activity, showLegend = true }) {
  const days = PMActivityDays(activity); const max = Math.max(0, ...days.map((d) => d.count || 0)); const total = days.reduce((sum, d) => sum + (d.count || 0), 0);
  // 格子固定 13px：12 周 × 7 天只占两百来像素宽；说明文字默认跟区块底部走，不挤在 1/4 栏里折行。
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, [
    h('strong', { key: 'h', style: { fontSize: 12 } }, '最近 12 周活动'),
    days.length
      ? h('div', { key: 'grid', role: 'img', 'aria-label': `最近84天共${total}次活动，按服务端日期`, style: { display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(7,13px)', gridTemplateColumns: 'repeat(12,13px)', gap: 2, alignSelf: 'flex-start' } }, days.map((day) => h('span', { key: day.day, title: `${day.day} · ${day.count == null ? '数据未知' : `${day.count} 次活动`}`, style: { display: 'block', width: 13, height: 13, borderRadius: 3, border: 'none', background: day.count == null ? 'rgba(127,127,127,.06)' : day.count === 0 ? C.soft : C.accent, opacity: !day.count ? 1 : .2 + .8 * day.count / Math.max(max, 1) } })))
      : h('span', { key: 'e', style: styles.muted }, '尚无完整活动数据'),
    showLegend && days.length ? h('span', { key: 'legend', style: styles.muted }, PMHeatLegend(activity)) : null,
  ]);
}
function MemberCreateForm({ positions = [], humans = [], busy, onSubmit, onCancel }) {
  const catalog = useHostCatalog();
  const [kind, setKind] = usePMDraft('pm/member-create/' + 'kind', 'human'); const [name, setName] = usePMDraft('pm/member-create/' + 'name', ''); const [role, setRole] = usePMDraft('pm/member-create/' + 'role', 'executor');
  const [domain, setDomain] = usePMDraft('pm/member-create/' + 'domain', ''); const [responsibility, setResponsibility] = usePMDraft('pm/member-create/' + 'responsibility', ''); const [positionId, setPositionId] = usePMDraft('pm/member-create/' + 'positionId', '');
  const [ownerHumanId, setOwnerHumanId] = usePMDraft('pm/member-create/' + 'ownerHumanId', ''); const [preset, setPreset] = usePMDraft('pm/member-create/' + 'preset', ''); const [model, setModel] = usePMDraft('pm/member-create/' + 'model', ''); const [prompt, setPrompt] = usePMDraft('pm/member-create/' + 'prompt', ''); const [capabilities, setCapabilities] = usePMDraft('pm/member-create/' + 'capabilities', []);
  const toggle = (key) => setCapabilities((rows) => rows.includes(key) ? rows.filter((r) => r !== key) : [...rows, key]);
  const activePositions = positions.filter((p) => !p.status || p.status === 'active'); const activeHumans = humans.filter((p) => !p.status || p.status === 'active');
  const valid = name.trim() && responsibility.trim() && (kind === 'human' ? positionId : ownerHumanId && domain.trim());
  return h('section', { style: styles.card }, [h('strong', { key: 'h' }, '新建成员'), h('div', { key: 'kind', role: 'group', 'aria-label': '成员类型', style: { display: 'flex', gap: 6 } }, [['human', '人'], ['bot', 'bot']].map(([key, label]) => h(PMButton, { key, primary: kind === key, disabled: busy, onClick: () => setKind(key) }, label))),
    h('div', { key: 'basic', style: styles.grid }, [h(PMInput, { key: 'n', label: '姓名 / 名称', value: name, onChange: setName, disabled: busy }), h(PMSelect, { key: 'r', label: '角色', value: role, onChange: setRole, disabled: busy, options: [['coordinator', '协调'], ['executor', '执行'], ['observer', '观察']] }), h(PMInput, { key: 'd', label: kind === 'bot' ? '业务域（必填，限定授权范围）' : '业务域', value: domain, onChange: setDomain, disabled: busy })]),
    h(PMInput, { key: 'resp', label: '职责', value: responsibility, onChange: setResponsibility, multiline: true, disabled: busy }),
    kind === 'bot' ? h(PMInput, { key: 'prompt', label: '提示词（可选；默认用职责）', value: prompt, onChange: setPrompt, multiline: true, disabled: busy }) : null,
    kind === 'human' ? h('div', { key: 'human', style: styles.list }, [h(PMSelect, { key: 'p', label: '在岗岗位', value: positionId, onChange: setPositionId, disabled: busy, options: [['', '请选择'], ...activePositions.map((p) => [p.id, p.name])] }), h('span', { key: 'hint', style: styles.muted }, '岗位从创建时开始在岗，暂不设截止时间。登录身份需另行绑定；本次创建不接入账号。人的能力来自在岗岗位。'), !activePositions.length ? h(PMEmpty, { key: 'e' }, '没有可选的在岗岗位，需先配置岗位。') : null]) : h('div', { key: 'bot', style: styles.list }, [
      h(PMSelect, { key: 'owner', label: '责任人（人）', value: ownerHumanId, onChange: setOwnerHumanId, disabled: busy, options: [['', '请选择'], ...activeHumans.map((p) => [p.id, p.name])] }),
      h('div', { key: 'config', style: styles.grid }, [
        h(ModelSelect, { key: 'm', catalog, value: model, onChange: setModel, disabled: busy, labelKeys: { model: '模型' } }),
        h(PresetSelect, { key: 'p', catalog, value: preset, onChange: setPreset, disabled: busy }),
      ]),
      h('strong', { key: 'caphead' }, '工具能力白名单'), h('div', { key: 'caps', style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, BOT_CAPABILITIES.map(([key, label]) => h('label', { key, style: { display: 'inline-flex', gap: 5, alignItems: 'center' } }, [h('input', { key: 'i', type: 'checkbox', checked: capabilities.includes(key), disabled: busy, onChange: () => toggle(key) }), label]))),
      h('span', { key: 'limits', style: styles.muted }, '审批决策：只有人能在界面批准。bot 的宿主工具与官方 standard preset 对齐；HAMS 业务动作按能力白名单授予，授权限定在所填业务域。'),
    ]),
    h('div', { key: 'actions', style: styles.row }, [h(PMButton, { key: 's', primary: true, disabled: busy || !valid || !onSubmit, onClick: () => onSubmit({ kind, name: name.trim(), role, domain: domain.trim() || undefined, responsibility: responsibility.trim(), positionId: kind === 'human' ? positionId : undefined, ownerHumanId: kind === 'bot' ? ownerHumanId : undefined, agentPreset: kind === 'bot' ? preset.trim() || undefined : undefined, model: kind === 'bot' ? model.trim() || undefined : undefined, capabilities: kind === 'bot' ? capabilities : undefined, scope: kind === 'bot' ? `domain:${domain.trim()}` : undefined }) }, busy ? '提交中…' : kind === 'bot' ? '创建并发布 v1' : '创建成员'), h(PMButton, { key: 'cancel', disabled: busy, onClick: onCancel }, '取消')]),
  ]);
}
function PMMemberEditor({ detail, busy, onCommand }) {
  const catalog = useHostCatalog();
  const config = detail.config || detail.current_config || (detail.bot_versions || []).find((v) => v.version === detail.current_version) || {};
  const prefix = `pm/member-config/${detail.id}/${detail.current_version}/`;
  const initialMemory = JSON.stringify(config.memory_scope || PMParse(config.memory_scope_json, {}) || {}, null, 2);
  const [responsibility, setResponsibility] = usePMDraft(prefix + 'responsibility', detail.responsibility || config.responsibility || '');
  const initialPrompt = config.prompt || detail.prompt || '';
  const [prompt, setPrompt] = usePMDraft(prefix + 'prompt', initialPrompt);
  const [model, setModel] = usePMDraft(prefix + 'model', config.model || detail.model || '');
  const [preset, setPreset] = usePMDraft(prefix + 'preset', config.agent_preset || detail.agent_preset || '');
  const [memory, setMemory] = usePMDraft(prefix + 'memory', initialMemory);
  const [changeClass, setChangeClass] = usePMDraft(prefix + 'changeClass', 'minor');
  const state = usePMCommand(onCommand); const canPublish = PMAllowed(detail, 'publishConfig');
  // 默认只读：点「编辑」才进入可改状态，避免误改线上配置；取消回到原值。
  const [editing, setEditing] = React.useState(false);
  const locked = busy || state.pending || !canPublish || !editing;
  const parsedMemory = PMParse(memory, null); const validMemory = parsedMemory && typeof parsedMemory === 'object' && !Array.isArray(parsedMemory);
  const needsMajor = prompt.trim() !== initialPrompt.trim() || model !== (config.model || detail.model || '') || preset !== (config.agent_preset || detail.agent_preset || '') || JSON.stringify(parsedMemory) !== JSON.stringify(config.memory_scope || PMParse(config.memory_scope_json, {}));
  const reset = () => {
    setResponsibility(detail.responsibility || config.responsibility || '');
    setPrompt(initialPrompt);
    setModel(config.model || detail.model || '');
    setPreset(config.agent_preset || detail.agent_preset || '');
    setMemory(initialMemory);
    setChangeClass('minor');
    PMClearDraft(prefix);
    setEditing(false);
  };
  const publish = () => state.execute('member/publishConfig', { memberId: detail.id, changeClass, responsibility: responsibility.trim(), prompt: prompt.trim(), model: model.trim() || null, agentPreset: preset.trim() || null, memoryScope: parsedMemory }, () => { PMClearDraft(prefix); setEditing(false); });
  return h('section', { style: styles.card }, [
    h('div', { key: 'h', style: styles.row }, [
      h('strong', { key: 't' }, `配置 · 当前 v${detail.current_version}`),
      !canPublish
        ? h('span', { key: 'ro', style: styles.muted }, detail.subagent_session_id ? '这是宿主 subagent 的 HAMS 记录：职责与提示词可以查看/修改，但已创建的宿主会话不会因此改变。' : '只读：当前成员配置需要成员管理权限')
        : editing
          ? h('div', { key: 'acts', style: { display: 'flex', gap: 6 } }, [
              h(PMButton, { key: 'cancel', disabled: busy || state.pending, onClick: reset }, '取消'),
              h(PMButton, { key: 'publish', primary: true, disabled: busy || state.pending || !onCommand || (needsMajor && changeClass !== 'major') || !validMemory || !responsibility.trim(), onClick: publish }, state.pending ? '发布中…' : '保存并发布新版本'),
            ])
          : h(PMButton, { key: 'edit', disabled: busy, onClick: () => setEditing(true) }, '编辑'),
    ]),
    h(ErrorBox, { key: 'err', error: state.error, onDismiss: state.dismiss }),
    h(PMInput, { key: 'resp', label: '职责', value: responsibility, onChange: setResponsibility, multiline: true, disabled: locked }),
    h(PMInput, { key: 'prompt', label: '提示词（这个 bot 的人设；会注入它的会话）', value: prompt, onChange: setPrompt, multiline: true, disabled: locked, placeholder: '例如：你只做告警复查，先看证据再下结论；不要替人关单。' }),
    h('div', { key: 'g', style: styles.grid }, [
      h(ModelSelect, { key: 'model', catalog, value: model, onChange: setModel, disabled: locked, labelKeys: { model: '模型' } }),
      h(PresetSelect, { key: 'preset', catalog, value: preset, onChange: setPreset, disabled: locked }),
    ]),
    h(PMInput, { key: 'memory', label: '记忆范围（JSON 对象）', value: memory, onChange: setMemory, multiline: true, disabled: locked }),
    !validMemory && editing ? h('span', { key: 'invalid', style: { color: C.warn } }, '记忆范围必须是有效的 JSON 对象。') : null,
    h('fieldset', { key: 'class', disabled: locked, style: { border: 'none', borderRadius: 8, background: C.tint, padding: '8px 12px', display: 'flex', gap: 12 } }, [h('legend', { key: 'l', style: styles.muted }, '变更级别'), ...[['minor', '小改'], ['major', '大改']].map(([value, label]) => h('label', { key: value }, [h('input', { key: 'i', type: 'radio', name: `change-${detail.id}`, checked: changeClass === value, disabled: locked, onChange: () => setChangeClass(value) }), label]))]),
    h('div', { key: 'impact', style: { ...styles.muted, lineHeight: 1.8 } }, changeClass === 'major' ? '大改：相关工作项下次运行前自动换新会话，旧会话只读保留。正在运行的执行继续使用冻结版本。' : '小改：已有会话继续使用原配置，可在工作项详情手动换新会话。正在运行的执行继续使用冻结版本。'),
    needsMajor && changeClass === 'minor' && editing ? h('span', { key: 'major', style: { color: C.warn } }, '提示词、模型、preset 或记忆范围已变化，请选择大改（改提示词必须换新会话才会生效）。') : null,
    !editing && canPublish ? h('span', { key: 'hint', style: styles.muted }, '点右上「编辑」修改；保存会发布一个新版本，正在运行的执行继续使用冻结版本。') : null,
  ]);
}
function PMMemberDetail({ detail, busy, onCommand, onStatus, onOpenWorkItem, onClose, initialTab }) {
  const [tab, setTab] = React.useState(initialTab || (detail.kind === 'bot' ? 'chat' : 'config')); const [compare, setCompare] = React.useState(''); const state = usePMCommand(onCommand);
  const versions = detail.bot_versions || []; const config = detail.config || detail.current_config || versions.find((v) => v.version === detail.current_version) || {};
  const previous = versions.find((v) => String(v.version) === compare); const latest = versions.find((v) => v.version === detail.current_version) || config;
  const skills = config.skills || (config.skills_json ? PMParse(config.skills_json, []) : detail.skills) || [];
  return h('section', { style: styles.page }, [
    // 名称、标识与操作同一行：状态动作贴右上，不再单独占一行把简介挤下去。
    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
      h('h2', { key: 'n', style: { ...styles.title, margin: 0 } }, detail.name),
      h('span', { key: 'b', style: { display: 'inline-flex', gap: 6 } }, [badge(detail.kind === 'bot' ? 'bot' : '人', detail.kind === 'bot' ? C.accent : C.ok), badge(({ active: '在岗', paused: '暂停', retired: '已退休' })[detail.status] || detail.status)]),
      h('div', { key: 'a', style: { marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
        ...['pause', 'resume', 'retire'].filter((a) => PMAllowed(detail, a)).map((a) => h(PMButton, { key: a, disabled: busy || state.pending || (!onCommand && !onStatus), onClick: () => onCommand ? state.execute('member/status', { memberId: detail.id, status: { pause: 'paused', resume: 'active', retire: 'retired' }[a] }) : onStatus(a) }, { pause: '暂停分派', resume: '恢复在岗', retire: '退休' }[a])),
        onClose ? h(PMButton, { key: 'close', onClick: onClose }, '✕ 关闭') : null,
      ]),
    ]),
    h(ErrorBox, { key: 'err', error: state.error, onDismiss: state.dismiss }),
    // 指标横排 + 热力图占 1/4 宽，同一个区块里左右对齐；简介挪到区块最下面。
    h('section', { key: 'pulse', style: { ...styles.card, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(200px,25%)', gap: 12, alignItems: 'center' } }, [
      h('div', { key: 'stats', style: { display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 } }, [
        h(Stat, { key: 'o', label: '未结工作', value: detail.work ? detail.work.open : '未知' }),
        h(Stat, { key: 't', label: '累计工作', value: detail.work ? detail.work.total : '未知' }),
        h(Stat, { key: 'r', label: '执行记录', value: detail.runs ? detail.runs.total : '未知' }),
      ]),
      h(PMHeatmap, { key: 'heatmap', activity: detail.activity, showLegend: false }),
      h('div', { key: 'intro', style: { gridColumn: '1 / -1', paddingTop: 10, display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', color: C.muted, fontSize: 12, lineHeight: 1.7 } }, [
        h('span', { key: 't', style: { flex: '1 1 320px', minWidth: 0 } }, [
          h('span', { key: 'l', style: { fontWeight: 600, marginRight: 8, color: 'inherit' } }, '简介'),
          `${detail.domain || '未分域'} · ${detail.role || '未分配角色'} · ${detail.responsibility || '未填职责'}`,
        ]),
        h('span', { key: 'legend', style: { flex: '0 1 auto', fontSize: 11 } }, PMHeatLegend(detail.activity)),
      ]),
    ]),
    h(PMTabs, { key: 'tabs', tabs: detail.kind === 'bot' ? [['chat', '对话'], ...PM_MEMBER_TABS] : [['config', '基本信息'], ['permissions', '岗位与权限'], ['runs', '工作记录']], value: tab, onChange: setTab, label: '成员页签' }),
    tab === 'chat' && detail.kind === 'bot' ? h(ChatPane, { key: 'chat', kind: 'member', targetId: detail.id, title: detail.name }) : null,
    tab === 'config' ? detail.kind === 'bot' ? h(PMMemberEditor, { key: `edit-${detail.id}-${detail.current_version}`, detail, busy, onCommand }) : h('div', { key: 'human', style: styles.list }, [h('span', { key: 'login', style: styles.muted }, detail.login ? `登录身份 ${detail.login.login} · ${detail.login.auth_source}` : '尚未绑定登录身份'), h(PMWorkList, { key: 'work', items: detail.recent_work || [], onOpen: onOpenWorkItem })]) : null,
    tab === 'skills' ? h('div', { key: 'skills', style: styles.list }, [skills.length ? h(PMJson, { key: 'v', value: skills }) : h(PMEmpty, { key: 'e' }, '当前配置没有绑定技能'), h('span', { key: 'n', style: styles.muted }, '技能版本随配置冻结。')]) : null,
    tab === 'memory' ? h('div', { key: 'memory', style: styles.list }, [
      h('section', { key: 'scope', style: styles.card }, [
        h('strong', { key: 'h' }, '配置里的记忆范围'),
        h('span', { key: 'd', style: styles.muted }, '随配置版本发布；改它要走大改并换新会话。'),
        h(PMJson, { key: 'v', value: config.memory_scope || PMParse(config.memory_scope_json, {}) }),
      ]),
      h('section', { key: 'synced', style: styles.card }, [
        h('strong', { key: 'h' }, `从项目同步的能力记忆（${(detail.memories || []).length}）`),
        h('span', { key: 'd', style: styles.muted }, '项目「记忆」里标记为能力、且归属这个 bot 的条目，会镜像到这里并进入它的会话上下文。'),
        ...(detail.memories || []).map((memory) => h('article', { key: memory.id, style: styles.item }, [
          h('div', { key: 'r', style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } }, [
            badge(PMMemoryKindLabel(memory.kind), PM_MEMORY_KIND_COLOR[memory.kind] || C.muted),
            h('strong', { key: 't' }, memory.title),
            memory.project_name ? h('span', { key: 'p', style: styles.muted }, memory.project_name) : null,
          ]),
          h('div', { key: 'b', style: { lineHeight: 1.8, whiteSpace: 'pre-wrap' } }, memory.body),
          h('div', { key: 'm', style: styles.muted }, fmtTime(memory.created_at)),
        ])),
        (detail.memories || []).length ? null : h(PMEmpty, { key: 'e' }, '还没有从项目同步能力记忆。'),
      ]),
    ]) : null,
    tab === 'permissions' ? h('div', { key: 'permissions', style: styles.list }, [h('strong', { key: 'h' }, detail.kind === 'bot' ? '工具能力白名单' : '在岗岗位与历史'), ...(detail.position_history || []).map((p, i) => h('div', { key: `${p.position_id}-${i}`, style: styles.item }, [h('strong', { key: 'n' }, p.position_name), h('span', { key: 'dates', style: styles.muted }, `${fmtTime(p.starts_at)} — ${p.ends_at ? fmtTime(p.ends_at) : '无截止'} · ${p.active ? '在岗' : '不在岗'}`)])), h(Chips, { key: 'caps', items: (detail.capabilities || []).map((key) => (BOT_CAPABILITIES.find(([value]) => value === key) || [key, key])[1]), empty: detail.kind === 'human' ? '没有在岗岗位，只能查看' : '尚未授权能力' }), ...(detail.permissions || []).map((p, i) => h('span', { key: `scope-${i}`, style: styles.muted }, `${p.capability} · 授权范围 ${p.scope}`)), detail.kind === 'bot' ? h('span', { key: 'limits', style: styles.muted }, '审批决策：只有人能在界面批准。业务 bot 不提供通用 shell 或文件写入，不跨业务域、不改自己的权限。') : null]) : null,
    tab === 'versions' ? h('div', { key: 'versions', style: styles.list }, [h(PMSelect, { key: 'select', label: '与当前版本对比', value: compare, onChange: setCompare, options: [['', '选择历史版本'], ...versions.map((v) => [String(v.version), `v${v.version} · ${v.change_class === 'major' ? '大改' : '小改'}`])] }), previous ? h('div', { key: 'compare', style: styles.grid }, [h('div', { key: 'old', style: styles.card }, [h('strong', { key: 't' }, `v${previous.version}`), h(PMJson, { key: 'v', value: previous })]), h('div', { key: 'new', style: styles.card }, [h('strong', { key: 't' }, `当前 v${detail.current_version}`), h(PMJson, { key: 'v', value: latest })])]) : null, ...versions.map((v) => h('details', { key: v.id || v.version, style: styles.item }, [h('summary', { key: 's' }, `v${v.version} · ${v.change_class === 'major' ? '大改' : '小改'} · ${fmtTime(v.published_at || v.created_at)}`), h(PMJson, { key: 'config', value: v })])), !versions.length ? h(PMEmpty, { key: 'e' }, '还没有配置版本') : null]) : null,
    tab === 'runs' ? h('div', { key: 'runs', style: styles.list }, [h(PMWorkList, { key: 'w', items: detail.recent_work || [], onOpen: onOpenWorkItem }), ...(detail.recent_runs || []).map((run) => h('div', { key: run.id, style: styles.item }, [h('span', { key: 's' }, `执行 ${run.status} · ${fmtTime(run.created_at)}`), h('span', { key: 'v', style: styles.muted }, `配置 ${run.bot_version || run.bot_version_id || '未知'} · 工作项 ${run.work_item_id || '未知'}`)]))]) : null,
  ]);
}
function MemberScreen({ members = [], detail, positions = [], busy, formOpen, filter = 'all', onFilter, onCreate, onOpen, onFormOpen, onStatus, onCommand, allowedActions = [], onOpenWorkItem, onClose, initialTab }) {
  const [query, setQuery] = React.useState(''); const [localFilter, setLocalFilter] = React.useState(filter); const state = usePMCommand(onCommand);
  const selectedFilter = onFilter ? filter : localFilter; const humans = members.filter((m) => m.kind === 'human'); const canCreate = PMAllowed({ allowedActions }, 'create');
  const visible = members.filter((m) => (selectedFilter === 'all' || m.kind === selectedFilter) && [m.name, m.domain, m.responsibility].some((v) => String(v || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  // 新建成员独立成页：保存或取消都回到列表
  if (formOpen) {
    return h(PMPage, { key: 'member-create', backLabel: '← 返回成员列表', onBack: onFormOpen, crumb: '人机成员 / 新建成员' },
      h(MemberCreateForm, {
        key: 'form', positions, humans, busy: busy || state.pending || !canCreate,
        onSubmit: (input) => { if (!canCreate) return; if (onCommand) state.execute('member/create', input, () => PMClearDraft('pm/member-create/')); else if (onCreate) onCreate(input); },
        onCancel: onFormOpen,
      }));
  }

  // 成员详情独立成页：与其他屏交互一致
  if (detail) {
    return h(PMPage, { key: `member-${detail.id}`, backLabel: '← 返回成员列表', onBack: onClose, crumb: `${detail.kind === 'bot' ? 'bot' : '人'} / ${detail.name}` },
      h(PMMemberDetail, { key: detail.id, detail, busy, onCommand, onStatus, onOpenWorkItem, initialTab }));
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [
    h('div', { key: 'h', style: styles.row }, [h('h1', { key: 't', style: styles.title }, '人机成员'), h('span', { key: 'n', style: styles.muted }, `${members.length} 个成员：人 ${humans.length} · bot ${members.length - humans.length}`), h(PMButton, { key: 'new', primary: true, disabled: busy || !canCreate, onClick: onFormOpen }, '新建成员')]),
    h(ErrorBox, { key: 'err', error: state.error, onDismiss: state.dismiss }),
    h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
      h('input', {
        key: 'q', type: 'search', value: query, 'aria-label': '搜索成员', placeholder: '搜索成员：名称、业务域或职责',
        onChange: (e) => setQuery(e.target.value),
        style: { ...styles.input, flex: '1 1 220px', maxWidth: 360, height: 30, padding: '0 10px', boxSizing: 'border-box' },
      }),
      ...([['all', '全部'], ['human', '人'], ['bot', 'bot']]).map(([value, text]) => h(PMButton, { key: value, primary: selectedFilter === value, style: { height: 30, padding: '0 12px' }, onClick: () => onFilter ? onFilter(value) : setLocalFilter(value) }, text)),
      h('span', { key: 'n', style: { marginLeft: 'auto', ...styles.muted } }, `${visible.length} / ${members.length} 个`),
    ]),
    visible.length
      ? h('div', { key: 'list', style: styles.list }, visible.map((m) => {
          // 一张卡两行、头像纵向跨两行：第一行身份与在岗，第二行当前工作量与配置。
          const statusText = ({ active: '在岗', paused: '暂停', retired: '退休' })[m.status] || m.status;
          const active = m.status === 'active';
          const open = m.work && Number.isFinite(m.work.open) ? m.work.open : null;
          return h('article', {
            key: m.id,
            style: { ...styles.item, display: 'grid', gridTemplateColumns: '44px minmax(0,1fr)', columnGap: 12, rowGap: 3, alignItems: 'start', padding: '12px 14px' },
          }, [
            h('div', { key: 'av', style: { gridRow: '1 / span 2', display: 'flex', alignItems: 'center' } }, avatar(m.name, 44, m.kind)),
            h('div', { key: 'r1', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
              h(PMButton, { key: 'n', onClick: () => onOpen(m.id), style: { flex: 'none', padding: 0, border: 0, background: 'transparent', color: 'inherit', fontSize: 13.5, fontWeight: 600 } }, m.name),
              badge(m.kind === 'bot' ? 'bot' : '人', m.kind === 'bot' ? C.accent : C.ok),
              h('span', { key: 'd', title: m.responsibility || m.role || '', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted, fontSize: 12 } }, m.responsibility || m.role || '未写职责'),
              h('span', { key: 's', style: { marginLeft: 'auto', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: active ? C.ok : C.muted } }, [
                h('span', { key: 'dot', 'aria-hidden': 'true', style: { width: 6, height: 6, borderRadius: 3, background: active ? C.ok : C.muted } }),
                statusText,
              ]),
            ]),
            h('div', { key: 'r2', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap', fontSize: 11.5, color: C.muted } }, [
              h('span', { key: 'w' }, `当前未结 ${open === null ? '未知' : `${open} 项`}`),
              h('span', { key: 'sep1', 'aria-hidden': 'true' }, '·'),
              h('span', { key: 'dom' }, m.domain || '未分域'),
              h('span', { key: 'sep2', 'aria-hidden': 'true' }, '·'),
              h('span', { key: 'role' }, ({ coordinator: '协调', executor: '执行', observer: '观察' })[m.role] || m.role || '未分配角色'),
              h('span', { key: 'sep3', 'aria-hidden': 'true' }, '·'),
              h('span', { key: 'ver' }, `配置 ${m.current_version ? `v${m.current_version}` : '未发布'}`),
              m.positions && m.positions.length ? h('span', { key: 'pos' }, `· 岗位 ${m.positions.map((p) => p.name).join('、')}`) : null,
            ]),
          ]);
        }))
      : h(PMEmpty, { key: 'e' }, members.length ? '没有符合条件的成员' : '还没有成员，先新建一个 bot 或人。'),
  ]);
}

    function metricVerdict(metric) {
      const value = metric.latest && metric.latest.value;
      if (value === null || value === undefined || !Number.isFinite(value) || metric.target_value === null || metric.target_value === undefined || !metric.calculator_key || !metric.source_kind) return 'unknown';
      if (metric.direction === 'range') return metric.target_max === null || metric.target_max === undefined ? 'unknown' : value >= metric.target_value && value <= metric.target_max ? 'met' : 'miss';
      return (metric.direction === 'lower' ? value <= metric.target_value : value >= metric.target_value) ? 'met' : 'miss';
    }

    function MetricRow({ metric, busy, onRecord }) {
      const [value, setValue] = React.useState('');
      const unit = metric.unit || '';
      const latest = !metric.latest
        ? '没有读数'
        : metric.latest.value === null
          ? '未知（缺数）'
          : `${metric.latest.value}${unit}`;
      const target = metric.target_value === null || metric.target_value === undefined
        ? '未设目标'
        : `${metric.target_value}${metric.direction === 'range' ? `–${metric.target_max ?? '未知'}` : ''}${unit}`;
      const result = metricVerdict(metric);
      const color = result === 'met' ? C.ok : result === 'miss' ? C.warn : C.muted;
      return h('div', { style: styles.item }, [
        h('div', { key: 'r', style: styles.row }, [
          h('span', { key: 'v', style: styles.badge(color) }, `最新 ${latest} · ${{met:'已达标',miss:'未达标',unknown:'未知'}[result]}`),
        ]),
        h('div', { key: 'd', style: styles.muted },
          `目标 ${target} · ${metric.direction === 'lower' ? '越低越好' : metric.direction === 'range' ? '区间' : '越高越好'} · ${metric.window_kind} · 来源 ${metric.source_kind || '未指定'}`),
        h('div', { key: 'a', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' } }, [
          h(Field, { key: 'i', label: '本次读数', value, onChange: setValue, type: 'number' }),
          h('button', {
            key: 's', style: styles.button(true), disabled: busy || value === '',
            onClick: () => onRecord(metric.id, Number(value)),
          }, '记录'),
          h('button', { key: 'x', style: styles.button(false), disabled: busy, onClick: () => onRecord(metric.id, null) }, '记缺数'),
        ]),
        metric.series && metric.series.length > 1
          ? h('div', { key: 's', style: styles.muted }, `最近 ${metric.series.length} 次：${metric.series.map((point) => point.value === null ? '未知' : point.value).join(' / ')}`)
          : null,
      ]);
    }

    function DocCreateForm({ busy, onSubmit, onCancel }) {
      const [title, setTitle] = React.useState('');
      const [body, setBody] = React.useState('');
      const [projectId, setProjectId] = React.useState('');
      const [dueAt, setDueAt] = React.useState('');
      const projects = [];
      return h('div', { style: styles.card }, [
        h('strong', { key: 't' }, '新建知识文档'),
        h('label', { key: 'project', style: styles.list }, [
          h('span', { key: 'l', style: styles.muted }, '所属项目'),
          h('select', { key: 's', style: styles.input, value: projectId, onChange: e => setProjectId(e.target.value), 'aria-label': '所属项目' }, [h('option', {key:'none',value:''}, '不关联项目'), ...projects.map(p => h('option', {key:p.id,value:p.id},p.name))]),
        ]),
        h(Field, {key:'due',label:'截止时间（可选）',type:'datetime-local',value:dueAt,onChange:setDueAt}),
        h(Field, { key: 'ti', label: '标题', value: title, onChange: setTitle }),
        h('label', { key: 'b', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }, [
          h('span', { key: 'l', style: styles.muted }, '正文（Markdown；落成真实文件，改稿留旧版本）'),
          h('textarea', {
            key: 't', value: body, style: { ...styles.input, minHeight: 120, resize: 'vertical' },
            onChange: (e) => setBody(e.target.value),
          }),
        ]),
        h('div', { key: 'a', style: { display: 'flex', gap: 7 } }, [
          h('button', { key: 's', style: styles.button(true), disabled: busy || !title.trim() || !body.trim(), onClick: () => onSubmit({ title: title.trim(), body }) }, '保存草稿'),
          h('button', { key: 'c', style: styles.button(false), disabled: busy, onClick: onCancel }, '取消'),
        ]),
      ]);
    }

    function DocEditForm({ detail, busy, onSubmit, onCancel }) {
      const [title, setTitle] = useDraft(`doc:${detail.id}:title`, detail.title);
      const [body, setBody] = useDraft(`doc:${detail.id}:body`, detail.content);
      const [projectId, setProjectId] = React.useState('');
      const [dueAt, setDueAt] = React.useState('');
      const projects = [];
      return h('div', { key: 'ef', style: { ...styles.card } }, [
        h('strong', { key: 't' }, `编辑文档（基于 v${detail.revision}）`),
        h('label', { key: 'project', style: styles.list }, [
          h('span', { key: 'l', style: styles.muted }, '所属项目'),
          h('select', { key: 's', style: styles.input, value: projectId, onChange: e => setProjectId(e.target.value), 'aria-label': '所属项目' }, [h('option', {key:'none',value:''}, '不关联项目'), ...projects.map(p => h('option', {key:p.id,value:p.id},p.name))]),
        ]),
        h(Field, {key:'due',label:'截止时间（可选）',type:'datetime-local',value:dueAt,onChange:setDueAt}),
        h(Field, { key: 'ti', label: '标题', value: title, onChange: setTitle }),
        h('textarea', {
          key: 'b', value: body, style: { ...styles.input, minHeight: 150, resize: 'vertical' },
          onChange: (event) => setBody(event.target.value),
        }),
        h('div', { key: 'a', style: { display: 'flex', gap: 7 } }, [
          h('button', {
            key: 's', style: styles.button(true), disabled: busy || !body.trim(),
            onClick: () => onSubmit({ docId: detail.id, title: title.trim(), body, expectedRevision: detail.revision }),
          }, busy ? '提交中…' : '保存新版本'),
          h('button', { key: 'c', style: styles.button(false), disabled: busy, onClick: onCancel }, '取消'),
        ]),
        h('div', { key: 'h', style: styles.muted }, '保存前会把当前版本复制为 .v<修订号>.md；期望修订号不匹配时后端拒绝，不覆盖他人修改。'),
      ]);
    }

    function ImportForm({ busy, onSubmit, onCancel }) {
      const [dir, setDir] = React.useState('');
      const [recursive, setRecursive] = React.useState(true);
      return h('div', { style: styles.card }, [
        h('strong', { key: 't' }, '导入本机 Markdown'),
        h(Field, { key: 'd', label: '目录（绝对路径或 ~/...）', value: dir, onChange: setDir, placeholder: '~/notes' }),
        h('label', { key: 'r', style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } }, [
          h('input', { key: 'i', type: 'checkbox', checked: recursive, onChange: (e) => setRecursive(e.target.checked) }),
          h('span', { key: 't' }, '递归子目录（最多 4 层，单文件 ≤ 2MB，最多 500 个）'),
        ]),
        h('div', { key: 'a', style: { display: 'flex', gap: 7 } }, [
          h('button', { key: 's', style: styles.button(true), disabled: busy || !dir.trim(), onClick: () => onSubmit({ dir: dir.trim(), recursive }) }, busy ? '扫描中…' : '开始导入'),
          h('button', { key: 'c', style: styles.button(false), disabled: busy, onClick: onCancel }, '取消'),
        ]),
        h('div', { key: 'h', style: styles.muted }, '只登记路径与内容哈希，不复制文件；源文件改动后重新导入会升版。跳过隐藏目录、node_modules、_build、.git。'),
      ]);
    }

    // 极简 Markdown 渲染：覆盖文档预览常用语法。客户端只能 require('react')，不引第三方 md 库。
    function mdInline(text, keyPrefix) {
      const src = String(text == null ? '' : text); const out = []; let last = 0; let n = 0;
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]*\]\([^)\s]+\)|\*[^*\n]+\*)/g;
      let match;
      while ((match = re.exec(src))) {
        if (match.index > last) out.push(src.slice(last, match.index));
        const token = match[0]; const key = `${keyPrefix}-${n++}`;
        if (token.startsWith('**')) out.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('`')) out.push(h('code', { key, style: { background: C.soft, padding: '0 4px', borderRadius: 3, fontSize: 11.5, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' } }, token.slice(1, -1)));
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
          out.push(link ? h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]) : token);
        } else out.push(h('em', { key }, token.slice(1, -1)));
        last = match.index + token.length;
      }
      if (last < src.length) out.push(src.slice(last));
      return out.length ? out : [''];
    }

    function renderMarkdown(text, keyPrefix) {
      const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
      const prefix = keyPrefix || 'md'; const blocks = []; let i = 0; let n = 0;
      const nextKey = () => `${prefix}-b${n++}`;
      const cell = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((part) => part.trim());
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (/^\s*```/.test(line)) {
          const body = []; i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
          i++;
          blocks.push(h('pre', { key: nextKey(), style: { margin: '8px 0', padding: '10px 12px', background: C.soft, borderRadius: 6, overflowX: 'auto', fontSize: 11.5, lineHeight: 1.6 } }, h('code', null, body.join('\n'))));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length; const size = [19, 17, 15, 14, 13, 12][level - 1];
          blocks.push(h('div', { key: nextKey(), style: { fontSize: size, fontWeight: 600, margin: '14px 0 6px', lineHeight: 1.4 } }, mdInline(heading[2], 'h')));
          i++; continue;
        }
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
          blocks.push(h('div', { key: nextKey(), style: { height: 12 } }));
          i++; continue;
        }
        if (/^>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
          blocks.push(h('div', { key: nextKey(), style: { padding: '6px 10px', border: 'none', borderRadius: 6, background: C.tint, color: C.muted, margin: '8px 0', lineHeight: 1.7 } }, mdInline(quote.join(' '), 'q')));
          continue;
        }
        if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1])) {
          const head = cell(line); i += 2; const rows = [];
          while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { rows.push(cell(lines[i])); i++; }
          blocks.push(h('table', { key: nextKey(), style: { borderCollapse: 'collapse', fontSize: 12, margin: '8px 0' } }, [
            h('thead', { key: 'h' }, h('tr', { key: 'r' }, head.map((part, ci) => h('th', { key: ci, style: { textAlign: 'left', padding: '6px 10px', border: 'none', background: C.tintStrong, fontWeight: 600 } }, mdInline(part, `th${ci}`))))),
            h('tbody', { key: 'b' }, rows.map((row, ri) => h('tr', { key: ri }, row.map((part, ci) => h('td', { key: ci, style: { padding: '6px 10px', border: 'none', background: ri % 2 ? C.tint : 'transparent' } }, mdInline(part, `td${ri}-${ci}`)))))),
          ]));
          continue;
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\./.test(line); const items = [];
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++; }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: nextKey(), style: { margin: '6px 0', paddingLeft: 22, lineHeight: 1.8 } }, items.map((item, ii) => h('li', { key: ii }, mdInline(item, `li${ii}`)))));
          continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim()
          && !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+\.\s||---+|\*\*\*+|___+)\s*$/.test(lines[i])
          && !/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])) { para.push(lines[i]); i++; }
        if (para.length) blocks.push(h('p', { key: nextKey(), style: { margin: '6px 0', lineHeight: 1.75 } }, mdInline(para.join('\n'), 'p')));
        else { blocks.push(h('p', { key: nextKey(), style: { margin: '6px 0', lineHeight: 1.75 } }, lines[i++])); }
      }
      return blocks.length ? blocks : [h('span', { key: `${prefix}-empty`, style: styles.muted }, '（空文档）')];
    }

    function KnowledgeScreen({ data, detail, busy, form, report, importReport, onForm, onOpen, onSync, onCreateDoc, onImport, onPublish, onEdit, editing, onCancelEdit, capabilities }) {
      const writable = !capabilities || capabilities.includes('knowledge.write');
      const syncable = !capabilities || capabilities.includes('knowledge.sync');
      const [kind, setKind] = React.useState('all');
      const [q, setQ] = React.useState('');
      // 放大：只隐藏左侧文件列表，预览占满整行；再点「还原」回来。
      const [expanded, setExpanded] = React.useState(false);
      const items = (data && data.items) || [];
      const visible = items.filter((item) =>
        (kind === 'all' || item.kind === kind)
        && (!q.trim() || `${item.name || ''} ${item.title || ''} ${item.subtitle || ''}`.toLowerCase().indexOf(q.trim().toLowerCase()) >= 0));
      const detailCard = detail
        ? (function () {
            const head = [
              h('div', { key: 'h', style: styles.row }, [
                h('strong', { key: 't' }, detail.kind === 'doc' ? detail.title : detail.name),
                h('div', { key: 'acts', style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } }, [
                  badge(KNOWLEDGE_KIND_LABEL[detail.kind] || detail.kind, C.accent),
                  h('button', {
                    key: 'zoom', type: 'button', 'aria-pressed': expanded,
                    title: expanded ? '还原列表与预览两栏' : '放大预览（隐藏左侧文件列表）',
                    onClick: () => setExpanded((value) => !value),
                    style: { ...styles.button(false), height: 24, padding: '0 8px', fontSize: 11, flex: 'none' },
                  }, expanded ? '还原' : '放大'),
                ]),
              ]),
              // 文档的 subtitle 往往就是源文件路径：和下面那行重复时只留一次。
              detail.subtitle && detail.subtitle !== detail.path ? h('div', { key: 'm', style: styles.muted }, detail.subtitle) : null,
            ];
            // 卡片占满整栏高度：头部固定，正文区自己滚动；操作按钮跟着正文末尾，不会被顶到卡片最底下。
            const cardStyle = { ...styles.card, minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' };
            const body = (children) => h('div', { key: 'body', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 8 } }, children);
            if (detail.kind === 'doc') {
              return h('div', { key: 'd', style: cardStyle }, [
                ...head,
                detail.changed ? h('div', { key: 'ch', style: styles.err }, '磁盘上的源文件已改动，与登记哈希不一致；导入的文档请重新导入。') : null,
                h('div', { key: 's', style: styles.muted },
                  `${KNOWLEDGE_STATUS_LABEL[detail.status] || detail.status} · v${detail.revision} · ${detail.bytes} 字节 · 作者 ${detail.owner_name || detail.owner_id} · ${fmtTime(detail.updated_at)}`),
                h('div', { key: 'p', style: { ...styles.muted, wordBreak: 'break-all' } }, detail.path),
                body([
                  editing && detail.allowedActions.indexOf('edit') >= 0
                    ? h(DocEditForm, { key: 'ef', detail, busy, onSubmit: onEdit, onCancel: onCancelEdit })
                    : h('div', { key: 'md', style: { fontSize: 12.5 } }, renderMarkdown(detail.content, `doc-${detail.id}`)),
                  detail.truncated
                    ? h('div', { key: 'tr', style: styles.muted }, '正文超过 16000 字的预览上限：面板内编辑会截断，请用外部编辑器改源文件。')
                    : null,
                  h('div', { key: 'a', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    (detail.allowedActions || []).filter((action) => action !== 'edit' || !detail.truncated).map((action) => h('button', {
                      key: action, style: styles.button(action === 'publish'), disabled: busy || !writable,
                      onClick: () => action === 'publish' ? onPublish(detail.id) : onForm('edit'),
                    }, action === 'publish' ? '发布' : '编辑正文'))),
                ]),
              ]);
            }
            if (detail.kind === 'skill') {
              return h('div', { key: 'd', style: cardStyle }, [
                ...head,
                h('div', { key: 's', style: styles.muted },
                  `版本 ${detail.version || '—'} · 哈希 ${(detail.content_hash || '').slice(0, 12)} · 已发布 ${fmtTime(detail.published_at)} · 缺失源文件 ${detail.present ? '否' : '是'}`),
                h('div', { key: 'p', style: { ...styles.muted, wordBreak: 'break-all' } }, detail.path || '（无路径）'),
                detail.description ? h('div', { key: 'desc' }, detail.description) : null,
                detail.when_to_use ? h('div', { key: 'wu', style: styles.muted }, `何时使用：${detail.when_to_use}`) : null,
                body([
                  detail.content
                    ? h('div', { key: 'md', style: { fontSize: 12.5 } }, renderMarkdown(detail.content, `skill-${detail.id}`))
                    : h('div', { key: 'noc', style: styles.muted }, '这个技能没有可预览的正文：源文件可能已从磁盘移除。点下面的「重新同步技能」再试。'),
                  h('div', { key: 'v', style: styles.muted },
                    `历史版本：${(detail.versions || []).map((version) => `${version.version}(${version.status})`).join(' · ')}`),
                  h('div', { key: 'a', style: { display: 'flex', gap: 6 } },
                    (detail.allowedActions || []).map((action) => h('button', {
                      key: action, style: styles.button(true), disabled: busy || !syncable, onClick: onSync,
                    }, '重新同步技能'))),
                ]),
              ]);
            }
            return h('div', { key: 'd', style: cardStyle }, [
              ...head,
              h('div', { key: 's', style: styles.muted },
                `实时行数 ${detail.row_count === null ? '不可读' : detail.row_count} · 列 ${detail.columns_detail.length} · ${detail.live ? '本机库实时读取' : '外部表只登记结构'}`),
              body([
                h('div', { key: 'tw', style: { overflowX: 'auto' } }, h('table', { key: 't', style: { borderCollapse: 'collapse', fontSize: 12 } }, [
                  h('thead', { key: 'h' }, h('tr', { key: 'r' }, [
                    h('th', { key: 'n', style: { textAlign: 'left', padding: '4px 8px', border: 'none', background: C.tintStrong } }, '列'),
                    h('th', { key: 't', style: { textAlign: 'left', padding: '4px 8px', border: 'none', background: C.tintStrong } }, '类型'),
                    h('th', { key: 'p', style: { textAlign: 'left', padding: '4px 8px', border: 'none', background: C.tintStrong } }, '约束'),
                  ])),
                  h('tbody', { key: 'b' }, detail.columns_detail.map((column) =>
                    h('tr', { key: column.name }, [
                      h('td', { key: 'n', style: { padding: '3px 8px' } }, column.name),
                      h('td', { key: 't', style: { padding: '3px 8px' } }, column.type),
                      h('td', { key: 'c', style: { padding: '3px 8px' } }, [column.pk ? '主键 ' : '', column.notnull ? '非空' : ''].join('')),
                    ]))),
                ])),
                h('div', { key: 'note', style: styles.muted }, '只登记列结构与实时行数，不展示行内容；数据仍留在原表。'),
              ]),
            ]);
          })()
        : h('div', { key: 'e', style: { ...styles.card, minWidth: 0, height: '100%', justifyContent: 'center' } }, '左侧选一项看详情');

      // 新建文档 / 导入目录也独立成页：保存或取消都回到知识列表
      if (form === 'doc') {
        return h(PMPage, { key: 'knowledge-create', backLabel: '← 返回知识库', onBack: () => onForm(null), crumb: '知识 / 新建文档' },
          h(DocCreateForm, { key: 'dc', busy, onSubmit: onCreateDoc, onCancel: () => onForm(null) }));
      }
      if (form === 'import') {
        return h(PMPage, { key: 'knowledge-import', backLabel: '← 返回知识库', onBack: () => onForm(null), crumb: '知识 / 导入目录' },
          h(ImportForm, { key: 'im', busy, onSubmit: onImport, onCancel: () => onForm(null) }));
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { key: 'title', style: styles.row }, [
          h('strong', { key: 't', style: { fontSize: 15 } }, '知识资产'),
        ]),
        h('div', { key: 'bar', style: { ...styles.row, justifyContent: 'flex-start' } }, [
          h('button', { key: 'sync', style: styles.button(true), disabled: busy || !syncable, onClick: onSync }, busy ? '同步中…' : '同步真实数据'),
          h('button', { key: 'new', style: styles.button(false), disabled: busy || !writable, onClick: () => onForm('doc') }, '新建文档'),
          h('button', { key: 'imp', style: styles.button(false), disabled: busy || !writable, onClick: () => onForm('import') }, '导入目录'),
          h('span', { key: 'c', style: styles.muted },
            data ? `文档 ${data.counts.docs} · 技能 ${data.counts.skills} · 数据表 ${data.counts.tables}` : '加载中'),
        ]),
        data && data.error
          ? h('div', { key: 'err', style: styles.err }, `知识数据源不可用：${data.error.message || data.error.code}。${data.error.nextStep || ''}`)
          : null,
        report
          ? h('div', { key: 'rep', style: { fontSize: 12, color: C.ok } },
              `同步结果：技能 新增 ${report.skills.created} / 更新 ${report.skills.updated} / 未变 ${report.skills.unchanged} / 缺失 ${report.skills.missing}；数据表 新增 ${report.tables.created} / 更新 ${report.tables.updated}`)
          : null,
        importReport
          ? h('div', { key: 'irep', style: { fontSize: 12, color: C.ok } },
              `导入结果：扫描 ${importReport.scanned} / 新增 ${importReport.imported} / 更新 ${importReport.updated} / 跳过 ${importReport.skipped} / 错误 ${importReport.errors.length}`)
          : null,
        h('div', { key: 'filter', style: { ...styles.row, justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 } }, [
          h('input', {
            key: 'q', style: { ...styles.input, flex: '1 1 200px', minWidth: 160 }, value: q, placeholder: '搜索标题 / 说明',
            onChange: (e) => setQ(e.target.value),
          }),
          ...['all', 'doc', 'skill', 'table'].map((key) => h('button', {
            key, style: styles.tab(kind === key), onClick: () => setKind(key),
          }, { all: '全部', doc: '文档', skill: '技能', table: '数据表' }[key])),
        ]),
        visible.length
          /**
           * 两栏固定：左列表、右详情。原来用 flex + wrap，文档里宽表格/长路径一撑就把详情挤到下一行（跑到列表底下），
           * 所以改成 grid，两栏都 minWidth:0，宽度只受分栏约束、不受内容最小宽度影响。
           */
          ? h('div', { key: 'l', style: { display: 'grid', gridTemplateColumns: expanded ? 'minmax(0,1fr)' : 'minmax(320px,1fr) minmax(0,1.45fr)', gap: 14, alignItems: 'stretch', height: 'calc(100vh - 230px)', minHeight: 320 } }, [
              expanded ? null : h('div', { key: 'col', style: { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 } }, [
              h('div', { key: 'hdr', style: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '0 11px 2px', color: C.muted, fontSize: 11 } }, [
                h('span', { key: 'n', style: { flex: '1 1 auto', minWidth: 0 } }, '文件名'),
                h('span', { key: 'v', style: { flex: 'none', width: 96, textAlign: 'right' } }, '版本'),
                h('span', { key: 'u', style: { flex: 'none', width: 118, textAlign: 'right' } }, '更新时间'),
              ]),
              h('ul', { key: 'ul', style: { ...styles.list, flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 4 } }, visible.map((item) => {
                const name = item.kind === 'doc' ? item.title : item.name;
                const version = item.kind === 'doc'
                  ? `v${item.revision}`
                  : item.kind === 'skill'
                    ? (item.version || '—')
                    : `列 ${item.columns} · 行 ${item.row_count === null ? '不可读' : item.row_count}`;
                const updated = fmtTime(item.updated_at || item.published_at);
                const active = detail && detail.id === item.id && detail.kind === item.kind;
                return h('li', { key: `${item.kind}-${item.id}`, onClick: () => onOpen(item.kind, item.id), style: { ...styles.item, background: active ? C.tintStrong : 'transparent', padding: '8px 10px', cursor: 'pointer' } }, [
                  h('div', { key: 'r', style: { display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 } }, [
                    h('span', {
                      key: 't',
                      title: name,
                      style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 },
                    }, name),
                    h('span', { key: 'v', style: { flex: 'none', width: 96, textAlign: 'right', color: C.muted, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, version),
                    h('span', { key: 'u', style: { flex: 'none', width: 118, textAlign: 'right', color: C.muted, fontSize: 11.5, whiteSpace: 'nowrap' } }, updated),
                  ]),
                ]);
              })),
              ]),
              detailCard,
            ])
          : null,
      ]);
    }

    function initialRoute() {
      try { const q=new URLSearchParams(window.location.search);return {module:NAV.some(([key])=>key===q.get('hamsView'))?q.get('hamsView'):'overview',item:q.get('hamsItem'),member:q.get('hamsMember'),project:q.get('hamsProject')}; } catch { return {module:'overview'}; }
    }
    function HamsPanel() {
      const [module,setModuleState]=React.useState(()=>initialRoute().module);
      const [overview,setOverview]=React.useState(null);const [items,setItems]=React.useState([]);const [selected,setSelected]=React.useState(null);
      const [error,setError]=React.useState(null);const [busy,setBusy]=React.useState(false);const [loading,setLoading]=React.useState(true);const [lastRefresh,setLastRefresh]=React.useState(null);
      const [createOpen,setCreateOpen]=React.useState(false);const [evidenceForm,setEvidenceForm]=React.useState(null);const [actionForm,setActionForm]=React.useState(null);
      const [whoami,setWhoami]=React.useState(null);const [templates,setTemplates]=React.useState([]);const [checks,setChecks]=React.useState([]);
      const [projects,setProjects]=React.useState([]);const [projectSel,setProjectSel]=React.useState(null);const [projectForm,setProjectForm]=React.useState(false);const [projectDraft,setProjectDraft]=React.useState(null);const [taskProject,setTaskProject]=React.useState('');
      const [members,setMembers]=React.useState([]);const [memberSel,setMemberSel]=React.useState(null);const [memberTab,setMemberTab]=React.useState(null);const [positions,setPositions]=React.useState([]);const [memberForm,setMemberForm]=React.useState(false);const [memberFilter,setMemberFilter]=React.useState('all');
      const [knowledge,setKnowledge]=React.useState(null);const [knowledgeSel,setKnowledgeSel]=React.useState(null);const [knowledgeForm,setKnowledgeForm]=React.useState(null);const [knowledgeReport,setKnowledgeReport]=React.useState(null);const [importReport,setImportReport]=React.useState(null);const [editingDoc,setEditingDoc]=React.useState(false);
      const [approval,setApproval]=React.useState(null);const [approvalItem,setApprovalItem]=React.useState(null);
      const [health,setHealth]=React.useState(null);const [search,setSearch]=React.useState('');
      const live=React.useRef({item:null,project:null,member:null,knowledge:null,approval:null,view:'overview'});
      const readSeq=React.useRef({item:0,project:0,member:0,knowledge:0,approval:0,refresh:0});const mounted=React.useRef(true);const locked=React.useRef(false);
      const caps=(whoami && whoami.capabilities) || [];const me=whoami && whoami.principal && whoami.principal.memberId;
      const readOnly=!!(health && health.readOnly);
      const can=cap=>caps.includes(cap);
      const setModule=key=>{live.current.view=key;setModuleState(key);try{const url=new URL(window.location.href);url.searchParams.set('hamsView',key);if(key!=='tasks')url.searchParams.delete('hamsItem');if(key!=='projects')url.searchParams.delete('hamsProject');if(key!=='agents')url.searchParams.delete('hamsMember');window.history.replaceState(null,'',url);}catch{}};
      const setDeepLink=(key,id)=>{try{const url=new URL(window.location.href);url.searchParams.set(key,id);window.history.replaceState(null,'',url);}catch{}};
      const refresh=async()=>{
        const epoch=++readSeq.current.refresh;
        const commands=['session/whoami','overview/get','workItem/list','template/list','project/list','member/list','position/list','knowledge/list','ops/health'];
        const results=await Promise.allSettled(commands.map(command=>call(command,{payload:command==='workItem/list'?{limit:200}:{}})));
        if(!mounted.current || epoch!==readSeq.current.refresh)return;
        const setters=[setWhoami,setOverview,setItems,setTemplates,setProjects,setMembers,setPositions,setKnowledge,setHealth];
        let failed=null;results.forEach((result,index)=>{if(result.status==='fulfilled')setters[index](result.value);else if(index===7)setKnowledge({items:[],counts:{docs:0,skills:0,tables:0},sources:{},error:result.reason});else failed=failed || result.reason;});
        if(failed)setError(failed);else{setLastRefresh(Date.now());setError(current=>current && ['VERSION_CONFLICT','EVIDENCE_CHANGED','EPOCH_STALE'].includes(current.code)?current:null);}
        const active=live.current;
        if(active.item && active.view==='tasks')loadDetail('item','workItem/get',active.item,setSelected);
        if(active.project && active.view==='projects')loadDetail('project','project/get',active.project,setProjectSel);
        if(active.member && active.view==='agents')loadDetail('member','member/get',active.member,setMemberSel);
        if(active.approval && active.approval.subject_kind==='work_item_close')loadDetail('approval','workItem/get',active.approval.subject_id,setApprovalItem);
        setLoading(false);
      };
      const loadDetail=async(kind,command,id,setter,payload)=>{
        if(['item','project','member'].includes(kind) && live.current[kind]!==id)return null;
        const epoch=++readSeq.current[kind];
        try{const value=await call(command,{objectId:id,payload});if(mounted.current && epoch===readSeq.current[kind]){
          if(['item','project','member'].includes(kind) && live.current[kind]!==id)return null;
          if(kind==='approval'){
            if(!live.current.approval || live.current.approval.subject_id!==id)return null;
            const fresh=(value.approvals || []).find(ap=>ap.id===live.current.approval.id);
            if(fresh){live.current.approval=fresh;setApproval(fresh);}
          }
          setter(value);
        }return value;}
        catch(err){if(mounted.current && epoch===readSeq.current[kind])setError(err);return null;}
      };
      const openTask=id=>{live.current.item=id;setModule('tasks');setDeepLink('hamsItem',id);setSelected(null);return loadDetail('item','workItem/get',id,setSelected);};
      const openProject=id=>{live.current.project=id;setModule('projects');setDeepLink('hamsProject',id);setProjectDraft(null);setProjectSel(null);return loadDetail('project','project/get',id,setProjectSel);};
      const openMember=(id,tab)=>{live.current.member=id;setMemberTab(tab||null);setModule('agents');setDeepLink('hamsMember',id);setMemberSel(null);return loadDetail('member','member/get',id,setMemberSel);};
      const openKnowledge=(kind,id)=>{setEditingDoc(false);setKnowledgeSel(null);return loadDetail('knowledge','knowledge/get',null,setKnowledgeSel,{kind,id});};
      React.useEffect(()=>{
        mounted.current=true;refresh();const route=initialRoute();if(route.module==='tasks' && route.item)openTask(route.item);else if(route.module==='projects' && route.project)openProject(route.project);else if(route.module==='agents' && route.member)openMember(route.member,'config');
        const timer=setInterval(()=>{if(!locked.current)refresh();},15000);
        return ()=>{mounted.current=false;clearInterval(timer);};
      },[]);
      React.useEffect(()=>{let alive=true;if(module==='tasks')Promise.all(items.map(item=>call('check/list',{payload:{workItemId:item.id}}))).then(rows=>{if(alive)setChecks(rows.flat());}).catch(err=>{if(alive)setError(err);});return()=>{alive=false;};},[module,items]);
      const run=async(fn,propagate=false)=>{
        if(locked.current)return;locked.current=true;setBusy(true);setError(null);
        try{const value=await fn();await refresh();return value===undefined?true:value;}catch(err){setError(err);if(propagate)throw err;return false;}finally{locked.current=false;setBusy(false);}
      };
      const onAct=(action,item,extra)=>{
        if(action==='decideApproval'){setModule('overview');return;}
        const spec=ACTIONS[action];if(!spec)return;
        if(spec.form && !extra){setEvidenceForm({workItemId:item.id,source:'panel'});return;}
        if(spec.reason && !extra){setActionForm({action,workItemId:item.id});return;}
        return run(async()=>{await call(spec.command,{objectId:item.id,expectedRevision:item.revision,payload:extra || {}});setActionForm(null);setEvidenceForm(null);clearDraft(`action:${item.id}:`);clearDraft(`evidence:${item.id}:`);await loadDetail('item','workItem/get',item.id,setSelected);});
      };
      const onCreate=input=>run(async()=>{const receipt=await call('workItem/create',{payload:input});setCreateOpen(false);clearDraft('task-create:');if(receipt.objectId)await openTask(receipt.objectId);});
      const onCheck=id=>run(async()=>{await call('check/evaluate',{objectId:id});if(selected)await loadDetail('item','workItem/get',selected.id,setSelected);});
      const onOpenApproval=async ap=>{live.current.approval=ap;setApproval(ap);setApprovalItem(null);if(ap.subject_kind!=='work_item_close')return;await loadDetail('approval','workItem/get',ap.subject_id,setApprovalItem);};
      const onApprove=(ap,decision,note)=>run(async()=>{await call('approval/decide',{objectId:ap.id,payload:{decision,note:note || ''}});live.current.approval=null;setApproval(null);clearDraft(`approval:${ap.id}`);if(selected)await loadDetail('item','workItem/get',selected.id,setSelected);});
      const onProposal=(proposal,decision,note,templateVersionId)=>run(async()=>{
        const body=safeJSON(proposal.body);const projectId=String(proposal.subject_key || '').startsWith('project:')?proposal.subject_key.slice(8):undefined;
        await call('proposal/decide',{objectId:proposal.id,payload:{decision,note,workItem:decision==='accept' && proposal.kind==='create_task'?{domain:body.domain || '研究',category:body.category || '研究推进',title:proposal.title,ownerHumanId:me,projectId,templateVersionId}:undefined}});
      });
      const projectCommand=(command,payload)=>{
        if(command==='project/tryMetric')return call(command,{objectId:payload.projectId,payload});
        // 目标验证的审批：objectId 必须是审批 id（不能拿项目 id 顶替），处理完刷新项目详情。
        if(command==='approval/decide')return run(async()=>{
          await call('approval/decide',{objectId:payload.approvalId,payload:{decision:payload.decision,note:payload.note || ''}});
          if(projectSel)await loadDetail('project','project/get',projectSel.id,setProjectSel);
        },true);
        return run(async()=>{
          if(command==='project/create'){
            const receipt=await call(command,{payload});setProjectForm(false);clearDraft('pm/project-create/');if(receipt.objectId)await openProject(receipt.objectId);return receipt;
          }
          if(command==='project/delete'){
            const projectId=payload.projectId || (projectSel && projectSel.id);
            const receipt=await call(command,{objectId:projectId,payload:{...payload,projectId}});
            setProjectForm(false);setProjectDraft(null);setProjectSel(null);live.current.project=null;
            try{const url=new URL(window.location.href);url.searchParams.delete('hamsProject');window.history.replaceState(null,'',url);}catch{}
            return receipt;
          }
          if(!projectSel)return;
          const receipt=await call(command,{objectId:projectSel.id,expectedRevision:projectSel.revision,payload});await loadDetail('project','project/get',projectSel.id,setProjectSel);return receipt;
        },true);
      };
      const onCreateProject=input=>run(async()=>{const receipt=await call('project/create',{payload:input});setProjectForm(false);if(receipt.objectId)await openProject(receipt.objectId);});
      // 向导草稿：保存不关闭表单；发布时才切到项目详情。
      const onSaveProjectDraft=async payload=>{const receipt=await call('project/saveDraft',{payload});await refresh();return receipt;};
      const onPublishProjectDraft=async payload=>{
        if(payload.projectId){
          await call('project/saveDraft',{payload});
          await call('project/publishTarget',{objectId:payload.projectId,payload:{projectId:payload.projectId,goalText:payload.goalText,metrics:payload.metrics}});
          clearDraft('pm/project-create/');setProjectForm(false);setProjectDraft(null);await openProject(payload.projectId);
          return;
        }
        const receipt=await call('project/create',{payload:{...payload,publish:true}});
        clearDraft('pm/project-create/');setProjectForm(false);setProjectDraft(null);
        if(receipt.objectId)await openProject(receipt.objectId);
      };
      const onContinueProjectDraft=detail=>{
        clearDraft('pm/project-create/');
        const draft=(detail && detail.draft) || {};
        setProjectDraft({
          projectId:detail.id, name:detail.name, type:detail.type, goalText:detail.goal_text || '',
          coordinatorId:detail.coordinator_id || '', step:Number(draft.step) || 0,
          metrics:Array.isArray(draft.metrics) ? draft.metrics : [], savedAt:draft.savedAt || null,
        });
        setProjectForm(true);
      };
      const onProjectStatus=action=>{const status={publish:'active',pause:'paused',resume:'active',archive:'archived'}[action];if(status)return projectCommand('project/status',{status});};
      const onRecordMetric=(metricId,value)=>projectCommand('project/recordMetric',{projectId:projectSel.id,metricId,value,sourceRef:'panel:手动录入'});
      const memberCommand=(command,payload)=>run(async()=>{
        if(command==='member/create'){
          const receipt=await call(command,{payload});setMemberForm(false);clearDraft('pm/member-create/');if(receipt.objectId)await openMember(receipt.objectId);return receipt;
        }
        if(!memberSel)return;
        const receipt=await call(command,{objectId:memberSel.id,expectedRevision:memberSel.current_version,payload});await loadDetail('member','member/get',memberSel.id,setMemberSel);return receipt;
      },true);
      const onCreateMember=input=>run(async()=>{const receipt=await call('member/create',{payload:input});setMemberForm(false);clearDraft('pm/member-create/');if(receipt.objectId)await openMember(receipt.objectId);});
      const onMemberStatus=action=>{const status={pause:'paused',resume:'active',retire:'retired'}[action];if(status)return memberCommand('member/status',{status});};
      const onSyncKnowledge=()=>run(async()=>{const receipt=await call('knowledge/sync',{payload:{}});setKnowledgeReport((receipt.detail || {}).report || null);if(knowledgeSel)await openKnowledge(knowledgeSel.kind,knowledgeSel.id);});
      const onCreateDoc=input=>run(async()=>{const receipt=await call('knowledge/createDoc',{payload:input});setKnowledgeForm(null);if(receipt.objectId)await openKnowledge('doc',receipt.objectId);});
      const onImportDocs=input=>run(async()=>{const receipt=await call('knowledge/importDocs',{payload:input});setKnowledgeForm(null);setImportReport((receipt.detail || {}).report || null);});
      const onPublishDoc=id=>run(async()=>{await call('knowledge/publishDoc',{objectId:id,payload:{docId:id},expectedRevision:knowledgeSel && knowledgeSel.revision});await openKnowledge('doc',id);});
      const onEditDoc=input=>run(async()=>{await call('knowledge/updateDoc',{objectId:input.docId,payload:input,expectedRevision:knowledgeSel && knowledgeSel.revision});setEditingDoc(false);await openKnowledge('doc',input.docId);});
      const count=overview?overview.approvals.length+overview.proposals.length+(overview.reviews || []).length:0;
      const bots=members.filter(member=>member.kind==='bot');const filteredProjects=search?projects.filter(p=>`${p.name} ${p.goal_text}`.toLowerCase().includes(search.toLowerCase())):projects;
      return h('div',{className:'hams-root',style:{display:'flex',height:'100%',overflow:'hidden'}},[
        h('style',{key:'css'},`.hams-root{color:inherit}.hams-root button:disabled{opacity:.45;cursor:not-allowed}.hams-root button:focus-visible,.hams-root input:focus-visible,.hams-root select:focus-visible,.hams-root textarea:focus-visible{outline:2px solid #2F5BD8;outline-offset:2px}.hams-board{display:grid;grid-template-columns:repeat(5,minmax(185px,1fr));gap:12px;overflow-x:auto}.hams-calendar{display:grid;grid-template-columns:repeat(7,minmax(80px,1fr));overflow:auto}.hams-overview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}.hams-drawer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.2);display:flex;justify-content:flex-end;z-index:1000}.hams-drawer{background:var(--background,#fff);color:var(--foreground,#16181D);padding:24px;width:min(900px,90vw);overflow:auto;display:flex;flex-direction:column;gap:18px;box-shadow:-8px 0 30px #0002}.hams-approval-columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(prefers-color-scheme:dark){.hams-drawer{background:var(--background,#202124);color:var(--foreground,#e8eaed)}}@media(max-width:1000px){.hams-overview-grid{grid-template-columns:1fr}.hams-approval-columns{grid-template-columns:1fr}}@media(max-width:650px){.hams-root>nav{width:100px!important;flex-basis:100px!important}.hams-root>section{padding:14px!important}}`),
        h('nav',{key:'nav',style:styles.rail,'aria-label':'HAMS 导航'},[
          h('div',{key:'brand',style:styles.railBrand},'HAMS'),
          ...NAV.map(([key,label])=>h('button',{key,style:styles.railItem(module===key),onClick:()=>{setSearch('');setModule(key);},'aria-current':module===key?'page':undefined},[label,key==='overview' && count?badge(count,C.bad):null])),
          h('div',{key:'spacer',style:{flex:1}}),
        ]),
        h('section',{key:'main',style:styles.content},[
          h('header',{key:'header',style:styles.pageHeader},[
            h('h1',{key:'title',style:styles.title},(NAV.find(([key])=>key===module)||[])[1] || '工作台'),
            h('span',{key:'status',style:styles.muted},loading?'正在加载…':`${count} 项等你决定 · 更新于 ${lastRefresh?new Date(lastRefresh).toLocaleTimeString():'—'}`),
            rowButton(busy?'处理中…':'刷新',()=>run(refresh),{key:'refresh',disabled:busy}),
            module==='projects'?h('input',{key:'search',type:'search',style:{...styles.input,marginLeft:'auto'},value:search,onChange:e=>setSearch(e.target.value),placeholder:'搜索项目','aria-label':'搜索项目'}):null,
          ]),
          h('div',{key:'body',style:styles.contentBody},[
          h(ErrorBox,{key:'error',error,onDismiss:()=>setError(null)}),
          health && health.readOnly?h('div',{key:'readonly',style:styles.notice},'当前实例为只读，恢复单写者连接后可继续操作。'):null,
          !loading && projects.length===0 && items.length===0 && module==='overview'?h('section',{key:'onboarding',style:styles.card},[
            h('strong',{key:'h'},'开始你的第一个工作闭环'),h('p',{key:'text'},'先建项目和目标，再创建任务、收集证据，最后复查与验收。业务数据保存在本机 HAMS 数据目录中。'),
            rowButton('1 · 新建项目',()=>{setModule('projects');setProjectForm(true);},{key:'project',disabled:!can('project.create')}),rowButton('2 · 添加人机成员',()=>{setModule('agents');setMemberForm(true);},{key:'member',disabled:!can('member.manage')}),rowButton('3 · 整理知识',()=>setModule('knowledge'),{key:'knowledge'}),
          ]):null,
          module==='overview'?h(OverviewTab,{key:'overview',overview,projects,templates,me,busy:busy || readOnly,onOpenApproval,onOpenTask:openTask,onProposal,onReview:review=>openProject(review.projectId || review.project_id)}):null,
          module==='tasks'?h(ItemsTab,{key:'tasks',items,selected,onSelect:openTask,onAct,busy,onCreate,createOpen,onCreateOpen:()=>setCreateOpen(!createOpen),onCreateCancel:()=>setCreateOpen(false),canAct:!readOnly,canCreate:!readOnly && can('work_item.create'),evidenceForm,actionForm,templates,projects,members,checks,me,projectFilter:taskProject,onProjectFilter:setTaskProject,onClose:()=>{readSeq.current.item++;live.current.item=null;setSelected(null);try{const url=new URL(window.location.href);url.searchParams.delete('hamsItem');window.history.replaceState(null,'',url);}catch{}},onCheck}):null,
          module==='projects'?h(ProjectScreen,{key:'projects',projects:filteredProjects,detail:readOnly && projectSel?{...projectSel,allowedActions:[]}:projectSel,busy:busy || readOnly,formOpen:projectForm,draft:projectDraft,bots,members,humans:members.filter(m=>m.kind==='human'),me,allowedActions:!readOnly && can('project.create')?['create']:[],onCreate:onCreateProject,onOpen:openProject,onFormOpen:()=>{clearDraft('pm/project-create/');setProjectDraft(null);setProjectForm(!projectForm);},onStatus:onProjectStatus,onRecord:onRecordMetric,onCommand:projectCommand,onSaveDraft:onSaveProjectDraft,onPublish:onPublishProjectDraft,onContinueDraft:onContinueProjectDraft,onDelete:()=>{setProjectSel(null);},onRefreshDetail:()=>{if(live.current.project)loadDetail('project','project/get',live.current.project,setProjectSel);},onGotoTasks:id=>{setTaskProject(id || (projectSel && projectSel.id) || '');setModule('tasks');setCreateOpen(true);},onOpenTask:openTask,onOpenWorkItem:openTask,onOpenMember:openMember,onClose:()=>{setProjectDraft(null);setProjectForm(false);setProjectSel(null);live.current.project=null;try{const url=new URL(window.location.href);url.searchParams.delete('hamsProject');window.history.replaceState(null,'',url);}catch{}}}):null,
          module==='agents'?h(MemberScreen,{key:'members',members,detail:readOnly && memberSel?{...memberSel,allowedActions:[]}:memberSel,positions,onOpenWorkItem:openTask,busy:busy || readOnly,allowedActions:!readOnly && can('member.manage')?['create']:[],formOpen:memberForm,filter:memberFilter,onFilter:setMemberFilter,onCreate:onCreateMember,onOpen:openMember,onFormOpen:()=>setMemberForm(!memberForm),onStatus:onMemberStatus,onCommand:memberCommand,initialTab:memberTab,onClose:()=>{setMemberSel(null);setMemberTab(null);live.current.member=null;try{const url=new URL(window.location.href);url.searchParams.delete('hamsMember');window.history.replaceState(null,'',url);}catch{}}}):null,
          module==='knowledge'?h(KnowledgeScreen,{key:'knowledge',data:knowledge,detail:knowledgeSel,busy,form:knowledgeForm,report:knowledgeReport,importReport,onForm:next=>{setKnowledgeForm(next);setEditingDoc(next==='edit');},onOpen:openKnowledge,onSync:onSyncKnowledge,onCreateDoc,onImport:onImportDocs,onPublish:onPublishDoc,onEdit:onEditDoc,editing:editingDoc,onCancelEdit:()=>setEditingDoc(false),capabilities:readOnly?[]:caps}):null,
          ]),
        ]),
        approval?h(ApprovalDrawer,{key:approval.id,approval,item:approvalItem,busy,onClose:()=>{live.current.approval=null;readSeq.current.approval++;setApproval(null);},canApprove:!readOnly && can('approval.decide'),onApprove,onOpenTask:id=>{live.current.approval=null;setApproval(null);openTask(id);},me}):null,
      ]);
    }


    // ── 应用页（设计 §18.12 / 画板 ⑳ 的插件侧落地） ─────────────────────────
    //
    // 宿主只提供 sidebar.panellist 插槽，没有「应用」页；这里自己注册一个主面板，
    // 读宿主侧栏条目（ctx.slots.entries）并按分组展示，点一下就切过去。
    // 不硬编码条目清单：装了什么插件就显示什么，id 只用于分组与说明文案。
    const APPS_ID = 'apps';
    const CONVERSATIONS_ID = 'conversations';

    const APP_GROUPS = [
      ['pinned', '常驻左侧'],
      ['create', '生成'],
      ['tool', '工具'],
      ['other', '其他入口'],
    ];

    /** 已知条目的分组与一句话说明；未知条目落进「其他入口」，不猜。 */
    const APP_META = {
      hams: { group: 'pinned', desc: '项目、任务、人机成员、知识；关单与发布要人批准', tag: '本项目插件' },
      schedules: { group: 'pinned', desc: '定时唤醒会话；与 HAMS 的复查计划相互独立', tag: '内置' },
      'baoyu-design.artifacts': { group: 'create', desc: '设计画布、幻灯片、仪表盘、白板、动效的作品页', tag: '第三方' },
      plugins: { group: 'other', desc: '安装、启用、停用，查看版本与兼容性', tag: '内置' },
      'agents-anywhere-next': { group: 'tool', desc: '通过 Agents Anywhere 从手机或其他设备连接', tag: '第三方' },
      'dsh-market': { group: 'other', desc: '浏览与安装社区插件', tag: '第三方' },
    };

    function appMetaOf(id, label) {
      if (APP_META[id]) return APP_META[id];
      const text = `${label} ${id}`;
      if (/远程|remote|bridge|live/i.test(text)) return { group: 'tool', desc: '从另一台设备操作当前工作区', tag: '第三方' };
      if (/作品|设计|design|artifact|slide|dashboard|whiteboard|motion/i.test(text)) {
        return { group: 'create', desc: '创作产物的入口', tag: '第三方' };
      }
      return { group: 'other', desc: '', tag: '第三方' };
    }

    /** 读一个插槽注册表里的条目（id / 文案 / 顺序）；读不到就返回空数组。 */
    function slotEntries(hole) {
      const ctx = window.__hams && window.__hams.ctx;
      if (!ctx || !ctx.slots || typeof ctx.slots.entries !== 'function') return [];
      return (ctx.slots.entries(hole) || []).map((entry) => {
        const options = (entry && entry.options) || {};
        let label = '';
        try {
          label = typeof options.label === 'function' ? options.label() : (options.label || '');
        } catch (err) {
          label = options.id || '';
        }
        return { id: String(options.id || ''), label: String(label || options.id || ''), order: Number(options.order) || 0 };
      }).filter((entry) => entry.id);
    }

    /**
     * 「应用」里要列的东西 = 左侧栏的面板行 + 底部动作行。
     * 远程控制这类入口注册的是 `sidebar.footer.action`（不在面板行里），
     * 只读面板行会漏掉它——用户已经点名要它出现在应用里。
     */
    function hostEntries() {
      const panels = slotEntries('sidebar.panellist')
        .filter((entry) => entry.id !== APPS_ID && entry.id !== CONVERSATIONS_ID)
        .map((entry) => ({ ...entry, kind: 'panel' }));
      const footers = slotEntries('sidebar.footer.action')
        .map((entry) => ({ ...entry, kind: 'footer' }));
      return [...panels, ...footers].sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label));
    }

    /**
     * 底部动作没有「选中面板」这回事：它就是个按钮。找不到就明说去底部栏点，
     * 不做静默失败。
     */
    function clickFooterAction(label) {
      const buttons = [...document.querySelectorAll('button[aria-label]')];
      const byLabel = buttons.reverse().find((node) => node.getAttribute('aria-label') === label);
      if (byLabel) {
        byLabel.click();
        return true;
      }
      const area = document.querySelector('[class*="footerActions"]');
      if (area) {
        const candidates = [...area.querySelectorAll('button')];
        const byText = candidates.find((node) => (node.textContent || '').trim() === label);
        if (byText) {
          byText.click();
          return true;
        }
        if (candidates.length === 1) {
          candidates[0].click();
          return true;
        }
      }
      return false;
    }

    function hostActivePanel() {
      const ctx = window.__hams && window.__hams.ctx;
      try {
        return ctx.layout.panelInfo.getSnapshot().activePanelId;
      } catch (err) {
        return null;
      }
    }

    function openHostPanel(id) {
      const ctx = window.__hams && window.__hams.ctx;
      if (!ctx || !ctx.layout) throw { code: 'HOST_CAPABILITY_MISSING', message: '宿主没有 layout 服务，无法切换面板', nextStep: '升级宿主后重试' };
      ctx.layout.selectPanel(id);
    }

    /**
     * 宿主侧栏只在自身状态变化时重渲染：用一个不可见的 actions 占位注册当触发器
     * （More 菜单已被宿主补丁关掉，所以不会多出一行）。
     */
    let sidebarRefreshOff = null;
    function refreshHostSidebar() {
      const ctx = window.__hams && window.__hams.ctx;
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return;
      try {
        if (typeof sidebarRefreshOff === 'function') { sidebarRefreshOff(); sidebarRefreshOff = null; }
        sidebarRefreshOff = ctx.slots.register({
          name: 'sidebar.panellist.actions',
          id: 'hams-refresh',
          order: 999,
          label: () => 'HAMS',
        }, () => null);
      } catch (err) { /* 宿主不认这个插槽时忽略：固定状态仍会写进白名单，下次重渲染生效 */ }
    }

    function AppsPanel() {
      const [entries, setEntries] = React.useState(() => hostEntries());
      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(() => hostActivePanel());
      const [pins, setPins] = React.useState(() => readPinnedApps());
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        const ctx = window.__hams && window.__hams.ctx;
        const sync = () => {
          setEntries(hostEntries());
          setActive(hostActivePanel());
        };
        sync();
        const offs = [];
        try { offs.push(ctx.slots.subscribe('sidebar.panellist', sync)); } catch (err) { /* 订阅失败不影响一次性读取 */ }
        try { offs.push(ctx.layout.panelInfo.subscribe(sync)); } catch (err) { /* 同上 */ }
        const timer = window.setInterval(sync, 3000);
        return () => {
          window.clearInterval(timer);
          offs.forEach((off) => { try { if (typeof off === 'function') off(); } catch (err) { /* 忽略 */ } });
        };
      }, []);

      const open = (entry) => {
        const id = typeof entry === 'string' ? entry : entry.id;
        const kind = typeof entry === 'string' ? 'panel' : entry.kind;
        try {
          setError(null);
          if (kind === 'footer') {
            if (!clickFooterAction(typeof entry === 'string' ? id : entry.label)) {
              throw { code: 'HOST_CAPABILITY_MISSING', message: '这个入口是左栏底部的按钮，页面里找不到它', nextStep: '点左侧栏底部对应图标打开（它可能被收在底部区域）' };
            }
            return;
          }
          if (id === CONVERSATIONS_ID) openHostPanel(null);
          else openHostPanel(id);
          setActive(hostActivePanel());
        } catch (err) {
          setError(err && err.code ? err : { code: 'HOST_CAPABILITY_MISSING', message: String(err && err.message ? err.message : err), nextStep: '这个入口没有注册主面板，先看宿主日志' });
        }
      };

      const isPinned = (entry) => SHELL_ROWS.includes(entry.id) || pins.includes(entry.id);
      const togglePin = (entry) => {
        const current = readPinnedApps();
        const next = current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id];
        writePinnedApps(next);
        syncSidebarRows();
        setPins(next);
        refreshHostSidebar();
      };
      const filtered = entries.filter((entry) => !query.trim() || entry.label.toLowerCase().includes(query.trim().toLowerCase()));
      const groups = APP_GROUPS.map(([key, title]) => [key, title, filtered.filter((entry) => appMetaOf(entry.id, entry.label).group === key)])
        .filter(([, , rows]) => rows.length > 0);
      const thirdParty = entries.filter((entry) => appMetaOf(entry.id, entry.label).tag === '第三方').length;

      return h('div', { style: { ...styles.content, height: '100%', boxSizing: 'border-box' } }, [
        h('div', { key: 'h', style: styles.pageHeader }, [
          h('h1', { key: 't', style: styles.title }, '应用'),
          h('span', { key: 's', style: styles.muted }, `${entries.length} 个入口 · ${thirdParty} 个来自第三方插件`),
        ]),
        h('div', { key: 'body', style: styles.contentBody }, [
        h('div', { key: 'bar', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('input', {
            key: 'q',
            value: query,
            placeholder: '搜索应用',
            style: { ...styles.input, minWidth: 180, flex: '1 1 180px' },
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { key: 'm', style: styles.button(false), onClick: () => open('plugins') }, '管理插件'),
          h('button', { key: 'c', style: styles.button(false), onClick: () => open(CONVERSATIONS_ID) }, '回到对话'),
        ]),
        h(ErrorBox, { key: 'e', error, onDismiss: () => setError(null) }),
        groups.length === 0
          ? h('div', { key: 'empty', style: styles.empty }, query.trim() ? `没有匹配「${query.trim()}」的应用` : '宿主还没有注册任何侧栏入口')
          : groups.map(([key, title, rows]) => h('div', { key, style: styles.card }, [
              h('div', { key: 'h', style: styles.row }, [
                h('strong', { key: 't' }, title),
                h('span', { key: 'c', style: styles.muted }, `${rows.length} 个`),
              ]),
              h('ul', { key: 'l', style: styles.list }, rows.map((entry) => {
                const meta = appMetaOf(entry.id, entry.label);
                const isActive = active === entry.id;
                const pinned = isPinned(entry);
                const shellRow = SHELL_ROWS.includes(entry.id);
                const pinnable = !shellRow && entry.kind !== 'footer';
                return h('li', { key: entry.id, style: styles.item }, [
                  h('div', { key: 'm', style: styles.row }, [
                    h('span', { key: 'n', style: { fontWeight: isActive ? 600 : 400 } }, entry.label),
                    h('span', { key: 'b', style: styles.muted }, [
                      entry.kind === 'footer' ? badge('底部栏', C.warn) : null,
                      badge(meta.tag, meta.tag === '第三方' ? C.muted : C.accent),
                      pinned ? badge(shellRow ? '常驻左侧' : '已固定', C.ok) : null,
                      isActive ? badge('当前', C.ok) : null,
                    ]),
                  ]),
                  meta.desc ? h('div', { key: 'd', style: styles.muted }, meta.desc) : null,
                  h('div', { key: 'a', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
                    h('button', { key: 'o', style: styles.button(true), disabled: isActive, onClick: () => open(entry) }, isActive ? '已打开' : (entry.kind === 'footer' ? '底部栏打开' : '打开')),
                    pinnable
                      ? h('button', {
                          key: 'p',
                          style: styles.button(false),
                          title: pinned ? '从左侧栏移除这一行（刷新后仍有效）' : '把这一行加到左侧栏',
                          onClick: () => togglePin(entry),
                        }, pinned ? '取消固定' : '固定到左侧栏')
                      : null,
                  ]),
                ]);
              })),
            ])),
        h('div', { key: 'n', style: styles.muted }, '「固定」把入口加到左侧栏，「取消固定」把它移走；刷新后仍保留。插件没加载时宿主不做过滤，左侧栏恢复宿主原样。'),
        ]),
      ]);
    }

    /** 左侧栏的 2x2 点阵（应用）与对话气泡，用宿主自带的图标 sprite。 */
    function AppsIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true', style: { display: 'block' } },
        [[3, 3], [10, 3], [3, 10], [10, 10]].map(([x, y], i) =>
          h('rect', { key: i, x, y, width: 5, height: 5, rx: 1.5, fill: 'currentColor', opacity: 0.85 })));
    }

    function ConversationsIcon() {
      // 自己画气泡：宿主 sprite 里只有「新建对话」（带 +）的图标，拿来当「对话」会误导。
      return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M2.4 5.2a1.8 1.8 0 011.8-1.8h9.6a1.8 1.8 0 011.8 1.8v6.2a1.8 1.8 0 01-1.8 1.8H8.6l-3.4 2.8v-2.8H4.2a1.8 1.8 0 01-1.8-1.8z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }));
    }

    /**
     * 「对话」行：宿主把会话视图当成 activePanelId === null。
     * 点击这一行 = 把主面板切回 null，等于回到对话；不需要另造一个对话页。
     */
    function ConversationsRedirect() {
      React.useEffect(() => {
        try { openHostPanel(null); } catch (err) { /* 切换失败就停在原面板 */ }
      }, []);
      return h('div', { style: styles.empty }, '正在回到对话…');
    }

    /**
     * 进入全局面板（工作台 / 应用 / 插件…）时把左侧的会话浏览区收起来，
     * 回到对话（activePanelId === null）时再放出来。设计 §18.12 要的
     * 「左侧只留常驻行」就是这样落地的：不改宿主结构，只加一条样式。
     */
    function installShellCompact(ctx) {
      const marker = 'hams-shell-compact';
      if (!document.getElementById(marker)) {
        const style = document.createElement('style');
        style.id = marker;
        style.textContent = [
          'html[data-hams-panel="global"] [class*="regionArea"] { display: none !important; }',
          // 新会话行搬到会话浏览区上方：宿主那一行留着（点击仍走它的处理器），只是藏起来。
          'html[data-hams-newsession="1"] [class*="newSessionRow"] { display: none !important; }',
          '.hams-newsession { display: none; padding: 0 0 8px; }',
          'html[data-hams-newsession="1"] .hams-newsession { display: block; }',
          '.hams-newsession > button { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 34px; border: none; border-radius: 8px; background: rgba(47,91,216,.07); font: inherit; font-size: 13px; font-weight: 500; color: #16181D; cursor: pointer; }',
          '.hams-newsession > button:hover { background: rgba(127,127,127,.08); }',
        ].join('\n');
        document.head.appendChild(style);
      }

      const NEW_SESSION_ID = 'hams-newsession';
      /** 把「新会话」按钮放进 regionArea 顶部（工作区/会话记录上方），离开对话视图时收起。 */
      const syncNewSession = () => {
        const root = document.documentElement;
        const hostRow = document.querySelector('[class*="newSessionRow"]');
        const wide = !!(hostRow && hostRow.querySelector('[class*="newSessionLabel"]'));
        const region = document.querySelector('[class*="regionArea"]');
        const existing = document.getElementById(NEW_SESSION_ID);
        if (!hostRow || !wide || !region) {
          root.removeAttribute('data-hams-newsession');
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }
        root.setAttribute('data-hams-newsession', '1');
        let host = existing;
        if (!host) {
          host = document.createElement('div');
          host.id = NEW_SESSION_ID;
          host.className = 'hams-newsession';
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('aria-label', '新建会话');
          button.textContent = '＋ 新会话';
          // 不自己造会话：转发给宿主那一行的真实按钮，快捷键/工作区逻辑都还在它身上。
          button.addEventListener('click', () => {
            const target = document.querySelector('[class*="newSessionRow"] button');
            if (target) target.click();
          });
          host.appendChild(button);
        }
        if (region.firstChild !== host) region.insertBefore(host, region.firstChild);
      };

      const apply = () => {
        let active = null;
        try { active = ctx.layout.panelInfo.getSnapshot().activePanelId; } catch (err) { active = null; }
        document.documentElement.dataset.hamsPanel = active === null ? 'conversation' : 'global';
        syncNewSession();
      };
      apply();
      try { ctx.layout.panelInfo.subscribe(apply); } catch (err) { /* 旧宿主不支持订阅 */ }
      // 宿主重渲染会换掉 regionArea 的子节点，定期把按钮放回去（幂等，不新增 DOM）。
      try { window.setInterval(syncNewSession, 1500); } catch (err) { /* 忽略 */ }
    }

    function HamsIcon() {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, borderRadius: 5, border: 'none', background: C.tintStrong, fontSize: 10, fontWeight: 700,
        },
      }, 'H');
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          label: () => 'HAMS',
        }, HamsIcon));
      } catch (err) {
        console.error('[hams] 左侧入口注册失败：', err && err.message ? err.message : err);
      }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({}),
        }, HamsPanel));
      } catch (err) {
        console.error('[hams] 主面板注册失败：', err && err.message ? err.message : err);
      }
      // 「对话」行：点一下就回到会话视图（宿主用 activePanelId === null 表示对话）。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: CONVERSATIONS_ID,
          order: 5,
          label: () => '对话',
        }, ConversationsIcon));
      } catch (err) {
        console.error('[hams] 对话入口注册失败：', err && err.message ? err.message : err);
      }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: CONVERSATIONS_ID,
          inject: () => ({}),
        }, ConversationsRedirect));
      } catch (err) {
        console.error('[hams] 对话占位面板注册失败：', err && err.message ? err.message : err);
      }
      // 「应用」行与页面：列宿主注册过的全部侧栏入口，点一下就切过去。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: APPS_ID,
          order: 90,
          label: () => '应用',
        }, AppsIcon));
      } catch (err) {
        console.error('[hams] 应用入口注册失败：', err && err.message ? err.message : err);
      }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: APPS_ID,
          inject: () => ({}),
        }, AppsPanel));
      } catch (err) {
        console.error('[hams] 应用页注册失败：', err && err.message ? err.message : err);
      }
      try {
        // 调试入口：面板、注册组件、以及宿主 ctx（排查插槽/布局 API 时才用）。
        window.__hams = { panel: PANEL_ID, at: new Date().toISOString(), components: { HamsPanel, HamsIcon, AppsPanel, AppsIcon, ProjectScreen, MemberScreen, KnowledgeScreen, ItemsTab, TaskDetail, TaskCalendar, OverviewTab, ApprovalDrawer }, helpers: { boardColumn, taskFilter, metricVerdict, approvalValidity, renderMarkdown, mdInline, readPinnedApps, writePinnedApps, syncSidebarRows }, ctx };
      } catch { /* 忽略 */ }
      try {
        installShellCompact(ctx);
      } catch (err) {
        console.error('[hams] 收起会话浏览区失败：', err && err.message ? err.message : err);
      }
      try {
        // 白名单已写好，触发一次宿主侧栏重渲染，让固定的行立刻对齐。
        refreshHostSidebar();
      } catch (err) {
        console.error('[hams] 侧栏白名单同步失败：', err && err.message ? err.message : err);
      }
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
