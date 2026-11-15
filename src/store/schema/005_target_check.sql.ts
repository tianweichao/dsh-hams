// 增量迁移（v5）：阶段目标的「提交检验」记录。
//
// 一个阶段目标可以被反复检验（项目经理提交），每次留下：谁、什么时候、结果、报告链接、说明。
// 原来的 project_phase_check 只是勾选清单，没有提交人与报告，无法承载这条业务记录。
export const TARGET_CHECK_SCHEMA_META = {
  tableNames: ['project_phase_target_check'],
  note: 'v5 阶段目标检验记录（submitted_by / result / report_url）',
} as const

export const TARGET_CHECK_SCHEMA_SQL = `CREATE TABLE project_phase_target_check (   -- [P5] 阶段目标的检验提交
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  target_id     TEXT NOT NULL REFERENCES project_phase_target(id),
  submitted_by  TEXT NOT NULL REFERENCES member(id),
  submitted_at  INTEGER NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('met','missed','unknown')),
  report_url    TEXT,
  note          TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_phase_target_check_target ON project_phase_target_check(target_id, submitted_at);
`
