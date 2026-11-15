// 增量迁移（v6）：阶段目标的「说明 / 检验提交与审批」字段。
//
// - `project_phase_target.detail`：目标详情（计算方式与验收要求）；
// - `project_phase_target_check`：补上审批人、状态、审批决定与摘要。提交检验 = 申请审批，
//   审批通过后目标才算达成（审批本身复用 approval 表，subject_kind = 'target_change'）。
export const TARGET_FLOW_SCHEMA_META = {
  tableNames: [],
  note: 'v6 阶段目标说明 + 检验提交的审批字段（ALTER TABLE）',
} as const

export const TARGET_FLOW_SCHEMA_SQL = `ALTER TABLE project_phase_target ADD COLUMN detail TEXT NOT NULL DEFAULT '';

ALTER TABLE project_phase_target_check ADD COLUMN approver_id TEXT REFERENCES member(id);
ALTER TABLE project_phase_target_check ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE project_phase_target_check ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE project_phase_target_check ADD COLUMN decided_by TEXT REFERENCES member(id);
ALTER TABLE project_phase_target_check ADD COLUMN decided_at INTEGER;
ALTER TABLE project_phase_target_check ADD COLUMN decision_note TEXT NOT NULL DEFAULT '';
`
