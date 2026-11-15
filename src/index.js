/**
 * dsh-hams 插件入口（Cordis）。
 *
 * 这一层只做三件事：声明插件名/注入的服务、可选的配置 schema、把上下文交给
 * `registerHams`（宿主适配器）。业务逻辑全在 src/service 与 src/store，入口保持薄。
 *
 * 说明：本文件是纯 JS，避免依赖构建链；它 import 的 `.ts` 模块由宿主 Node 24 的
 * 类型剥离直接执行（本机 Node 24.21 已跑通全量自测）。
 */
import { applyHams } from './host/dsh-adapter.ts'

let z = null
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'))
} catch (error) {
  // 解析不到共享包不能让插件启动失败：配置校验退化为「按默认值」。
  console.error('[hams] 无法导入 @deepseek-ai/schemastery，跳过配置校验：', error?.message ?? error)
}

export const name = 'hams'
export const inject = ['tools', 'webServer']

export const Config = z
  ? z.object({
      /** 数据目录；空 = $DSH_HOME/hams */
      dataDir: z.string().default(''),
      /** tick 周期（毫秒） */
      tickMs: z.number().default(5000),
      /** 本机操作者 member id；空 = 查 hams_user(auth_source='local_host') */
      localPrincipalId: z.string().default(''),
      /** 首次认领时线程尚未建立，用它兜底（P1 单 bot） */
      defaultBotMemberId: z.string().default(''),
      /** 排障用：关掉工具或 tick */
      toolsEnabled: z.boolean().default(true),
      /** bot 运行时：单聊/群聊会话与工作项派发；默认开 */
      botRuntime: z.boolean().default(true),
      tickEnabled: z.boolean().default(true),
      /** 升级前备份保留份数 */
      backupKeep: z.number().default(3),
      /** 浏览器会话校验：auto = 宿主有 connection 就用它；require = 没有就拒绝；off = 只给测试 */
      hostSession: z.union([z.const('auto'), z.const('require'), z.const('off')]).default('auto'),
      /** 知识屏扫描的真实技能目录；空 = $DSH_HOME/skills */
      knowledgeSkillDirs: z.array(z.string()).default([]),
      /** 工作区画像文件；空 = $DSH_HOME/hams/workspace-profile.json */
      workspaceProfileFile: z.string().default(''),
      /** 画像里相对路径的根；空 = 读画像里的 workspaceRoot */
      workspaceRoot: z.string().default(''),
    })
  : undefined

export function apply(ctx, config = {}) {
  return applyHams(ctx, config ?? {})
}
