# HAMS · Human–Agent Management System

HAMS 是 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的原生业务工作台插件：把**项目、任务、人机成员、知识、项目记忆**放进同一个本地面板，让一个或多个人与一组 bot 在同一个项目里协作、留痕、复盘。

数据保存在本机 SQLite（`$DSH_HOME/hams`），不依赖外部服务，不上传遥测。

## 功能

- **项目**：目标口径与版本冻结、指标与读数、阶段目标与人工验收、复盘快照；新建项目默认使用「项目管理」bot 推进，支持草稿与归档后删除。
- **任务**：待处理 → 执行 → 复查 → 验收的闭环；证据追加、审批关单、暂停/恢复、看板与日历。
- **人机成员**：人和 bot 同一张表，bot 配置发布即版本化；默认内置「项目管理 / 数据分析」两个 bot。
- **项目群聊**：项目有自己的群，推进 bot 在群里派活；人类用 `@bot名` 直接点名某个 bot 去排查。
- **知识**：面板撰写或导入本机 Markdown（登记路径与哈希，不复制正文）、技能镜像、业务表结构登记。
- **项目记忆**：群聊中自动发现决策 / 偏好 / 教训 / 能力 / 事实，收进项目「记忆」页签；能力类记忆同步给对应 bot，进入它的会话上下文。
- **权限与审计**：人按岗位授权、bot 按能力白名单；证据与审计只追加；写命令带幂等键。

## 环境要求

- DSH `>= 0.2.2-rc.3 < 0.3.0`
- Node.js `>= 24.3`（使用原生 TypeScript 类型剥离与 `node:sqlite`）
- 可选：Python 3（只用于跑库级不变量自测）

## 安装

```bash
# 安装到 DSH profile（把 desktop 换成你的 profile 名）
dsh plugin --profile desktop add dsh-hams
```

然后在同一 profile 的 `package.json` 里把包名加入 `dsh.profile.bundles`（`dsh plugin add` 通常会自动处理），重启 DSH 即可在侧栏看到 **HAMS** 入口。

手动安装等价于：

```jsonc
{
  "dependencies": { "dsh-hams": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["dsh-hams"] } }
}
```

首次启动会在 `$DSH_HOME/hams` 建库、自动备份并迁移到当前 schema；本机操作者、默认 bot、起步模板都会自动补齐，不需要手工初始化。

## 配置

在 profile 的 bundle 配置或 DSH 配置中覆盖（全部可省略）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/hams` | 数据目录（SQLite、备份、知识文档、bot 工作区） |
| `tickMs` | `5000` | 后台 tick 周期 |
| `localPrincipalId` | 自动 | 本机操作者 member id；空 = 读 `hams_user(local_host)` |
| `toolsEnabled` | `true` | 是否向宿主注册 bot 工具 |
| `botRuntime` | `true` | 是否接宿主 agent 会话（单聊/群聊/工作项派发） |
| `tickEnabled` | `true` | 是否启动后台调度 |
| `backupKeep` | `3` | 升级前备份保留份数 |
| `hostSession` | `auto` | 浏览器会话校验：`auto` / `require` / `off` |
| `knowledgeSkillDirs` | `[$DSH_HOME/skills]` | 知识屏扫描的技能目录 |
| `workspaceProfileFile` | `$DSH_HOME/hams/workspace-profile.json` | 可选的工作区画像 JSON |
| `workspaceRoot` | 画像内的 `workspaceRoot` | 画像里相对路径的根 |

### 可选：工作区画像

把一个 JSON 文件放到 `$DSH_HOME/hams/workspace-profile.json`，首次启动时会把其中的成员、项目、工作项、文档一次性导入（只补缺失，不覆盖已有内容）。格式见 [docs/workspace-profile.example.json](https://github.com/tianweichao/dsh-hams/blob/main/docs/workspace-profile.example.json)。

## 开发

```bash
npm test           # Node 自测（store + service）
npm run test:py    # SQLite 库级不变量
npm run schema:check
```

自测不访问真实 `$DSH_HOME`：存储与服务测试都跑在临时目录里，结束即释放。需要启动宿主做端到端验证时，也请使用独立的 `DSH_HOME` 和临时工作目录。

### 目录

```
src/index.js                 Cordis 插件入口
src/host/dsh-adapter.ts      宿主适配：HTTP 路由、工具注册、启动编排
src/store/                   迁移、单写者锁、备份、启动
src/domain/                  纯逻辑（错误码、判据、复查节奏）
src/service/                 领域命令、读模型、对话、记忆、调度
src/http/                    POST /hams/api/v1/<domain>/<command>
client/index.js              客户端模块（宿主提供 React，无需打包器）
tests/                       Node / Python 自测
scripts/                     schema 生成、初始化、备份
docs/schema-2026-11-14.sql   权威 DDL（迁移由它生成）
```

### 数据安全

- 所有业务数据在 `$DSH_HOME/hams`；升级前自动做可校验备份，默认保留 3 份。
- 证据与审计只追加，不提供物理删除；项目「删除」是软删，工作项解绑保留。
- bot 工具没有审批、决定、直接关单和任意 SQL；审批只能由人在界面完成。
- 本机同 OS 账户的管理员仍可直接改库，这是单机部署的诚实边界。

## 许可证

[MIT](LICENSE)
