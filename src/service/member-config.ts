import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { IdFactory } from '../domain/ids.ts'
import { stateInvalid } from '../domain/errors.ts'
export interface PublishConfigInput {memberId:string;changeClass:'minor'|'major';responsibility?:string;agentPreset?:string|null;model?:string|null;memoryScope?:Record<string,unknown>;prompt?:string|null}
export function publishConfig(db:DatabaseSync,ids:IdFactory,now:number,actor:string,input:PublishConfigInput) {
  const member=db.prepare('SELECT * FROM member WHERE id=?').get(input.memberId) as Record<string,any>|undefined
  if(!member||member.kind!=='bot'||member.status==='retired') throw stateInvalid('只能为未退休bot发布配置')
  if(!['minor','major'].includes(input.changeClass)) throw stateInvalid('变更级别必须为minor或major')
  const previous=db.prepare('SELECT * FROM member_version WHERE member_id=? AND version=?').get(member.id,member.current_version) as Record<string,any>|undefined
  const string=(value:unknown,max:number):string|null=>{if(value===null)return null;if(typeof value!=='string'||value.length>max)throw stateInvalid('配置文本类型或长度不合法');return value.trim()||null}
  const model=input.model===undefined?previous?.model??null:string(input.model,120)
  const agentPreset=input.agentPreset===undefined?previous?.agent_preset??null:string(input.agentPreset,80)
  const responsibility=input.responsibility===undefined?member.responsibility:string(input.responsibility,4000)??''
  if(input.memoryScope!==undefined&&(!input.memoryScope||typeof input.memoryScope!=='object'||Array.isArray(input.memoryScope)||JSON.stringify(input.memoryScope).length>8000))throw stateInvalid('记忆范围必须为JSON对象且不超过8000字')
  const memory=input.memoryScope===undefined?previous?.memory_scope_json??'{}':JSON.stringify(input.memoryScope)
  // 提示词是会话人设：跟着版本冻结，改它必须换新会话，否则新文本到不了已开会话。
  const rawPrompt=input.prompt===undefined?(previous?.prompt??''):String(input.prompt??'').trim()
  if(rawPrompt.length>8192) throw stateInvalid('提示词最多 8192 字')
  // Changing execution model/preset/scope/prompt changes the run boundary and requires explicit major publication.
  if(input.changeClass==='minor' && (model!==(previous?.model??null)||agentPreset!==(previous?.agent_preset??null)||memory!==(previous?.memory_scope_json??'{}')||rawPrompt!==(previous?.prompt??''))) throw stateInvalid('模型、preset、记忆范围或提示词变化需显式选择大改')
  const version=member.current_version+1,id=ids(),digest=createHash('sha256').update(JSON.stringify({responsibility,model,agentPreset,memory,prompt:rawPrompt})).digest('hex')
  db.prepare('INSERT INTO member_version (id,member_id,version,agent_preset,model,memory_scope_json,prompt,prompt_digest,change_class,published_by,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,member.id,version,agentPreset,model,memory,rawPrompt,digest,input.changeClass,actor,now)
  // Skills remain attached to each immutable version, even when only its prompt changes.
  if(previous) db.prepare('INSERT INTO member_version_skill (member_version_id,skill_id,skill_version_id) SELECT ?,skill_id,skill_version_id FROM member_version_skill WHERE member_version_id=?').run(id,previous.id)
  db.prepare('UPDATE member SET current_version=?,responsibility=?,updated_at=? WHERE id=?').run(version,responsibility,now,member.id)
  return {version,versionId:id,changeClass:input.changeClass,responsibility,model,agentPreset,memoryScope:JSON.parse(memory),prompt:rawPrompt}
}
export function memberActivity(db:DatabaseSync,now:number,memberId:string,timeZone='Asia/Shanghai') {
  const format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
  const today=format.format(now), keys:string[]=[]
  // Calendar dates are generated at UTC noon to avoid local DST midnight gaps.
  const noon=Date.parse(today+'T12:00:00Z')
  for(let i=83;i>=0;i--)keys.push(new Date(noon-i*86400000).toISOString().slice(0,10))
  const buckets=new Map(keys.map(day=>[day,{day,count:0,runs:0,succeeded:0,failed:0}]))
  const runs=db.prepare('SELECT created_at,status FROM task_run WHERE member_id=? AND created_at>=? AND created_at<=?').all(memberId,now-85*86400000,now) as {created_at:number;status:string}[]
  for(const run of runs){const b=buckets.get(format.format(run.created_at));if(!b)continue;b.runs++;b.count++;if(run.status==='succeeded')b.succeeded++;if(run.status==='failed')b.failed++}
  const events=db.prepare('SELECT created_at FROM audit_log WHERE actor_id=? AND created_at>=? AND created_at<=?').all(memberId,now-85*86400000,now) as {created_at:number}[]
  for(const event of events){const b=buckets.get(format.format(event.created_at));if(b)b.count++}
  const days=[...buckets.values()]
  return {days,total:days.reduce((n,d)=>n+d.count,0),from:keys[0],to:keys[83],timeZone,definition:'count = task_run creations + audit actions; runs counts execution attempts'}
}
