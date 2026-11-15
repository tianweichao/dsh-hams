/**
 * hams-bot preset 的纯函数：工具组合与官方 standard 对齐，人设按成员版本生成。
 *
 * 这里不启动宿主：只校验「注册的定义」里确实带着 bash / 文件 / subagent / 联网，
 * 以及提示词进 persona、花括号不会触发模板解析。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HAMS_BOT_PRESET,
  botPresetId,
  hamsBotPresetDefinition,
  hamsPersonaPrefix,
} from '../../src/host/bot-preset.ts'

function flattenPlugins(plugins: readonly any[]): any[] {
  return plugins.flatMap((row) => (Array.isArray(row.config) ? [row, ...row.config] : [row]))
}

test('b01 hams-bot 带齐 standard 级工具：bash / 文件读写 / 搜索 / subagent / workflow / 联网 / 技能 / 交付卡片', () => {
  const definition = hamsBotPresetDefinition()
  assert.equal(definition.id, HAMS_BOT_PRESET)
  const names = flattenPlugins(definition.plugins).map((row) => row.name)
  for (const expected of [
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-workflow-ptc',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-present',
    '@deepseek-ai/dsh-persona',
  ]) {
    assert.ok(names.includes(expected), `preset 应包含 ${expected}，实际：${names.join(', ')}`)
  }
  // 与 standard 的差异只应有：Windows 专属 pwsh、宿主 profile 专属插件管理/市场。
  for (const absent of ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools']) {
    assert.ok(!names.includes(absent), `preset 不应包含 ${absent}`)
  }
})

test('b02 提示词进入 persona；改版本或改提示词都会生成新 preset id', () => {
  const withPrompt = hamsBotPresetDefinition({ id: 'x', memberName: '告警复查', prompt: '只做告警复查，先看证据。' })
  const persona = withPrompt.plugins[0] as any
  assert.match(String(persona.config.prefix), /只做告警复查，先看证据。/)
  assert.match(String(persona.config.prefix), /HAMS/, '基础规则仍在')

  const a = botPresetId('b_alert', 2, '第一版')
  const b = botPresetId('b_alert', 2, '第二版')
  const c = botPresetId('b_alert', 3, '第一版')
  assert.notEqual(a, b, '提示词变了要换 preset')
  assert.notEqual(a, c, '版本变了要换 preset')
  assert.match(a, /^hams-bot-b_alert-v2-[0-9a-f]{8}$/)
})

test('b03 用户文本里的 {{…}} 不能当提示词变量解析', () => {
  const prefix = hamsPersonaPrefix('按 {{projectName}} 的口径做，输出 {{x}}')
  assert.ok(!/\{\{[^}]*\}\}/.test(prefix), '双花括号要被转义掉')
  assert.match(prefix, /\{ \{projectName\} \}/)
})
