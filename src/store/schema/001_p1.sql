-- ⚠️ 自动生成，请勿手改。
-- 来源（权威）：docs/schema-2026-11-14.sql
-- 权威文件 sha256：91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7
-- 生成命令：node scripts/split-schema.mjs
-- 内容：P1 41 表 / 30 索引 / 31 触发器 / 2 种子语句
-- 分期依据：表注释里的 [P1] / [P2] / [壳] 标记；触发器按它引用的表取最晚一档。
CREATE TABLE hams_meta (                 -- [P1] schema_version / runtime_epoch / primary_workspace_id / last_tick_at
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

-- ───────────────────────── 1. 成员、岗位与授权 ─────────────────────────
CREATE TABLE member (                    -- [P1] 人、bot 与唯一的系统主体共用主键空间
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('human','bot','system')),
  name              TEXT NOT NULL,
  domain            TEXT,
  responsibility    TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'executor'
                    CHECK (role IN ('coordinator','executor','observer')),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','retired')),
  current_version   INTEGER NOT NULL DEFAULT 0,
  owner_human_id    TEXT REFERENCES member(id),      -- bot 的责任人
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (kind <> 'bot' OR owner_human_id IS NOT NULL)
);

CREATE INDEX idx_member_kind ON member(kind, status);

CREATE UNIQUE INDEX uq_member_system ON member(kind) WHERE kind = 'system';

INSERT INTO member (id, kind, name, created_at, updated_at) VALUES ('system', 'system', '系统', 0, 0);

CREATE TABLE member_version (            -- [P1] bot 配置快照：发布即不可变
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES member(id),
  version           INTEGER NOT NULL,
  agent_preset      TEXT,                            -- 宿主 agentPreset（不是 permissionPresets）
  model             TEXT,
  memory_scope_json TEXT NOT NULL DEFAULT '{}',
  prompt_digest     TEXT NOT NULL,
  change_class      TEXT NOT NULL DEFAULT 'minor' CHECK (change_class IN ('minor','major')),
  published_by      TEXT NOT NULL REFERENCES member(id),
  published_at      INTEGER NOT NULL,
  UNIQUE (member_id, version)
);

CREATE TABLE member_permission (         -- [P1] 只用于 bot；人的权限走岗位
  member_id         TEXT NOT NULL REFERENCES member(id),
  capability        TEXT NOT NULL,
  scope             TEXT NOT NULL,                   -- domain:<域> | project:<id> | global
  granted_by        TEXT NOT NULL REFERENCES member(id),
  granted_at        INTEGER NOT NULL,
  PRIMARY KEY (member_id, capability, scope)
);

CREATE TABLE member_tool_policy (        -- [P1] 无记录 = 不可用
  member_id         TEXT NOT NULL REFERENCES member(id),
  tool_name         TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, tool_name)
);

CREATE TABLE hams_user (                 -- [P1] 登录身份 → human 成员；HAMS 不存口令、不发 token
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL UNIQUE REFERENCES member(id),
  login             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  auth_source       TEXT NOT NULL CHECK (auth_source IN ('local_host','sso','gateway_local')),
  external_id       TEXT NOT NULL,                   -- 宿主账号 id / OIDC sub / 网关本地账号名
  expires_at        INTEGER,                         -- gateway_local 兜底账号必须限期
  is_admin          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at     INTEGER,
  UNIQUE (auth_source, external_id),
  CHECK (auth_source <> 'gateway_local' OR expires_at IS NOT NULL)
);

CREATE TABLE position (                  -- [P1] 权限挂岗位
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  domain            TEXT,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired'))
);

CREATE TABLE position_permission (     -- [P1]
  position_id       TEXT NOT NULL REFERENCES position(id),
  capability        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  PRIMARY KEY (position_id, capability, scope)
);

CREATE TABLE member_position (           -- [P1] 在岗区间 [starts_at, ends_at)
  member_id         TEXT NOT NULL REFERENCES member(id),
  position_id       TEXT NOT NULL REFERENCES position(id),
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER,
  assigned_by       TEXT NOT NULL REFERENCES member(id),
  PRIMARY KEY (member_id, position_id, starts_at),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX idx_mp_active ON member_position(member_id, ends_at);

-- ───────────────────────── 3. 项目与指标 ─────────────────────────
CREATE TABLE project (                   -- [P1]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL CHECK (type IN ('one_off','continuous')),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','archived')),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),
  coordinator_id    TEXT REFERENCES member(id),
  goal_text         TEXT NOT NULL,
  current_target_version INTEGER NOT NULL DEFAULT 0,
  no_progress_streak INTEGER NOT NULL DEFAULT 0,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE project_target_version (    -- [P1] 口径版本：发布即冻结
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  version           INTEGER NOT NULL,
  goal_text         TEXT NOT NULL,
  published_by      TEXT NOT NULL REFERENCES member(id),
  published_at      INTEGER NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE project_metric (            -- [P1] 口径 = 预置计算器 + 参数，不存自由表达式
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id),
  version_id        TEXT NOT NULL REFERENCES project_target_version(id),
  name              TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('higher','lower','range')),
  target_value      REAL,
  target_max        REAL,                            -- direction='range' 时的上界
  unit              TEXT,
  definition_text   TEXT NOT NULL DEFAULT '',        -- 给人看的口径说明
  calculator_key    TEXT,                            -- 例：ratio_of_counts；NULL = 未定义口径
  calculator_params_json TEXT NOT NULL DEFAULT '{}',
  window_kind       TEXT NOT NULL CHECK (window_kind IN ('day','week','month','snapshot')),
  source_kind       TEXT CHECK (source_kind IS NULL OR source_kind IN ('ledger','work_item','webhook','manual')),
  source_ref        TEXT,
  trial_value       REAL,                            -- 发布前试算结果
  trial_at          INTEGER,
  UNIQUE (version_id, name)
);

CREATE TABLE project_budget (            -- [P1] 额度按「周期类型 + 周期起点 + 计量项」记账
  project_id        TEXT NOT NULL REFERENCES project(id),
  period_kind       TEXT NOT NULL CHECK (period_kind IN ('day','week')),
  period_start      TEXT NOT NULL,                   -- YYYY-MM-DD（项目时区）
  metric            TEXT NOT NULL CHECK (metric IN ('new_tasks','proposals')),
  used              INTEGER NOT NULL DEFAULT 0,
  limit_value       INTEGER NOT NULL,
  PRIMARY KEY (project_id, period_kind, period_start, metric)
);

CREATE TABLE metric_observation (        -- [P1] value NULL = 缺数
  id                TEXT PRIMARY KEY,
  metric_id         TEXT NOT NULL REFERENCES project_metric(id),
  observed_at       INTEGER NOT NULL,
  window_start      INTEGER NOT NULL,
  window_end        INTEGER NOT NULL,
  value             REAL,
  source_ref        TEXT,
  ingested_at       INTEGER NOT NULL
);

CREATE INDEX idx_obs_metric ON metric_observation(metric_id, window_end DESC);

-- ───────────────────────── 4. 资产、模板与入站事件 ─────────────────────────
CREATE TABLE asset (                     -- [P1] 外部资产的稳定映射
  id                TEXT PRIMARY KEY,
  external_system   TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'battery',
  display_name      TEXT NOT NULL,
  last_snapshot_date TEXT,
  UNIQUE (external_system, external_id)
);

CREATE TABLE ledger_snapshot (           -- [P1] Hive 台账镜像，页面只查本地
  snapshot_date     TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES asset(id),
  status            TEXT,
  attrs_json        TEXT NOT NULL DEFAULT '{}',
  source_ref        TEXT NOT NULL,
  ingested_at       INTEGER NOT NULL,
  PRIMARY KEY (snapshot_date, asset_id)
);

CREATE INDEX idx_ledger_asset ON ledger_snapshot(asset_id, snapshot_date DESC);

CREATE TABLE work_template (             -- [P1]
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,            -- 例：battery_alert_tracking
  name              TEXT NOT NULL,
  domain            TEXT NOT NULL,
  category          TEXT NOT NULL,
  published_version_id TEXT REFERENCES work_template_version(id)
);

CREATE TABLE work_template_version (     -- [P1] 关闭判据的出处：证据要求、复查策略、验收策略
  id                TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL REFERENCES work_template(id),
  version           INTEGER NOT NULL,
  required_evidence_json TEXT NOT NULL DEFAULT '[]', -- [{kind,min_count,max_age_hours}]
  validator_key     TEXT,                            -- 代码内置的具名验证器；NULL = 只做证据清单核对
  validator_params_json TEXT NOT NULL DEFAULT '{}',
  check_policy_json TEXT NOT NULL DEFAULT '{}',      -- {mode:'next_day_at',time:'09:00',tz,max_rechecks}
  review_policy_json TEXT NOT NULL DEFAULT '{}',     -- {approver:'owner'|'position:<id>',expires_hours,auto_close}
  misfire_policy    TEXT NOT NULL DEFAULT 'each' CHECK (misfire_policy IN ('each','catch_up_latest','skip')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  published_by      TEXT REFERENCES member(id),
  published_at      INTEGER,
  UNIQUE (template_id, version)
);

CREATE TABLE event_inbox (               -- [P1] 入站事件幂等：同一外部事件只产生一次业务效果
  id                TEXT PRIMARY KEY,
  connector         TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  asset_id          TEXT REFERENCES asset(id),
  event_type        TEXT NOT NULL,
  severity          INTEGER NOT NULL DEFAULT 0,
  payload_ref       TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  occurred_at       INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  work_item_id      TEXT REFERENCES work_item(id),   -- 处置后回填
  disposition       TEXT NOT NULL DEFAULT 'received'
                    CHECK (disposition IN ('received','created','attached','escalated','ignored')),
  UNIQUE (connector, external_event_id)
);

CREATE INDEX idx_inbox_asset ON event_inbox(asset_id, occurred_at DESC);

-- ───────────────────────── 5. 工作项、运行与证据 ─────────────────────────
CREATE TABLE work_item_transition (      -- [P1] 状态白名单：域代码与触发器共用这一份
  from_status       TEXT NOT NULL,
  to_status         TEXT NOT NULL,
  command           TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO work_item_transition (from_status, to_status, command) VALUES
  ('ready','active','claim|accept'),
  ('ready','blocked','reportBlocker'),
  ('ready','paused','pause'),
  ('ready','cancelled','cancel'),
  ('active','ready','release|takeOver|handoff/accept'),
  ('active','waiting_check','submitResult'),
  ('active','waiting_review','requestClosure'),
  ('active','blocked','reportBlocker'),
  ('active','paused','pause'),
  ('active','failed','fail'),
  ('active','cancelled','cancel'),
  ('waiting_check','active','check failed'),
  ('waiting_check','waiting_review','requestClosure'),
  ('waiting_check','blocked','check unknown|retries exhausted|reportBlocker'),
  ('waiting_check','paused','pause'),
  ('waiting_check','cancelled','cancel'),
  ('waiting_review','completed','approval approve|auto close'),
  ('waiting_review','active','approval reject|approval authorize'),
  ('waiting_review','blocked','approval return'),
  ('waiting_review','paused','pause'),
  ('waiting_review','cancelled','cancel'),
  ('blocked','ready','unblock'),
  ('blocked','active','unblock'),
  ('blocked','waiting_check','scheduleCheck'),
  ('blocked','waiting_review','requestClosure'),
  ('blocked','paused','pause'),
  ('blocked','cancelled','cancel'),
  ('paused','ready','resume'),
  ('paused','active','resume'),
  ('paused','waiting_check','resume'),
  ('paused','waiting_review','resume'),
  ('paused','blocked','resume'),
  ('paused','cancelled','cancel'),
  ('completed','ready','reopen'),
  ('failed','ready','retry'),
  ('failed','cancelled','cancel');

CREATE TABLE work_item (                 -- [P1]
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id),
  parent_id         TEXT REFERENCES work_item(id),
  template_version_id TEXT REFERENCES work_template_version(id),
  asset_id          TEXT REFERENCES asset(id),
  domain            TEXT NOT NULL,
  category          TEXT NOT NULL,
  title             TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('ready','active','waiting_check','waiting_review','blocked',
                                      'paused','completed','failed','cancelled')),
  resume_state      TEXT CHECK (resume_state IS NULL OR resume_state IN
                                ('ready','active','waiting_check','waiting_review','blocked')),
  blocked_reason    TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN
                                ('needs_evidence','external','dependency','permission','human_input','data_source')),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),   -- 对结果负责的人
  assignee_id       TEXT REFERENCES member(id),            -- 当前执行者：人或 bot
  due_at            INTEGER,
  next_action_at    INTEGER,
  check_generation  INTEGER NOT NULL DEFAULT 0,
  close_requires_approval INTEGER NOT NULL DEFAULT 1,
  dedupe_key        TEXT,                                  -- 例：alert:BT-20871:overdischarge
  revision          INTEGER NOT NULL DEFAULT 1,            -- 对象修订号：行或证据集每变一次 +1
  execution_epoch   INTEGER NOT NULL DEFAULT 1,            -- 执行代次：暂停/恢复/取消/重开/换执行者 +1
  fence_seq         INTEGER NOT NULL DEFAULT 0,            -- 租约栅栏号发号器
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- 有效证据集的哈希
  created_by        TEXT NOT NULL REFERENCES member(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  CHECK ((status = 'paused') = (resume_state IS NOT NULL)),
  CHECK (status = 'blocked' OR resume_state IS 'blocked' OR blocked_reason IS NULL)
);

-- 去重只约束「仍在处理」的单：关单后同一电池再次告警可以新建
CREATE UNIQUE INDEX uq_wi_dedupe ON work_item(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed','cancelled');

CREATE INDEX idx_wi_status_due ON work_item(status, next_action_at);

CREATE INDEX idx_wi_assignee ON work_item(assignee_id, status);

CREATE INDEX idx_wi_owner ON work_item(owner_human_id, status);

CREATE INDEX idx_wi_asset ON work_item(asset_id, created_at DESC);

CREATE INDEX idx_wi_project ON work_item(project_id, domain, status);

CREATE TABLE work_item_relation (        -- [P1]
  from_id           TEXT NOT NULL REFERENCES work_item(id),
  to_id             TEXT NOT NULL REFERENCES work_item(id),
  kind              TEXT NOT NULL CHECK (kind IN ('blocks','duplicate_of','caused_by')),
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

CREATE TABLE work_item_event (           -- [P1] 追加式时间线
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  kind              TEXT NOT NULL,
  actor_id          TEXT NOT NULL REFERENCES member(id),   -- 系统动作用 'system'
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','bot','system')),
  payload_json      TEXT NOT NULL DEFAULT '{}',
  revision          INTEGER NOT NULL,
  execution_epoch   INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_event_wi ON work_item_event(work_item_id, created_at);

CREATE TABLE work_item_thread (          -- [P1] 工作项的会话代次：历史全保留，同时只有一条在用
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  generation        INTEGER NOT NULL,
  session_id        TEXT NOT NULL UNIQUE,                  -- 宿主会话 id；不得跨工作项复用
  member_id         TEXT NOT NULL REFERENCES member(id),
  member_version    INTEGER NOT NULL,                      -- 开会话时固化的配置版本
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','pending_rotate','rotated','closed')),
  turn_count        INTEGER NOT NULL DEFAULT 0,
  rotate_after_turns INTEGER NOT NULL DEFAULT 200,
  rotate_after_days INTEGER NOT NULL DEFAULT 30,
  opened_at         INTEGER NOT NULL,
  closed_at         INTEGER,
  close_reason      TEXT,
  UNIQUE (work_item_id, generation)
);

CREATE UNIQUE INDEX uq_thread_current ON work_item_thread(work_item_id)
  WHERE status IN ('active','pending_rotate');

CREATE TABLE work_item_check (           -- [P1] 复查：每个代次一条，按模板版本判定
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  generation        INTEGER NOT NULL,
  execution_epoch   INTEGER NOT NULL,
  template_version_id TEXT REFERENCES work_template_version(id),
  planned_due_at    INTEGER NOT NULL,                      -- 及时率按它算，不按实际执行时间
  status            TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','running','passed','failed','unknown','cancelled')),
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- 判定时的证据集
  result_json       TEXT NOT NULL DEFAULT '{}',
  evaluated_at      INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (work_item_id, generation)
);

CREATE INDEX idx_check_due ON work_item_check(status, planned_due_at);

CREATE TABLE task_run (                  -- [P1] bot 的一次执行尝试
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  thread_id         TEXT NOT NULL REFERENCES work_item_thread(id),
  check_id          TEXT REFERENCES work_item_check(id),
  member_id         TEXT NOT NULL REFERENCES member(id),
  member_version    INTEGER NOT NULL,
  skill_versions_json TEXT NOT NULL DEFAULT '{}',
  execution_epoch   INTEGER NOT NULL,                      -- 创建时工作项的执行代次
  runtime_epoch     INTEGER NOT NULL,                      -- 创建时的宿主启动代次
  fence             INTEGER NOT NULL,
  trigger           TEXT NOT NULL CHECK (trigger IN ('claim','check','schedule','manual','retry','instruction')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','cancelled','orphaned','unknown')),
  result_summary    TEXT,
  error_kind        TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  UNIQUE (work_item_id, fence)
);

CREATE UNIQUE INDEX uq_wi_active_run ON task_run(work_item_id) WHERE status IN ('queued','running');

CREATE UNIQUE INDEX uq_member_active_run ON task_run(member_id) WHERE status = 'running';

CREATE INDEX idx_run_runtime ON task_run(runtime_epoch, status);

CREATE TABLE run_step (                  -- [P1] 粗粒度步骤摘要；不存 token 级明细
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES task_run(id),
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('reason','tool','message','wait_human','error')),
  tool_name         TEXT,
  summary           TEXT NOT NULL,
  payload_ref       TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE lease (                     -- [P1] 只管 bot 的活跃运行；人的认领不靠租约
  work_item_id      TEXT PRIMARY KEY REFERENCES work_item(id),
  holder_member_id  TEXT NOT NULL REFERENCES member(id),
  run_id            TEXT NOT NULL REFERENCES task_run(id),
  fence             INTEGER NOT NULL,
  runtime_epoch     INTEGER NOT NULL,
  lease_until       INTEGER NOT NULL,
  renewed_at        INTEGER NOT NULL
);

CREATE INDEX idx_lease_expiry ON lease(lease_until);

CREATE TABLE evidence (                  -- [P1] 追加式；更正另起一行并指向被替代的那行
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  run_id            TEXT REFERENCES task_run(id),
  kind              TEXT NOT NULL,                         -- reading / photo / receipt / log / doc
  ref               TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT '',
  observed_at       INTEGER NOT NULL,                      -- 事实发生时间
  captured_at       INTEGER NOT NULL,
  captured_by       TEXT NOT NULL REFERENCES member(id),
  on_behalf_of      TEXT REFERENCES member(id),            -- 代录时填实际反馈人
  supersedes_id     TEXT REFERENCES evidence(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','stale')),
  verified_by       TEXT REFERENCES member(id),
  verified_at       INTEGER,
  purged_at         INTEGER                                -- 保留期满只删文件，行与哈希保留
);

CREATE INDEX idx_ev_wi ON evidence(work_item_id, kind, status);

CREATE TABLE handoff (                   -- [P1]
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL REFERENCES work_item(id),
  from_member_id    TEXT NOT NULL REFERENCES member(id),
  to_member_id      TEXT NOT NULL REFERENCES member(id),
  reason_kind       TEXT NOT NULL CHECK (reason_kind IN
                     ('need_physical_action','need_authority','out_of_domain','capability_missing','takeover')),
  note              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  CHECK (from_member_id <> to_member_id)
);

CREATE UNIQUE INDEX uq_handoff_pending ON handoff(work_item_id) WHERE status = 'pending';

CREATE TABLE attention_item (            -- [P1] 需人关注事项：孤儿运行、重试耗尽、连续无进展、告警加重、外发结果未知、漏跑。与审批超时无关
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT REFERENCES work_item(id),
  project_id        TEXT REFERENCES project(id),
  reason            TEXT NOT NULL CHECK (reason IN
                     ('orphaned_run','retries_exhausted','no_progress','severity_raised','outbox_unknown','missed_check')),
  detail            TEXT NOT NULL DEFAULT '',
  to_member_id      TEXT NOT NULL REFERENCES member(id),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT REFERENCES member(id)
);

CREATE INDEX idx_attention_open ON attention_item(to_member_id, resolved_at);

-- ───────────────────────── 6. 提议与审批 ─────────────────────────
CREATE TABLE proposal (                  -- [P1] bot 的「我想做这件事」
  id                TEXT PRIMARY KEY,
  subject_key       TEXT NOT NULL,                         -- project:<id> | work_item:<id> | global（不用 NULL）
  project_id        TEXT REFERENCES project(id),
  work_item_id      TEXT REFERENCES work_item(id),
  kind              TEXT NOT NULL CHECK (kind IN
                     ('create_task','upgrade_task','permission_request','scope_change','knowledge_change')),
  dedupe_key        TEXT NOT NULL,                         -- 规范化后的意图键，例：recount:offline-12
  proposed_by       TEXT NOT NULL REFERENCES member(id),
  decider_id        TEXT NOT NULL REFERENCES member(id),   -- 由谁决定（默认项目负责人）
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  rationale_json    TEXT NOT NULL,                         -- {evidence:[...],expected_effect,cost}；evidence 为空不落库
  impact_json       TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','accepted','rejected','expired','superseded')),
  duplicate_count   INTEGER NOT NULL DEFAULT 0,
  snoozed_until     INTEGER,                               -- 「稍后再说」只改这里，不产生决定
  expires_at        INTEGER,
  result_work_item_id TEXT REFERENCES work_item(id),
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_proposal_open ON proposal(subject_key, kind, dedupe_key) WHERE status = 'open';

CREATE INDEX idx_proposal_decider ON proposal(decider_id, status);

CREATE TABLE decision (                  -- [P1] 只记终态决定；一条提议至多一条
  id                TEXT PRIMARY KEY,
  proposal_id       TEXT NOT NULL UNIQUE REFERENCES proposal(id),
  decided_by        TEXT NOT NULL REFERENCES member(id),
  decision          TEXT NOT NULL CHECK (decision IN ('accept','reject')),
  channel           TEXT NOT NULL CHECK (channel = 'ui'),
  note              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  CHECK (decision <> 'reject' OR length(note) > 0)
);

CREATE TABLE approval (                  -- [P1] 人的一次把关
  id                TEXT PRIMARY KEY,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN
                     ('work_item_close','evidence_override','asset_disposal','skill_publish',
                      'target_change','permission_grant','project_archive')),
  subject_id        TEXT NOT NULL,                         -- 前三类指向 work_item.id
  subject_revision  INTEGER NOT NULL,                      -- 申请时对象的修订号
  execution_epoch   INTEGER NOT NULL DEFAULT 0,            -- 仅工作项类审批使用
  evidence_set_hash TEXT NOT NULL DEFAULT '',              -- 申请时锁定的证据集 / 内容哈希
  criteria_ref      TEXT NOT NULL DEFAULT '',              -- 判据版本：work_template_version.id 等
  criteria_json     TEXT NOT NULL DEFAULT '{}',            -- 判据逐条结果快照，供界面展示
  reason_text       TEXT NOT NULL,
  requested_by      TEXT NOT NULL REFERENCES member(id),
  requested_channel TEXT NOT NULL CHECK (requested_channel IN ('tool','ui','system')),
  approver_id       TEXT NOT NULL REFERENCES member(id),   -- 申请时按模板验收策略解析，不由申请方挑选
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','returned',
                                      'expired','invalidated','withdrawn')),
  decided_by        TEXT REFERENCES member(id),
  decided_channel   TEXT CHECK (decided_channel IS NULL OR decided_channel = 'ui'),
  decision_note     TEXT NOT NULL DEFAULT '',
  decided_at        INTEGER,
  invalidated_reason TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK (status NOT IN ('rejected','returned') OR length(decision_note) > 0)
);

CREATE UNIQUE INDEX uq_approval_pending ON approval(subject_kind, subject_id) WHERE status = 'pending';

CREATE INDEX idx_approval_approver ON approval(approver_id, status, expires_at);

-- ───────────────────────── 7. 调度、出站、幂等与审计 ─────────────────────────
CREATE TABLE schedule (                  -- [P1] 周期计划；逐单复查走 work_item_check
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id),
  template_version_id TEXT REFERENCES work_template_version(id),
  member_id         TEXT REFERENCES member(id),
  owner_human_id    TEXT NOT NULL REFERENCES member(id),
  kind              TEXT NOT NULL CHECK (kind IN ('at','every','cron')),
  spec              TEXT NOT NULL,
  timezone          TEXT NOT NULL,                         -- IANA 时区
  misfire_policy    TEXT NOT NULL DEFAULT 'catch_up_latest' CHECK (misfire_policy IN ('each','catch_up_latest','skip')),
  concurrency       TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency IN ('skip','queue','replace')),
  max_fires         INTEGER,
  fired_count       INTEGER NOT NULL DEFAULT 0,
  next_fire_at      INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_sched_next ON schedule(enabled, next_fire_at);

CREATE TABLE schedule_occurrence (       -- [P1] 双触发防重靠主键，不靠时间比较
  schedule_id       TEXT NOT NULL REFERENCES schedule(id),
  planned_at        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'fired' CHECK (status IN ('fired','skipped','missed')),
  work_item_id      TEXT REFERENCES work_item(id),
  fired_at          INTEGER NOT NULL,                      -- 实际执行时间
  PRIMARY KEY (schedule_id, planned_at)
);

CREATE TABLE outbox (                    -- [P1] 只放对外动作；HTTP 命令幂等在 command_receipt
  id                TEXT PRIMARY KEY,
  action            TEXT NOT NULL,                         -- 例：lark.notify / ticket.create
  payload_json      TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  work_item_id      TEXT REFERENCES work_item(id),
  execution_epoch   INTEGER,                               -- 发送前与工作项当前代次比对
  approval_id       TEXT REFERENCES approval(id),
  requested_by      TEXT NOT NULL REFERENCES member(id),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','confirmed','unknown','cancelled','failed')),
  not_after         INTEGER,                               -- 过了就不再发
  available_at      INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  external_ref      TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  sending_at        INTEGER,
  finished_at       INTEGER
);

CREATE INDEX idx_outbox_due ON outbox(status, available_at);

CREATE TABLE command_receipt (           -- [P1] 写命令幂等：同键同载荷返回首次回执
  scope_key         TEXT PRIMARY KEY,                      -- hash(principal + action + idempotencyKey)
  command_id        TEXT NOT NULL,
  principal_id      TEXT NOT NULL REFERENCES member(id),
  action            TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  receipt_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_receipt_age ON command_receipt(created_at);

CREATE TABLE change_log (                -- [P1] 界面「快照 + 游标」的游标来源
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  object_kind       TEXT NOT NULL,
  object_id         TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  change_kind       TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE tick_log (                  -- [P1]
  tick_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_epoch     INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  fired             INTEGER NOT NULL DEFAULT 0,
  recovered         INTEGER NOT NULL DEFAULT 0,
  error_text        TEXT
);

CREATE TABLE audit_log (                 -- [P1] 追加式审计
  id                TEXT PRIMARY KEY,
  actor_id          TEXT NOT NULL REFERENCES member(id),
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','bot','system')),
  on_behalf_of      TEXT REFERENCES member(id),            -- 代录
  channel           TEXT NOT NULL CHECK (channel IN ('ui','tool','system','connector')),
  auth_subject      TEXT,                                  -- 宿主账号 / SSO 主体
  host_preset       TEXT,                                  -- 当时的宿主权限预设名；读不到记 'unreadable'
  action            TEXT NOT NULL,
  subject_kind      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  before_json       TEXT,
  after_json        TEXT,
  correlation_id    TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_audit_subject ON audit_log(subject_kind, subject_id, created_at);

-- ───────────────────────── 9. 触发器：把最要紧的不变量落在库里 ─────────────────────────

-- 9.1 授权：审批权只能给人，且只能经岗位
CREATE TRIGGER trg_member_permission_bot_only BEFORE INSERT ON member_permission
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'bot'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: member_permission is for bots only'); END;

CREATE TRIGGER trg_bot_no_human_capability BEFORE INSERT ON member_permission
WHEN NEW.capability IN ('approval.decide','proposal.decide','work_item.close','skill.publish',
                        'target.publish','review.confirm','project.archive','member.manage','position.manage','permission.grant')
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: capability reserved for humans'); END;

CREATE TRIGGER trg_member_position_human_only BEFORE INSERT ON member_position
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: positions are for humans only'); END;

CREATE TRIGGER trg_hams_user_human_only BEFORE INSERT ON hams_user
WHEN (SELECT kind FROM member WHERE id = NEW.member_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: login identity must bind a human member'); END;

-- 9.2 配置版本不可变
CREATE TRIGGER trg_member_version_immutable BEFORE UPDATE ON member_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: member_version'); END;

CREATE TRIGGER trg_target_version_immutable BEFORE UPDATE ON project_target_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: project_target_version'); END;

-- 9.3 工作项：负责人必须是人；计数器只增；状态只走白名单；恢复只回到暂停前状态
CREATE TRIGGER trg_wi_owner_human_ins BEFORE INSERT ON work_item
WHEN (SELECT kind FROM member WHERE id = NEW.owner_human_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: work item owner must be human'); END;

CREATE TRIGGER trg_wi_owner_human_upd BEFORE UPDATE OF owner_human_id ON work_item
WHEN (SELECT kind FROM member WHERE id = NEW.owner_human_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: work item owner must be human'); END;

CREATE TRIGGER trg_wi_counters_monotonic BEFORE UPDATE ON work_item
WHEN NEW.revision <= OLD.revision OR NEW.execution_epoch < OLD.execution_epoch OR NEW.fence_seq < OLD.fence_seq
BEGIN SELECT RAISE(ABORT, 'VERSION_CONFLICT: every write must bump revision; counters never go back'); END;

CREATE TRIGGER trg_wi_transition_whitelist BEFORE UPDATE OF status ON work_item
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM work_item_transition t WHERE t.from_status = OLD.status AND t.to_status = NEW.status)
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: transition not in whitelist'); END;

CREATE TRIGGER trg_wi_resume_target BEFORE UPDATE OF status ON work_item
WHEN OLD.status = 'paused' AND NEW.status NOT IN ('paused','cancelled') AND NEW.status IS NOT OLD.resume_state
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: resume must return to the state before pause'); END;

CREATE TRIGGER trg_wi_epoch_on_pause BEFORE UPDATE OF status ON work_item
WHEN NEW.status <> OLD.status
     AND (NEW.status IN ('paused','cancelled') OR OLD.status IN ('paused','completed','failed'))
     AND NEW.execution_epoch = OLD.execution_epoch
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: pause/resume/cancel/reopen/retry must bump execution_epoch'); END;

CREATE TRIGGER trg_wi_epoch_on_reassign BEFORE UPDATE OF assignee_id ON work_item
WHEN OLD.assignee_id IS NOT NULL AND NEW.assignee_id IS NOT OLD.assignee_id
     AND NEW.execution_epoch = OLD.execution_epoch
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: changing the executor must bump execution_epoch'); END;

-- 9.4 关单：有效审批（人工路径）或通过的复查（已授权自动关单），二者都锁定代次与证据集
CREATE TRIGGER trg_wi_complete_guard BEFORE UPDATE OF status ON work_item
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND (
  (NEW.close_requires_approval = 1 AND NOT EXISTS (
     SELECT 1 FROM approval a
      WHERE a.subject_kind = 'work_item_close' AND a.subject_id = OLD.id AND a.status = 'approved'
        AND a.subject_revision = OLD.revision AND a.execution_epoch = OLD.execution_epoch
        AND a.evidence_set_hash = OLD.evidence_set_hash))
  OR
  (NEW.close_requires_approval = 0 AND NOT EXISTS (
     SELECT 1 FROM work_item_check c
      WHERE c.work_item_id = OLD.id AND c.status = 'passed'
        AND c.execution_epoch = OLD.execution_epoch AND c.evidence_set_hash = OLD.evidence_set_hash))
)
BEGIN SELECT RAISE(ABORT, 'APPROVAL_REQUIRED: close needs a valid approval or a passed check on the same evidence'); END;

-- 9.5 工作项或证据一变，待决的审批立即作废
CREATE TRIGGER trg_wi_change_invalidates_approval AFTER UPDATE OF revision ON work_item
WHEN NEW.revision <> OLD.revision
BEGIN
  UPDATE approval SET status = 'invalidated', invalidated_reason = 'subject_changed'
   WHERE subject_kind IN ('work_item_close','evidence_override','asset_disposal') AND subject_id = NEW.id
     AND status = 'pending' AND subject_revision <> NEW.revision;
END;

-- 证据新增或状态变化都会递增工作项修订号：待决审批经上一条触发器作废，
-- 已批准但尚未关单的审批也因修订号不再匹配而无法用于关单（9.4）。证据集哈希由服务在同一事务重算。
CREATE TRIGGER trg_evidence_insert_bumps_revision AFTER INSERT ON evidence
BEGIN
  UPDATE work_item SET revision = revision + 1, updated_at = NEW.captured_at WHERE id = NEW.work_item_id;
END;

CREATE TRIGGER trg_evidence_status_bumps_revision AFTER UPDATE OF status ON evidence
WHEN NEW.status <> OLD.status
BEGIN
  UPDATE work_item SET revision = revision + 1 WHERE id = NEW.work_item_id;
END;

CREATE TRIGGER trg_evidence_immutable BEFORE UPDATE OF work_item_id, kind, ref, content_hash, observed_at, captured_by ON evidence
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: evidence facts are append-only'); END;

CREATE TRIGGER trg_evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: evidence rows are never deleted'); END;

-- 9.6 审批：审批人与决定人必须是人、走界面、是指定审批人、未过期；终态不可再改
CREATE TRIGGER trg_approval_approver_human_ins BEFORE INSERT ON approval
WHEN (SELECT kind FROM member WHERE id = NEW.approver_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: approver must be human'); END;

CREATE TRIGGER trg_approval_approver_human_upd BEFORE UPDATE OF approver_id ON approval
WHEN (SELECT kind FROM member WHERE id = NEW.approver_id) IS NOT 'human' OR OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: approver must be human and approval still pending'); END;

CREATE TRIGGER trg_approval_terminal BEFORE UPDATE OF status ON approval
WHEN OLD.status <> 'pending' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: approval already decided'); END;

CREATE TRIGGER trg_approval_decision_guard BEFORE UPDATE OF status ON approval
WHEN NEW.status IN ('approved','rejected','returned') AND (
     NEW.decided_by IS NULL
  OR NEW.decided_by <> OLD.approver_id
  OR NEW.decided_channel IS NOT 'ui'
  OR NEW.decided_at IS NULL
  OR NEW.decided_at >= OLD.expires_at
  OR (SELECT kind FROM member WHERE id = NEW.decided_by) IS NOT 'human')
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: decision must come from the designated human approver via UI before expiry'); END;

-- 9.7 提议只能由 bot 发，决定只能由人做
CREATE TRIGGER trg_proposal_by_bot BEFORE INSERT ON proposal
WHEN (SELECT kind FROM member WHERE id = NEW.proposed_by) IS NOT 'bot'
  OR (SELECT kind FROM member WHERE id = NEW.decider_id) IS NOT 'human'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: proposals come from bots and are decided by humans'); END;

CREATE TRIGGER trg_decision_by_human BEFORE INSERT ON decision
WHEN (SELECT kind FROM member WHERE id = NEW.decided_by) IS NOT 'human'
  OR NEW.decided_by IS NOT (SELECT decider_id FROM proposal WHERE id = NEW.proposal_id)
  OR (SELECT status FROM proposal WHERE id = NEW.proposal_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: decision must come from the designated human on an open proposal'); END;

-- 9.8 运行：必须落在同一工作项「在用」的会话代次上，且代次是当前的；租约只给 bot
CREATE TRIGGER trg_run_binds_current_thread BEFORE INSERT ON task_run
WHEN NOT EXISTS (SELECT 1 FROM work_item_thread t
                  WHERE t.id = NEW.thread_id AND t.work_item_id = NEW.work_item_id
                    AND t.status = 'active' AND t.member_id = NEW.member_id)
BEGIN SELECT RAISE(ABORT, 'STATE_INVALID: run must bind the active thread of the same work item and bot'); END;

CREATE TRIGGER trg_run_epoch_current BEFORE INSERT ON task_run
WHEN NEW.execution_epoch IS NOT (SELECT execution_epoch FROM work_item WHERE id = NEW.work_item_id)
BEGIN SELECT RAISE(ABORT, 'EPOCH_STALE: run must carry the current execution_epoch'); END;

CREATE TRIGGER trg_lease_bot_only BEFORE INSERT ON lease
WHEN (SELECT kind FROM member WHERE id = NEW.holder_member_id) IS NOT 'bot'
BEGIN SELECT RAISE(ABORT, 'POLICY_DENIED: leases are for bot runs only'); END;

-- 9.10 时间线与审计只追加（按月归档由迁移步骤在同一事务内临时解除后恢复）
CREATE TRIGGER trg_event_no_update BEFORE UPDATE ON work_item_event
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: work_item_event'); END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: audit_log'); END;

CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE: audit_log'); END;
