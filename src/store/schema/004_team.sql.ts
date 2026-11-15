// 手工编写的增量迁移（v4）：项目群的多 bot 协作。
//
// 1. `member.scope_project_id`：临时 bot 只属于一个项目群，成员列表默认不显示；
// 2. `project_participant`：手动拉进群 / 自动创建的临时 bot，移除用软删（removed_at）；
// 3. `project_message`：群聊合并记录。每个参与者仍各有自己的宿主会话，
//    这里只存「谁在什么时候说了什么」，不把整份会话日志抄一遍；
// 4. `chat_cursor`：每个会话已合并到哪条事件 seq，避免重复。
export const TEAM_SCHEMA_META = {
  tableNames: ['project_participant', 'project_message', 'chat_cursor'],
  note: 'v4 项目群团队：participants / merged messages / session cursor',
} as const

export const TEAM_SCHEMA_SQL = `-- [P4] 临时 bot 的归属项目；NULL = 常规成员
ALTER TABLE member ADD COLUMN scope_project_id TEXT;

CREATE TABLE project_participant (       -- [P4] 项目群成员（不包含推进 bot，它在 project.coordinator_id）
  project_id        TEXT NOT NULL REFERENCES project(id),
  member_id         TEXT NOT NULL REFERENCES member(id),
  kind              TEXT NOT NULL CHECK (kind IN ('member','temp')),
  brief             TEXT NOT NULL DEFAULT '',
  added_by          TEXT NOT NULL REFERENCES member(id),
  added_at          INTEGER NOT NULL,
  removed_by        TEXT REFERENCES member(id),
  removed_at        INTEGER,
  PRIMARY KEY (project_id, member_id)
);

CREATE INDEX idx_project_participant_active ON project_participant(project_id) WHERE removed_at IS NULL;

CREATE TABLE project_message (           -- [P4] 群聊合并记录
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id),
  author_kind   TEXT NOT NULL CHECK (author_kind IN ('human','bot','system')),
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  text          TEXT NOT NULL,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','mention','system')),
  to_member_id  TEXT,
  session_id    TEXT
);

CREATE INDEX idx_project_message_project ON project_message(project_id, at, id);

CREATE TABLE chat_cursor (               -- [P4] 会话事件已合并到哪一条
  session_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id),
  last_seq    INTEGER NOT NULL DEFAULT 0
);
`
