// ⚠️ 自动生成，请勿手改。生成命令：node scripts/split-schema.mjs
// 来源：docs/schema-2026-11-14.sql（sha256 91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7）
// v2 迁移：只含知识四张表；其余 P2/壳表仍按分期后置。

export const KNOWLEDGE_SCHEMA_SQL = `-- ⚠️ 自动生成，请勿手改。
-- 来源（权威）：docs/schema-2026-11-14.sql
-- 权威文件 sha256：91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7
-- 生成命令：node scripts/split-schema.mjs
-- 内容：v2 知识 4 表 / 0 索引 / 0 触发器 / 0 种子语句
-- 分期依据：权威 DDL 里 [P2] 且表名属于知识子集的表；v1 已建的 41 张 P1 表不重复。
-- ───────────────────────── 2. 知识 ─────────────────────────
CREATE TABLE kb_table (                  -- [P2]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source_kind       TEXT NOT NULL CHECK (source_kind IN ('hive','lark_base','local','webhook')),
  source_ref        TEXT,
  schema_json       TEXT NOT NULL,
  field_map_status  TEXT NOT NULL DEFAULT 'ok' CHECK (field_map_status IN ('ok','missing')),
  updated_at        INTEGER NOT NULL
);

CREATE TABLE kb_doc (                    -- [P2]
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body_ref          TEXT NOT NULL,                   -- 绝对路径或 URL；面板内撰写的落在 hams/knowledge/docs
  revision          INTEGER NOT NULL DEFAULT 1,
  owner_id          TEXT NOT NULL REFERENCES member(id),
  source_kind       TEXT NOT NULL DEFAULT 'hams'
                    CHECK (source_kind IN ('hams','file')),   -- hams=面板内撰写；file=导入的本地文件
  content_hash      TEXT NOT NULL DEFAULT '',        -- sha256(原文)，用于判断磁盘上的文件是否被外部改动
  bytes             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
  updated_at        INTEGER NOT NULL
);

CREATE TABLE kb_skill (                  -- [P2]
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  domain            TEXT,
  published_version_id TEXT REFERENCES kb_skill_version(id),  -- NULL = 尚无已发布版本
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE kb_skill_version (          -- [P2] 发布走 approval(subject_kind='skill_publish')
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL REFERENCES kb_skill(id),
  version           TEXT NOT NULL,
  manifest_json     TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','in_review','published','retired')),
  authored_by       TEXT NOT NULL REFERENCES member(id),
  published_by      TEXT REFERENCES member(id),
  published_at      INTEGER,
  UNIQUE (skill_id, version)
);
`

export const KNOWLEDGE_SCHEMA_META = {
  authority: "docs/schema-2026-11-14.sql",
  authoritySha256: "91590bcaaeb9612f800a39297d4effe9ddcb419dbb822de1a3eb268be6969ec7",
  tables: 4,
  tableNames: ["kb_table","kb_doc","kb_skill","kb_skill_version"] as const,
} as const

export type KnowledgeSchemaMeta = typeof KNOWLEDGE_SCHEMA_META
