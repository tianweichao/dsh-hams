# docs

公开仓库只保留两类文档：

- [`schema-2026-11-14.sql`](schema-2026-11-14.sql)：SQLite 权威 DDL，`scripts/split-schema.mjs` 从它生成迁移用的 `src/store/schema/*.sql(.ts)`；`tests/store/schema-drift.test.ts` 会逐句比对，改表结构必须先改这里再重新生成。
- [`workspace-profile.example.json`](workspace-profile.example.json)：可选的工作区画像示例，放到 `$DSH_HOME/hams/workspace-profile.json` 后首次启动会导入。

内部设计稿、进展记录、验收证据和设计画板不随本包发布。
