// 手工编写的增量迁移（v7）：归档项目可以「删除」。
//
// 设计取舍：这里不是物理删除。HAMS 的证据和审计是追加式的，硬删会绕开
// `trg_evidence_no_delete` 与审计留痕；因此「删除」= 在项目上打 removed 标记，
// 列表/详情/群聊不再出现，同时把该项目的工作项解绑为「无项目」继续留在任务里。
// 需要物理清库时另行走运维工具，不在界面里提供。
export const PROJECT_DELETE_SCHEMA_META = {
  tableNames: [] as const,
  alteredTables: ['project'] as const,
  note: 'v7 项目软删除：project.deleted_at / deleted_by；工作项解绑保留',
} as const

export const PROJECT_DELETE_SCHEMA_SQL = `ALTER TABLE project ADD COLUMN deleted_at INTEGER;
ALTER TABLE project ADD COLUMN deleted_by TEXT REFERENCES member(id);
-- 项目名有 UNIQUE 约束：软删时把名字改成墓碑，原值留在这里，名字可复用。
ALTER TABLE project ADD COLUMN deleted_name TEXT;
`
