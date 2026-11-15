import type { DatabaseSync } from 'node:sqlite'
import type { IdFactory } from '../domain/ids.ts'
import { stateInvalid, denied } from '../domain/errors.ts'
import { insertMetric, type MetricInput, type ProjectRow } from './projects.ts'

type Row = Record<string, any>
export function projectRow(db: DatabaseSync, id: string): ProjectRow {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as ProjectRow | undefined
  if (!row || row.deleted_at) throw stateInvalid('项目不存在')
  return row
}
function human(db: DatabaseSync, id: string): string {
  const row = db.prepare('SELECT kind, status FROM member WHERE id = ?').get(id) as Row | undefined
  if (!row || row.kind !== 'human' || row.status !== 'active') throw stateInvalid('确认人与验收人必须是在用的人类成员')
  return id
}
function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw stateInvalid(`${label}不能为空且最多${max}字`)
  return value.trim()
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw stateInvalid('时间必须是整数毫秒')
  return value
}
export interface PublishTargetInput { projectId: string; goalText: string; metrics?: MetricInput[] }
export function publishTarget(db: DatabaseSync, ids: IdFactory, now: number, actor: string, input: PublishTargetInput) {
  const p = projectRow(db, input.projectId)
  if (p.status === 'archived') throw stateInvalid('归档项目不能发布目标')
  const goal = text(input.goalText, '目标')
  if (!Array.isArray(input.metrics ?? []) || (input.metrics?.length ?? 0) > 12) throw stateInvalid('指标必须是最多12项的数组')
  const id = ids(), version = p.current_target_version + 1
  db.prepare('INSERT INTO project_target_version (id,project_id,version,goal_text,published_by,published_at) VALUES (?,?,?,?,?,?)').run(id,p.id,version,goal,actor,now)
  // Omitting metrics copies definitions into NEW metric IDs; historical observations stay bound to their version.
  const metrics = input.metrics ?? (db.prepare('SELECT * FROM project_metric WHERE project_id=? AND version_id=(SELECT id FROM project_target_version WHERE project_id=? AND version=?)').all(p.id,p.id,p.current_target_version) as Row[]).map(m => ({ name:m.name,direction:m.direction,targetValue:m.target_value,targetMax:m.target_max,unit:m.unit,windowKind:m.window_kind,definitionText:m.definition_text,sourceKind:m.source_kind,sourceRef:m.source_ref,calculatorKey:m.calculator_key,calculatorParams:JSON.parse(m.calculator_params_json) }))
  for (const metric of metrics) insertMetric(db,ids,p.id,id,metric)
  db.prepare("UPDATE project SET goal_text=?,current_target_version=?,status=CASE WHEN status='draft' THEN 'active' ELSE status END WHERE id=?").run(goal,version,p.id)
  return { targetVersionId:id, version }
}
/** 项目至少有一个阶段与一个目标：新建项目/启动时补齐「默认阶段」。 */
export function ensureDefaultPlan(db:DatabaseSync, ids:IdFactory, now:number, projectId:string) {
  const project=projectRow(db,projectId)
  const phases=db.prepare('SELECT id FROM project_phase WHERE project_id=? ORDER BY seq').all(projectId) as Row[]
  if(phases.length) return { phaseId:String(phases[0].id), created:false }
  const phaseId=ids()
  db.prepare("INSERT INTO project_phase (id,project_id,seq,name,starts_at,ends_at,status) VALUES (?,?,1,?,?,?, 'active')").run(phaseId,projectId,'默认阶段',now,253402300799000)
  db.prepare('INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id,detail) VALUES (?,?,NULL,?,NULL,?,?)').run(ids(),phaseId,'首个目标',project.owner_human_id,'写清这个目标怎么算、怎么验收；之后可以改成真正的阶段目标。')
  return { phaseId, created:true }
}

export function ensureAllDefaultPlans(db:DatabaseSync, ids:IdFactory, now:number) {
  const projects=db.prepare("SELECT id FROM project WHERE status IN ('active','paused')").all() as Row[]
  let created=0
  for(const project of projects) if(ensureDefaultPlan(db,ids,now,String(project.id)).created) created+=1
  return { created }
}

/** 给阶段加一个目标：描述（简略说明）、详情（计算方式与验收要求）、目标值、验收人。 */
export function addPhaseTarget(db:DatabaseSync, ids:IdFactory, input:{projectId:string;phaseId:string;description:string;detail?:string;targetValue?:number|null;metricId?:string;verifierHumanId?:string}) {
  const project=projectRow(db,input.projectId)
  const phase=db.prepare('SELECT * FROM project_phase WHERE id=? AND project_id=?').get(input.phaseId,input.projectId) as Row|undefined
  if(!phase) throw stateInvalid('阶段不属于该项目')
  if(['confirmed','done'].includes(String(phase.status))) throw stateInvalid('已确认的阶段不能再加目标')
  const count=Number((db.prepare('SELECT COUNT(*) AS n FROM project_phase_target WHERE phase_id=?').get(input.phaseId) as Row).n)
  if(count>=30) throw stateInvalid('一个阶段最多 30 个目标')
  if(input.metricId){ if(!db.prepare('SELECT id FROM project_metric WHERE id=? AND project_id=?').get(input.metricId,input.projectId)) throw stateInvalid('目标指标必须属于本项目') }
  const targetValue=input.targetValue ?? null
  if(targetValue!==null && (typeof targetValue!=='number'||!Number.isFinite(targetValue))) throw stateInvalid('目标值必须为有限数字')
  const verifier=human(db,input.verifierHumanId??project.owner_human_id)
  const id=ids()
  db.prepare('INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id,detail) VALUES (?,?,?,?,?,?,?)').run(id,input.phaseId,input.metricId??null,text(input.description,'目标描述'),targetValue,verifier,(input.detail??'').slice(0,2000))
  return { targetId:id }
}

export interface CreatePhaseInput {
  projectId:string; name:string; startsAt:number; endsAt:number; confirmerId?:string
  targets: {description:string; metricId?:string; targetValue?:number; verifierHumanId:string}[]
  checks?:string[]
}
export function createPhase(db:DatabaseSync, ids:IdFactory, actor:string, input:CreatePhaseInput) {
  const p=projectRow(db,input.projectId)
  const start=time(input.startsAt), end=time(input.endsAt)
  if (end < start) throw stateInvalid('阶段结束不能早于开始')
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length>30) throw stateInvalid('阶段需要1至30项验收目标')
  if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length>50)) throw stateInvalid('检查项最多50项')
  const id=ids(), seq=Number((db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM project_phase WHERE project_id=?').get(p.id) as Row).n)
  db.prepare('INSERT INTO project_phase (id,project_id,seq,name,starts_at,ends_at,confirmer_id) VALUES (?,?,?,?,?,?,?)').run(id,p.id,seq,text(input.name,'阶段名称',100),start,end,human(db,input.confirmerId??p.owner_human_id))
  for(const t of input.targets) {
    if(t.metricId && !db.prepare('SELECT id FROM project_metric WHERE id=? AND project_id=?').get(t.metricId,p.id)) throw stateInvalid('阶段指标必须属于本项目')
    if(t.targetValue !== undefined && (typeof t.targetValue !== 'number'||!Number.isFinite(t.targetValue))) throw stateInvalid('目标值必须为有限数字')
    db.prepare('INSERT INTO project_phase_target (id,phase_id,metric_id,description,target_value,verifier_human_id) VALUES (?,?,?,?,?,?)').run(ids(),id,t.metricId??null,text(t.description,'目标描述'),t.targetValue??null,human(db,t.verifierHumanId))
  }
  for(const label of input.checks??[]) db.prepare('INSERT INTO project_phase_check (id,phase_id,label) VALUES (?,?,?)').run(ids(),id,text(label,'检查项',200))
  return { phaseId:id }
}
export interface UpdatePhaseInput {projectId:string;phaseId:string;status?:string;checkId?:string;checked?:boolean}
function phase(db:DatabaseSync,input:{projectId:string;phaseId:string}):Row {
  const row=db.prepare('SELECT * FROM project_phase WHERE id=? AND project_id=?').get(input.phaseId,input.projectId) as Row|undefined
  if(!row) throw stateInvalid('阶段不属于该项目')
  if(row.status==='done') throw stateInvalid('已确认阶段不可修改')
  return row
}
export function updatePhase(db:DatabaseSync,now:number,actor:string,input:UpdatePhaseInput) {
  const row=phase(db,input)
  if(input.status!==undefined) {
    const allowed:Record<string,string[]>={planned:['active'],active:['awaiting_confirm'],awaiting_confirm:['active']}
    if(!allowed[row.status]?.includes(input.status)) throw stateInvalid('非法阶段状态转换；日期不自动完成阶段')
    db.prepare('UPDATE project_phase SET status=? WHERE id=?').run(input.status,row.id)
  }
  if(input.checkId!==undefined) {
    if(typeof input.checked!=='boolean') throw stateInvalid('勾选状态必须为布尔值')
    const result=db.prepare('UPDATE project_phase_check SET checked=?,checked_by=?,checked_at=? WHERE id=? AND phase_id=?').run(input.checked?1:0,actor,now,input.checkId,row.id)
    if(!result.changes) throw stateInvalid('检查项不属于本阶段')
  }
  if(input.status===undefined && input.checkId===undefined) throw stateInvalid('没有阶段修改内容')
  return {phaseId:row.id}
}
export function confirmPhase(db:DatabaseSync,now:number,actor:string,input:{projectId:string;phaseId:string}) {
  const row=phase(db,input)
  if(row.status!=='awaiting_confirm') throw stateInvalid('阶段需先提交人工确认')
  if(row.confirmer_id!==actor) throw denied('只有指定确认人能确认阶段')
  db.prepare("UPDATE project_phase SET status='done',confirmed_by=?,confirmed_at=? WHERE id=?").run(actor,now,row.id)
  return {phaseId:row.id}
}
export interface TrialResult { value:number|null; verdict:'met'|'missed'|'unknown'; complete:boolean; reason?:string; windowStart:number;windowEnd:number;evidenceRef:string|null }
export function tryMetric(db:DatabaseSync,now:number,projectId:string|undefined,metric:MetricInput,period?:{start:number;end:number},metricId?:string):TrialResult {
  const end=period?.end??now, start=period?.start??(end-({day:1,week:7,month:30,snapshot:0}[metric.windowKind]??0)*86400000)
  let value:number|null=null,evidenceRef:string|null=null,reason:string|undefined
  if(!projectId) reason='先创建项目后试算'
  else if(!metric.calculatorKey || !metric.sourceKind) reason='缺少计算口径或数据来源'
  else if(metric.calculatorKey==='manual_latest' && metric.sourceKind==='manual') {
    if(!metric.sourceRef) reason='人工读数需要明确数据来源引用'
    else if(metricId) {
      const row=db.prepare('SELECT value,source_ref FROM metric_observation WHERE metric_id=? AND observed_at<=? AND window_end<=? AND window_end>=? AND source_ref=? ORDER BY window_end DESC,observed_at DESC,rowid DESC LIMIT 1').get(metricId,end,end,start,metric.sourceRef) as Row|undefined
      value=row?.value??null; evidenceRef=row?.source_ref??null
    } else reason='尚无已发布指标读数'
  } else if(['work_item_count','work_item_completion_rate'].includes(metric.calculatorKey) && metric.sourceKind==='work_item') {
    const params=metric.calculatorParams??{}, clauses=['project_id=?','created_at<=?'],args:any[]=[projectId,end]
    if(metric.windowKind!=='snapshot') {clauses.push('created_at>=?');args.push(start)}
    for(const key of ['domain','status']) if(params[key]) {clauses.push(`${key}=?`);args.push(params[key])}
    // Historical snapshots use completion time, not today's terminal status.
    const rows=db.prepare(`SELECT completed_at FROM work_item WHERE ${clauses.join(' AND ')}`).all(...args) as Row[]
    value=metric.calculatorKey==='work_item_count'?rows.length:rows.length?100*rows.filter(r=>r.completed_at!==null&&r.completed_at<=end).length/rows.length:null
    evidenceRef=`hams:project:${projectId}:work_items:${start}:${end}`
  } else reason='未知或不匹配的计算方式与数据来源'
  if(value===null) reason??='当期缺少可用数据'
  let verdict:TrialResult['verdict']='unknown'
  if(value!==null && metric.targetValue!==null && metric.targetValue!==undefined) {
    const met=metric.direction==='higher'?value>=metric.targetValue:metric.direction==='lower'?value<=metric.targetValue:metric.targetMax!==null&&metric.targetMax!==undefined&&value>=metric.targetValue&&value<=metric.targetMax
    verdict=met?'met':'missed'
  }
  return {value,verdict,complete:value!==null&&!reason,reason,windowStart:start,windowEnd:end,evidenceRef}
}
export interface CreateReviewInput {projectId:string;kind:string;periodStart:number;periodEnd:number;conclusionText?:string;confirmerId?:string}
export function createReview(db:DatabaseSync,ids:IdFactory,now:number,actor:string,input:CreateReviewInput) {
  const p=projectRow(db,input.projectId),start=time(input.periodStart),end=time(input.periodEnd)
  if(!['weekly','monthly','quarterly','phase'].includes(input.kind)||start>end||end>now) throw stateInvalid('复盘类型或周期不合法（不能冻结未来）')
  const target=db.prepare('SELECT id FROM project_target_version WHERE project_id=? AND published_at<=? ORDER BY version DESC LIMIT 1').get(p.id,end) as Row|undefined
  if(!target) throw stateInvalid('需要先发布项目目标')
  const id=ids()
  db.prepare("INSERT INTO project_review (id,project_id,kind,period_start,period_end,target_version_id,status,conclusion_text,confirmer_id) VALUES (?,?,?,?,?,?,'awaiting_confirm',?,?)").run(id,p.id,input.kind,start,end,target.id,input.conclusionText?text(input.conclusionText,'结论'):null,human(db,input.confirmerId??p.owner_human_id))
  const metrics=db.prepare('SELECT * FROM project_metric WHERE version_id=?').all(target.id) as Row[]
  for(const m of metrics) {
    const trial=tryMetric(db,now,p.id,{name:m.name,direction:m.direction,targetValue:m.target_value,targetMax:m.target_max,windowKind:m.window_kind,sourceKind:m.source_kind,sourceRef:m.source_ref,calculatorKey:m.calculator_key,calculatorParams:JSON.parse(m.calculator_params_json)},{start,end},m.id)
    db.prepare('INSERT INTO project_review_metric (review_id,metric_id,target_value,actual_value,verdict,evidence_ref) VALUES (?,?,?,?,?,?)').run(id,m.id,m.target_value,trial.value,trial.verdict,trial.evidenceRef)
  }
  return {reviewId:id,targetVersionId:target.id}
}
export function confirmReview(db:DatabaseSync,now:number,actor:string,input:{projectId:string;reviewId:string}) {
  const row=db.prepare('SELECT * FROM project_review WHERE id=? AND project_id=?').get(input.reviewId,input.projectId) as Row|undefined
  if(!row||row.status!=='awaiting_confirm') throw stateInvalid('复盘不存在或已确认')
  if(row.confirmer_id!==actor) throw denied('只有指定确认人能确认复盘')
  db.prepare("UPDATE project_review SET status='confirmed',confirmed_by=?,confirmed_at=? WHERE id=?").run(actor,now,row.id)
  return {reviewId:row.id}
}
export interface UpdateTargetInput { projectId:string; targetId:string; description?:string; detail?:string; targetValue?:number|null; verifierHumanId?:string }
/** 编辑阶段目标：描述 / 目标值 / 验收人；已确认的阶段不允许再改。 */
export function updatePhaseTarget(db:DatabaseSync, input:UpdateTargetInput) {
  const target=db.prepare('SELECT t.*, p.status AS phase_status FROM project_phase_target t JOIN project_phase p ON p.id=t.phase_id WHERE t.id=? AND p.project_id=?').get(input.targetId,input.projectId) as Row|undefined
  if(!target) throw stateInvalid('目标不属于该项目')
  if(['confirmed','done'].includes(String(target.phase_status))) throw stateInvalid('已确认的阶段不能再改目标')
  const description=input.description===undefined?target.description:text(input.description,'目标描述')
  let targetValue=target.target_value
  if(input.targetValue!==undefined) {
    if(input.targetValue===null) targetValue=null
    else if(typeof input.targetValue!=='number'||!Number.isFinite(input.targetValue)) throw stateInvalid('目标值必须为有限数字')
    else targetValue=input.targetValue
  }
  const verifier=input.verifierHumanId===undefined?target.verifier_human_id:human(db,input.verifierHumanId)
  const detail=input.detail===undefined?target.detail:(input.detail||'').slice(0,2000)
  db.prepare('UPDATE project_phase_target SET description=?,detail=?,target_value=?,verifier_human_id=? WHERE id=?').run(description,detail,targetValue,verifier,target.id)
  return { targetId:target.id }
}

export interface SubmitTargetCheckInput { projectId:string; targetId:string; approverId:string; summary:string; reportUrl?:string; note?:string }
/**
 * 项目经理提交一次目标检验 = 申请一次审批：写检验记录（pending）+ 指定审批人。
 * 审批通过后目标才算达成；驳回会留下原因。可反复提交，历史都保留。
 */
export function submitTargetCheck(db:DatabaseSync, ids:IdFactory, now:number, actor:string, input:SubmitTargetCheckInput) {
  const target=db.prepare('SELECT t.id,p.status AS phase_status FROM project_phase_target t JOIN project_phase p ON p.id=t.phase_id WHERE t.id=? AND p.project_id=?').get(input.targetId,input.projectId) as Row|undefined
  if(!target) throw stateInvalid('目标不属于该项目')
  const url=(input.reportUrl??'').trim()
  if(url && !/^https?:\/\//i.test(url)) throw stateInvalid('报告链接必须是 http(s) 地址')
  if(url.length>500) throw stateInvalid('报告链接最多 500 字')
  const note=(input.note??'').trim()
  if(note.length>1000) throw stateInvalid('说明最多 1000 字')
  const summary=text(input.summary,'验证摘要',1000)
  const approver=human(db,input.approverId)
  if(approver===actor) throw stateInvalid('提交人不能自己审批，请指定另一位审批人')
  const checkId=ids()
  db.prepare("INSERT INTO project_phase_target_check (id,project_id,target_id,submitted_by,submitted_at,result,report_url,note,approver_id,summary,status) VALUES (?,?,?,?,?, 'unknown',?,?,?,?, 'pending')").run(checkId,input.projectId,input.targetId,actor,now,url||null,note,approver,summary)
  const approvalId=ids()
  db.prepare(`INSERT INTO approval (id, subject_kind, subject_id, subject_revision, execution_epoch, evidence_set_hash, criteria_ref, criteria_json, reason_text, requested_by, requested_channel, approver_id, status, decision_note, expires_at, created_at)
              VALUES (?, 'target_change', ?, 0, 0, '', '', '{}', ?, ?, 'ui', ?, 'pending', '', ?, ?)`)
    .run(approvalId, checkId, summary, actor, approver, now+72*3_600_000, now)
  return { checkId, approvalId }
}

export function projectLifecycleDetail(db:DatabaseSync,projectId:string) {
  const phases=(db.prepare('SELECT * FROM project_phase WHERE project_id=? ORDER BY seq').all(projectId) as Row[]).map(p=>({...p,
    targets:(db.prepare('SELECT * FROM project_phase_target WHERE phase_id=? ORDER BY rowid').all(p.id) as Row[]).map(t=>{
      const checks=db.prepare("SELECT c.*,m.name AS submitted_by_name,a.name AS approver_name,d.name AS decided_by_name,ap.id AS approval_id,ap.expires_at AS approval_expires_at FROM project_phase_target_check c LEFT JOIN member m ON m.id=c.submitted_by LEFT JOIN member a ON a.id=c.approver_id LEFT JOIN member d ON d.id=c.decided_by LEFT JOIN approval ap ON ap.subject_kind='target_change' AND ap.subject_id=c.id WHERE c.target_id=? ORDER BY c.submitted_at DESC, c.rowid DESC LIMIT 20").all(t.id)
      return {...t,checks,achieved:checks.some(c=>c.status==='approved'),pending:checks.some(c=>c.status==='pending'),rejected:checks.length>0&&!checks.some(c=>c.status==='approved')&&!checks.some(c=>c.status==='pending')}
    }),
    checks:db.prepare('SELECT * FROM project_phase_check WHERE phase_id=? ORDER BY rowid').all(p.id)}))
  const reviews=(db.prepare('SELECT * FROM project_review WHERE project_id=? ORDER BY period_end DESC').all(projectId) as Row[]).map(r=>({...r,metrics:db.prepare('SELECT rm.*,m.name,m.direction,m.target_max,m.unit,m.window_kind,m.calculator_key,m.calculator_params_json,m.definition_text FROM project_review_metric rm JOIN project_metric m ON m.id=rm.metric_id WHERE review_id=?').all(r.id)}))
  const proposals=db.prepare('SELECT * FROM proposal WHERE project_id=? ORDER BY created_at DESC').all(projectId)
  const decisions=db.prepare('SELECT d.* FROM decision d JOIN proposal p ON p.id=d.proposal_id WHERE p.project_id=? ORDER BY d.created_at DESC').all(projectId)
  const projectEvents=db.prepare("SELECT * FROM audit_log WHERE subject_kind='project' AND subject_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200").all(projectId) as Row[]
  const workEvents=db.prepare('SELECT e.*,w.title FROM work_item_event e JOIN work_item w ON w.id=e.work_item_id WHERE w.project_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 200').all(projectId) as Row[]
  const events=[...projectEvents.map(e=>({...e,source_kind:'audit_log'})),...workEvents.map(e=>({...e,source_kind:'work_item_event',action:e.kind,subject_kind:'work_item',subject_id:e.work_item_id,after_json:e.payload_json}))].sort((a,b)=>b.created_at-a.created_at).slice(0,200)
  return {phases,reviews,progress_records:{proposals,decisions,events}}
}
