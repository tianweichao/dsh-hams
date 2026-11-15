import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, IDS, AT, DAY, ingestAndClaim, driveToReview } from './fixtures.ts'
import { ensureDefaultPlan } from '../../src/service/project-lifecycle.ts'
import { createHamsHttpHandler } from '../../src/http/handler.ts'
import { runTick } from '../../src/service/tick.ts'
import { migrate, MIGRATIONS } from '../../src/store/migrations.ts'
import { DatabaseSync } from 'node:sqlite'
import { PROJECTS_SCHEMA_SQL } from '../../src/store/schema/003_projects.sql.ts'
import { readFileSync } from 'node:fs'
import { parseSchema } from '../../scripts/split-schema.mjs'
import { createIdFactory } from '../../src/domain/ids.ts'

const metric = {name:'闭环数',direction:'higher',targetValue:1,windowKind:'week',sourceKind:'work_item',calculatorKey:'work_item_count'}
const rejects=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.code===code)
function grantReview(h:ReturnType<typeof createHarness>) {h.db.prepare("INSERT INTO position_permission VALUES ('pos_owner','review.confirm','global')").run()}

test('目标新版本冻结旧指标与观测；幂等重试先于expectedRevision，冲突不产生副作用',t=>{
 const h=createHarness(t),ctx={...h.ctx(IDS.owner,'ui','publish-once'),expectedRevision:1}
 const original=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 const input={projectId:IDS.project,goalText:'新口径',metrics:[metric]}
 const result=h.service.publishProjectTarget(ctx,input)
 assert.equal(result.objectRevision,2)
 assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).current_target_version,2)
 assert.deepEqual(h.service.publishProjectTarget(ctx,input),JSON.parse(JSON.stringify(result)))
 const detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 assert.equal(detail.target_versions.length,2)
 assert.equal(detail.target_versions.find(v=>v.version===1)?.metrics.length,2)
 assert.equal((h.db.prepare("SELECT value FROM metric_observation WHERE metric_id='pm-closure'").get() as any).value,87)
 assert.equal(detail.target_versions.find(v=>v.version===1)?.goal_text,original.goal_text)
 assert.equal((h.db.prepare("SELECT COUNT(*) n FROM metric_observation WHERE metric_id IN ('pm-closure','pm-overdischarge')").get() as any).n,2)
 rejects(()=>h.service.publishProjectTarget({...h.ctx(IDS.owner),expectedRevision:1},{...input,goalText:'过期修改'}),'VERSION_CONFLICT')
 rejects(()=>h.service.publishProjectTarget(ctx,{...input,goalText:'相同key不同内容'}),'IDEMPOTENCY_MISMATCH')
 rejects(()=>h.service.publishProjectTarget(h.ctx(IDS.intern),input),'POLICY_DENIED')
 rejects(()=>h.service.publishProjectTarget(h.ctx(IDS.owner,'tool'),input),'POLICY_DENIED')
 rejects(()=>h.service.publishProjectTarget(h.ctx(IDS.owner),{...input,metrics:[{...metric,calculatorKey:'arbitrary_sql'}]}),'STATE_INVALID')
 assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).target_versions.length,2)
 h.close()
})

test('阶段日期与勾选不自动完成；仅指定人通过UI确认，确认后不可改',t=>{
 const h=createHarness(t)
 const created=h.service.createProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,name:'验收阶段',startsAt:AT-DAY,endsAt:AT,targets:[{description:'已核对证据',verifierHumanId:IDS.owner}],checks:['核对附件']})
 const phaseId=String(created.detail?.phaseId)
 h.advance(DAY)
 runTick({db:h.db,now:()=>h.clock.now,runtimeEpoch:1})
 let phase=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases[0]
 assert.equal(phase.status,'planned')
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'active'})
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,checkId:String(phase.checks[0].id),checked:true})
 rejects(()=>h.service.confirmProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId}),'STATE_INVALID')
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'awaiting_confirm'})
 // Another capable human must still not impersonate the designated confirmer.
 h.db.prepare("INSERT INTO member_position VALUES (?, 'pos_owner', ?, NULL, ?)").run(IDS.approver,AT-DAY,IDS.owner)
 rejects(()=>h.service.confirmProjectPhase(h.ctx(IDS.approver),{projectId:IDS.project,phaseId}),'POLICY_DENIED')
 h.service.confirmProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,note:'人工核验通过'})
 phase=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases[0]
 assert.equal(phase.status,'done');assert.equal(phase.confirmed_by,IDS.owner)
 rejects(()=>h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'active'}),'STATE_INVALID')
 h.close()
})

test('复盘冻结当期快照与目标口径；缺数未知且不因后续读数/目标版本而改变',t=>{
 const h=createHarness(t);grantReview(h)
 h.service.publishProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,goalText:'明确来源',metrics:[{name:'人工测量',direction:'higher',targetValue:10,windowKind:'week',sourceKind:'manual',sourceRef:'manual:meter',calculatorKey:'manual_latest'}, {name:'未知口径',direction:'lower',targetValue:0,windowKind:'day',sourceKind:'manual'}]})
 let detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 const id=detail.metrics.find(m=>m.name==='人工测量')!.id
 h.service.recordMetric(h.ctx(IDS.owner),{projectId:IDS.project,metricId:id,value:12,sourceRef:'manual:meter',windowStart:AT-DAY,windowEnd:AT})
 const created=h.service.createProjectReview(h.ctx(IDS.owner),{projectId:IDS.project,kind:'weekly',periodStart:AT-DAY,periodEnd:AT,conclusionText:'当期已冻结'})
 const reviewId=String(created.detail?.reviewId)
 detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 const before=detail.reviews[0]
 assert.equal(before.status,'awaiting_confirm')
 assert.equal(before.metrics.find((m:any)=>m.metric_id===id)?.actual_value,12)
 assert.equal(before.metrics.find((m:any)=>m.metric_id===id)?.verdict,'met')
 assert.equal(before.metrics.find((m:any)=>m.name==='未知口径')?.verdict,'unknown')
 assert.equal(h.service.overview(h.ctx(IDS.owner)).reviews.length,1)
 assert.equal(h.service.overview(h.ctx(IDS.approver)).reviews.length,0)
 assert.equal(h.service.listProjects(h.ctx(IDS.owner))[0].needs_my_action,true)
 h.advance(DAY)
 h.service.recordMetric(h.ctx(IDS.owner),{projectId:IDS.project,metricId:id,value:1,sourceRef:'manual:meter'})
 h.service.publishProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,goalText:'下周不同目标',metrics:[{...metric,targetValue:100}]})
 const frozen=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).reviews[0]
 assert.deepEqual(frozen,before)
 rejects(()=>h.service.confirmProjectReview(h.ctx(IDS.owner,'tool'),{projectId:IDS.project,reviewId}),'POLICY_DENIED')
 h.service.confirmProjectReview(h.ctx(IDS.owner),{projectId:IDS.project,reviewId,note:'确认快照'})
 assert.equal(h.service.overview(h.ctx(IDS.owner)).reviews.length,0)
 assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).reviews[0].confirmed_by,IDS.owner)
 rejects(()=>h.service.confirmProjectReview(h.ctx(IDS.owner),{projectId:IDS.project,reviewId}),'STATE_INVALID')
 h.close()
})

test('推进记录来自真实提议、决定、项目审计与关联任务事件',t=>{
 const h=createHarness(t)
 const p=h.service.propose(h.ctx(IDS.coord,'tool'),{kind:'scope_change',subjectKey:`project:${IDS.project}`,projectId:IDS.project,dedupeKey:'scope-once',deciderId:IDS.owner,title:'需要新证据',body:'先核对',rationale:{evidence:['log:1']}})
 h.service.decideProposal(h.ctx(IDS.owner),{proposalId:String(p.objectId),decision:'reject',note:'维持当前目标'})
 h.service.publishProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,goalText:'当前目标明确'})
 const d=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 assert.equal(d.progress_records.proposals.length,1)
 assert.equal(d.progress_records.decisions.length,1)
 assert.equal((d.progress_records.decisions[0] as any).note,'维持当前目标')
 assert.ok(d.progress_records.events.some((e:any)=>e.action==='project/publishTarget'))
 h.close()
})

test('配置小改冻结旧线程运行版本，大改在下次启动前换新会话并保留旧代次',t=>{
 const h=createHarness(t)
 // Publish initial config so bot can claim work
 h.service.publishMemberConfig({...h.ctx(IDS.owner),expectedRevision:0},{memberId:IDS.bot,changeClass:'major',agentPreset:'hams-bot',model:'deepseek-chat',memoryScope:{}})
 const {workItemId,runId}=ingestAndClaim(h)
 h.service.publishMemberConfig({...h.ctx(IDS.owner),expectedRevision:1},{memberId:IDS.bot,changeClass:'minor',responsibility:'小幅文案调整'})
 h.service.startRun(h.ctx(IDS.bot,'tool'),{runId})
 assert.equal((h.db.prepare('SELECT member_version FROM task_run WHERE id=?').get(runId) as any).member_version,1)
 h.service.submitResult(h.ctx(IDS.bot,'tool'),{runId,summary:'完成本次'})
 h.advance(DAY)
 runTick({db:h.db,now:()=>h.clock.now,runtimeEpoch:1})
 const queued=h.db.prepare("SELECT * FROM task_run WHERE work_item_id=? AND status='queued'").get(workItemId) as any
 assert.equal(queued.member_version,1)
 rejects(()=>h.service.publishMemberConfig(h.ctx(IDS.owner),{memberId:IDS.bot,changeClass:'minor',model:'new-model'}),'STATE_INVALID')
 h.service.publishMemberConfig({...h.ctx(IDS.owner),expectedRevision:2},{memberId:IDS.bot,changeClass:'major',model:'new-model',responsibility:'新的职责'})
 rejects(()=>h.service.startRun(h.ctx(IDS.bot,'tool'),{runId:queued.id}),'HOST_CAPABILITY_MISSING')
 h.service.startRun(h.ctx(IDS.bot,'tool'),{runId:queued.id,sessionId:'new-actual-host-session'})
 const threads=h.db.prepare('SELECT * FROM work_item_thread WHERE work_item_id=? ORDER BY generation').all(workItemId) as any[]
 assert.equal(threads.length,2);assert.equal(threads[0].status,'closed');assert.equal(threads[1].member_version,3)
 assert.equal((h.db.prepare('SELECT member_version FROM task_run WHERE id=?').get(queued.id) as any).member_version,3)
 const detail=h.service.getMemberDetail(h.ctx(IDS.owner),IDS.bot)
 assert.equal(detail.bot_versions.length,3)
 assert.deepEqual(detail.bot_versions.map(v=>v.change_class),['major','minor','major'])
 assert.deepEqual(detail.bot_versions.map(v=>v.responsibility),['新的职责','小幅文案调整',''])
 rejects(()=>h.service.publishMemberConfig({...h.ctx(IDS.owner),expectedRevision:1},{memberId:IDS.bot,changeClass:'minor'}),'VERSION_CONFLICT')
 h.close()
})

test('12周活动按真实运行与审计生成84个自然日，跨天和其他成员不会串入',t=>{
 const h=createHarness(t)
 const empty=h.service.getMemberDetail(h.ctx(IDS.owner),IDS.intern).activity
 assert.equal(empty.days.length,84);assert.equal(empty.total,0)
 const {runId}=ingestAndClaim(h)
 h.service.startRun(h.ctx(IDS.bot,'tool'),{runId})
 const first=h.service.getMemberDetail(h.ctx(IDS.owner),IDS.bot).activity
 assert.equal(first.days.at(-1)?.runs,1)
 assert.ok(first.total>=3)
 assert.equal(first.days.slice(0,-1).every(d=>d.count===0),true)
 h.advance(DAY)
 const next=h.service.getMemberDetail(h.ctx(IDS.owner),IDS.bot).activity
 assert.equal(next.days.at(-1)?.count,0);assert.equal(next.days.at(-2)?.count,first.days.at(-1)?.count)
 h.close()
})

test('工作项详情五页签返回真数据，暂停跨复查到期恢复会立即排队并避免tick重复',t=>{
 const h=createHarness(t),{workItemId,runId}=ingestAndClaim(h)
 h.service.startRun(h.ctx(IDS.bot,'tool'),{runId})
 h.service.submitResult(h.ctx(IDS.bot,'tool'),{runId,summary:'等待复查'})
 h.service.pause(h.ctx(IDS.owner),{workItemId,reason:'等人工'})
 h.advance(2*DAY)
 h.service.resume(h.ctx(IDS.owner),{workItemId})
 const detail=h.service.getWorkItem(h.ctx(IDS.owner),workItemId)
 assert.equal(detail.runs.length,2);assert.equal(detail.checks.length,2)
 assert.equal((detail.checks.at(-1) as any).status,'running')
 assert.equal((detail.checks.at(-1) as any).execution_epoch,detail.execution_epoch)
 assert.equal((detail.checks.at(-1) as any).planned_due_at,(detail.checks[0] as any).planned_due_at)
 assert.ok(detail.events.length>0);assert.ok(detail.current_thread);assert.equal(detail.templateVersion?.id,IDS.templateVersion)
 assert.ok(detail.criteriaSnapshot?.requiredEvidence.length)
 assert.equal(detail.canEvaluateCheck,true)
 assert.equal(h.service.getWorkItem(h.ctx(IDS.intern),workItemId).canEvaluateCheck,false)
 assert.equal(h.service.listWorkItems(h.ctx(IDS.owner),{projectId:IDS.project,domain:'安全'}).length,1)
 assert.equal(h.service.listWorkItems(h.ctx(IDS.owner),{projectId:'other',domain:'安全'}).length,0)
 assert.equal(runTick({db:h.db,now:()=>h.clock.now,runtimeEpoch:1}).steps.queuedCheckRuns,0)
 h.close()
})

test('审批过期后waiting_review暴露重新申请，而有效pending审批不重复显示',t=>{
 const h=createHarness(t),{workItemId}=driveToReview(h)
 assert.equal(h.service.getWorkItem(h.ctx(IDS.owner),workItemId).allowedActions.includes('requestClosure'),false)
 h.advance(2*DAY)
 assert.equal(h.service.getWorkItem(h.ctx(IDS.owner),workItemId).allowedActions.includes('requestClosure'),true)
 h.close()
})

test('HTTP新增命令、修订冲突、真实detail与只读模式沿用标准信封',t=>{
 const h=createHarness(t)
 const handler=createHamsHttpHandler({service:h.service,authenticate:()=>({ok:true,principalId:IDS.owner})})
 const call=(path:string,envelope:any)=>JSON.parse(handler({method:'POST',path:'/hams/api/v1/'+path,headers:{},body:JSON.stringify({commandId:'http-lifecycle',...envelope})}).body)
 const envelope={objectId:IDS.project,idempotencyKey:'http-target',expectedRevision:1,payload:{goalText:'HTTP口径',metrics:[metric]}}
 assert.equal(call('project/publishTarget',envelope).ok,true)
 assert.equal(call('project/publishTarget',envelope).objectRevision,2)
 assert.equal(call('project/publishTarget',{...envelope,idempotencyKey:'outdated'}).error.code,'VERSION_CONFLICT')
 assert.equal(call('project/get',{objectId:IDS.project}).data.phases.length,0)
 assert.equal(call('project/tryMetric',{payload:{metric}}).data.value,null)
 const readOnly=createHamsHttpHandler({service:h.service,readOnly:true,authenticate:()=>({ok:true,principalId:IDS.owner})})
 const response=readOnly({method:'POST',path:'/hams/api/v1/ops/health',headers:{},body:'{"commandId":"health-readonly"}'})
 assert.equal(JSON.parse(response.body).data.readOnly,true)
 h.close()
})

test('v2实际库升级v4：保留项目/指标/审计，v3 的项目 DDL 仍逐句来自权威 DDL',()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON')
 migrate(db,{migrations:MIGRATIONS.slice(0,2)})
 db.prepare("INSERT INTO member (id,kind,name,role,created_at,updated_at) VALUES ('human','human','迁移负责人','coordinator',1,1)").run()
 db.prepare("INSERT INTO project (id,name,type,owner_human_id,goal_text,created_at,updated_at) VALUES ('old','已有项目','continuous','human','保存历史',1,1)").run()
 const report=migrate(db)
 assert.deepEqual(report.applied.map(m=>m.version),[3,4,5,6,7,8])
 assert.equal((db.prepare("SELECT goal_text FROM project WHERE id='old'").get() as any).goal_text,'保存历史')
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_review'").all().length,1)
 const authority=parseSchema(readFileSync(new URL('../../docs/schema-2026-11-14.sql',import.meta.url),'utf8')).map(s=>s.text)
 for(const statement of parseSchema(PROJECTS_SCHEMA_SQL))assert.ok(authority.includes(statement.text))
 db.close()
})


test('非建单提议采纳只记录真实决定，不暗中建任务、扩大权限或改目标',t=>{
 const h=createHarness(t)
 const p=h.service.propose(h.ctx(IDS.coord,'tool'),{kind:'permission_request',subjectKey:`project:${IDS.project}`,projectId:IDS.project,dedupeKey:'need-permission',deciderId:IDS.owner,title:'申请更大范围',body:'需要讨论',rationale:{evidence:['log:proof']}})
 const before=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 h.service.decideProposal(h.ctx(IDS.owner),{proposalId:String(p.objectId),decision:'accept',note:'采纳建议；授权另行处理'})
 assert.equal(h.service.listWorkItems(h.ctx(IDS.owner)).length,0)
 assert.equal(h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).goal_text,before.goal_text)
 assert.equal((h.db.prepare('SELECT status,result_work_item_id FROM proposal WHERE id=?').get(String(p.objectId)) as any).status,'accepted')
 assert.equal((h.db.prepare('SELECT COUNT(*) n FROM member_permission WHERE member_id=?').get(IDS.coord) as any).n,1)
 const records=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).progress_records
 assert.equal(records.decisions.length,1)
 assert.equal((records.decisions[0] as any).decision,'accept')
 h.close()
})

test('补做历史周期复盘选择周期末已发布目标，不能用后来版本改写历史',t=>{
 const h=createHarness(t)
 h.advance(DAY)
 h.service.publishProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,goalText:'第二天的新目标',metrics:[metric]})
 h.service.createProjectReview(h.ctx(IDS.owner),{projectId:IDS.project,kind:'weekly',periodStart:AT-DAY,periodEnd:AT})
 const review=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).reviews[0]
 assert.equal(review.target_version_id,'pv1')
 assert.equal(review.metrics.length,2)
 assert.ok(review.metrics.every((m:any)=>m.verdict==='unknown'))
 h.close()
})


test('手动换新会话仅重绑queued运行并保留历史；running与复用session被拒绝',t=>{
 const h=createHarness(t),{workItemId,runId}=ingestAndClaim(h)
 const original=h.service.getWorkItem(h.ctx(IDS.owner),workItemId)
 const result=h.service.rotateThread({...h.ctx(IDS.owner),expectedRevision:original.revision},{workItemId,sessionId:'manual-session-2',reason:'手工换代'})
 assert.equal(result.detail?.generation,2);assert.equal(result.detail?.rewiredRuns,1)
 let detail=h.service.getWorkItem(h.ctx(IDS.owner),workItemId)
 assert.equal(detail.current_thread?.session_id,'manual-session-2')
 assert.equal((detail.runs[0] as any).thread_id,detail.current_thread?.id)
 assert.equal(detail.threads[0].status,'closed')
 assert.equal(detail.execution_epoch,original.execution_epoch)
 rejects(()=>h.service.rotateThread(h.ctx(IDS.owner),{workItemId,sessionId:'manual-session-2'}),'STATE_INVALID')
 h.service.startRun(h.ctx(IDS.bot,'tool'),{runId})
 rejects(()=>h.service.rotateThread(h.ctx(IDS.owner),{workItemId,sessionId:'running-session'}),'STATE_INVALID')
 assert.equal(h.service.getWorkItem(h.ctx(IDS.owner),workItemId).allowedActions.includes('rotateThread'),false)
 const project=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 assert.equal(project.workItems.length,1)
 assert.equal((project.workItems[0] as any).domain,'安全')
 assert.ok(project.progress_records.events.some((e:any)=>e.source_kind==='work_item_event'&&e.action==='thread_rotated'))
 h.close()
})

test('默认阶段与目标：项目一定有骨架，重复补齐是幂等的',t=>{
 const h=createHarness(t)
 const first=ensureDefaultPlan(h.db,createIdFactory(()=>AT),AT,IDS.project)
 assert.equal(first.created,true)
 const phase=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases[0]
 assert.equal(phase.name,'默认阶段')
 assert.equal(phase.targets.length,1)
 const second=ensureDefaultPlan(h.db,createIdFactory(()=>AT),AT,IDS.project)
 assert.equal(second.created,false,'已有阶段时不再补')
})

test('目标可以加、可以编辑；确认过的阶段锁死',t=>{
 const h=createHarness(t)
 const created=h.service.createProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,name:'验收阶段',startsAt:AT-DAY,endsAt:AT,targets:[{description:'旧描述',verifierHumanId:IDS.owner}],checks:[]})
 const phaseId=String(created.detail?.phaseId)
 const added=h.service.addProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,description:'新目标',detail:'按周统计，>=95% 达标',targetValue:95,verifierHumanId:IDS.owner})
 assert.ok(added.status==='applied')
 const phase=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases.find(p=>p.id===phaseId)
 assert.equal(phase.targets.length,2)
 assert.equal(phase.targets[1].detail,'按周统计，>=95% 达标')

 const target=phase.targets[0]
 h.service.updateProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,description:'新描述',detail:'新的验收要求'})
 const updated=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases.find(p=>p.id===phaseId).targets[0]
 assert.equal(updated.description,'新描述')
 assert.equal(updated.detail,'新的验收要求')
 assert.throws(()=>h.service.updateProjectTarget(h.ctx(IDS.intern),{projectId:IDS.project,targetId:target.id,description:'x'}),/project\.manage|能力|权限/)

 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'active'})
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'awaiting_confirm'})
 h.service.confirmProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId})
 assert.throws(()=>h.service.updateProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,description:'再改'}),/已确认/)
 assert.throws(()=>h.service.addProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,description:'加不了'}),/已确认/)
})

test('提交检验=申请审批：指定审批人通过后目标达成；驳回留下原因',t=>{
 const h=createHarness(t)
 const created=h.service.createProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,name:'验收阶段',startsAt:AT-DAY,endsAt:AT,targets:[{description:'过放次数归零',verifierHumanId:IDS.owner}],checks:[]})
 const phaseId=String(created.detail?.phaseId)
 const target=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases.find(p=>p.id===phaseId).targets[0]

 // 自己审批自己：拒绝
 assert.throws(()=>h.service.submitProjectTargetCheck(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,approverId:IDS.owner,summary:'自查达标'}),/不能自己审批/)
 // 审批人没有审批能力：拒绝
 assert.throws(()=>h.service.submitProjectTargetCheck(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,approverId:IDS.intern,summary:'x'}),/approval\.decide|能力|权限/)

 const submitted=h.service.submitProjectTargetCheck(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,approverId:IDS.approver,summary:'本周 0 次过放，报告见链接',reportUrl:'https://example.com/r1',note:'第二批数据'})
 assert.equal(submitted.status,'applied')
 const checkId=String((submitted.detail as {checkId:string}).checkId)
 const approvalId=String((submitted.detail as {approvalId:string}).approvalId)
 let detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 let row=detail.phases.find(p=>p.id===phaseId).targets[0]
 assert.equal(row.pending,true)
 assert.equal(row.achieved,false)
 assert.equal(row.checks[0].summary,'本周 0 次过放，报告见链接')
 assert.ok(row.checks[0].approver_name && row.checks[0].approver_name.length > 0, '带审批人名字')

 h.service.decideApproval(h.ctx(IDS.approver),{approvalId,decision:'approve',note:'看着不错'})
 detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 row=detail.phases.find(p=>p.id===phaseId).targets[0]
 assert.equal(row.achieved,true,'审批通过后目标达成')
 assert.equal(row.checks[0].status,'approved')

 // 再来一次并被驳回
 const second=h.service.submitProjectTargetCheck(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,approverId:IDS.otherApprover,summary:'再次提交'})
 h.service.decideApproval(h.ctx(IDS.otherApprover),{approvalId:String((second.detail as {approvalId:string}).approvalId),decision:'reject',note:'证据不够'})
 detail=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project)
 row=detail.phases.find(p=>p.id===phaseId).targets[0]
 const latest=row.checks[0]
 assert.equal(latest.status,'rejected')
 assert.equal(latest.decision_note,'证据不够')
 assert.equal(row.achieved,true,'历史已通过的记录仍然有效')
 void checkId
})

test('阶段目标可编辑：描述/目标值/验收人；已确认阶段锁死；只有项目经理能改',t=>{
 const h=createHarness(t)
 const created=h.service.createProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,name:'验收阶段',startsAt:AT-DAY,endsAt:AT,targets:[{description:'旧描述',verifierHumanId:IDS.owner}],checks:[]})
 const target=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases[0].targets[0]
 h.service.updateProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,description:'新描述',targetValue:95,verifierHumanId:IDS.owner})
 const updated=h.service.getProjectDetail(h.ctx(IDS.owner),IDS.project).phases[0].targets[0]
 assert.equal(updated.description,'新描述')
 assert.equal(updated.target_value,95)
 assert.throws(()=>h.service.updateProjectTarget(h.ctx(IDS.intern),{projectId:IDS.project,targetId:target.id,description:'x'}),/project\.manage|能力|权限/)
 // 确认阶段后锁死
 const phaseId=String(created.detail?.phaseId)
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'active'})
 h.service.updateProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId,status:'awaiting_confirm'})
 h.service.confirmProjectPhase(h.ctx(IDS.owner),{projectId:IDS.project,phaseId})
 assert.throws(()=>h.service.updateProjectTarget(h.ctx(IDS.owner),{projectId:IDS.project,targetId:target.id,description:'再改'}),/已确认/)
})
