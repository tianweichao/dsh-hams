// 手工编写的增量迁移（v8）：项目记忆 + bot 记忆。
//
// 项目记忆是「推进过程中值得留下来的话」：决策、偏好、教训、事实，以及 bot 能力类
// 经验。它和知识库（kb_doc）不同：知识库是成篇文档，记忆是短句 + 来源，默认按项目
// 隔离；能力类记忆会镜像一份到 `bot_memory`，在对应 bot 的会话上下文里注入。
//
// 只追加、可归档；不删外键数据，项目软删时记忆随项目一起隐藏。
export const MEMORY_SCHEMA_META = {
  tableNames: ['project_memory', 'bot_memory'] as const,
  alteredTables: [] as const,
  note: 'v8 项目记忆：project_memory + bot 镜像 bot_memory',
} as const

export const MEMORY_SCHEMA_SQL = `CREATE TABLE project_memory (           -- [P4] 项目推进过程中收集的记忆
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  kind          TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','lesson','capability')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('auto','manual','tool')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  member_id     TEXT REFERENCES member(id),       -- 能力类记忆归属的 bot；其它类型为 NULL
  source_ref    TEXT,                             -- message:<id> / manual / tool
  dedupe_key    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES member(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, dedupe_key)
);

CREATE INDEX idx_project_memory_project ON project_memory(project_id, status, created_at);

CREATE TABLE bot_memory (             -- [P4] 能力类记忆同步给 bot 的快照
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES member(id),
  project_id    TEXT NOT NULL REFERENCES project(id),
  memory_id     TEXT NOT NULL REFERENCES project_memory(id),
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (member_id, memory_id)
);

CREATE INDEX idx_bot_memory_member ON bot_memory(member_id, created_at);
`
