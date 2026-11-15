// 手工编写的增量迁移（v9）：bot 每个配置版本的人设提示词。
//
// 2026-11-15 口径：运行中创建的 bot 也要能改提示词，工具仍继承 hams-bot preset。
// 提示词跟着 `member_version` 冻结——改提示词必须发新版本（大改），旧会话/旧运行
// 继续用它发布时的文本。空字符串表示「没有额外人设」，只有 HAMS 基础规则。
export const BOT_PROMPT_SCHEMA_META = {
  tableNames: [] as const,
  alteredTables: ['member_version'] as const,
  note: 'v9 bot 提示词：member_version.prompt（随配置版本冻结）',
} as const

export const BOT_PROMPT_SCHEMA_SQL = `ALTER TABLE member_version ADD COLUMN prompt TEXT NOT NULL DEFAULT '';

-- 注意：member_version 有 IMMUTABLE 触发器（发布即不可变），迁移里不能回填已有行。
-- 已有 bot 的 prompt 保持空字符串（只有 HAMS 基础规则），需要时由人发布新版本补上；
-- 新建 bot 在 insertMember 里默认用职责作为初版提示词。
`
