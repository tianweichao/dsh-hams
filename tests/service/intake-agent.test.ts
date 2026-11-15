/**
 * 任务识别器：独立模型调用、最低推理、严格 JSON；失败不猜。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseIntakeModel, classifyWorkRequest, leastEffort, type LlmLike } from '../../src/host/intake-agent.ts'

function fakeLlm(reply: string, efforts = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }]) {
  const calls: Array<Record<string, unknown>> = []
  const llm: LlmLike = {
    async resolveModelInfo() {
      return { reasoning: { efforts } }
    },
    stream(options) {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish' }
      })()
    },
  }
  return { llm, calls }
}

const INPUT = {
  projectName: '示例项目',
  workItems: [{ id: 'wi-1', title: 'A 股行情调研', status: 'ready', assignee: null }],
  message: '帮我查一下 A 股最新行情',
}

test('n01 create：解析任务标题，选最低推理档（off）', async () => {
  const { llm, calls } = fakeLlm('{"action":"create","title":"A 股最新行情调研","reason":"新任务"}')
  const decision = await classifyWorkRequest({ llm, model: { provider: 'p', model: 'm' }, ...INPUT })
  assert.deepEqual(decision, { action: 'create', title: 'A 股最新行情调研', reason: '新任务' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, 'off')
  assert.equal(calls[0].maxTokens, 300)
})

test('n02 update：从已有工作项里选 id 和状态', async () => {
  const { llm } = fakeLlm('```json\n{"action":"update","workItemId":"wi-1","status":"paused","reason":"暂停"}\n```')
  const decision = await classifyWorkRequest({ llm, model: { provider: 'p', model: 'm' }, ...INPUT })
  assert.deepEqual(decision, { action: 'update', workItemId: 'wi-1', status: 'paused', reason: '暂停' })
})

test('n03 解析失败/流失败都返回 null，不进规则兜底', async () => {
  const bad = await classifyWorkRequest({ llm: fakeLlm('不是 JSON').llm, model: { provider: 'p', model: 'm' }, ...INPUT })
  assert.equal(bad, null)
  const broken: LlmLike = {
    stream() {
      throw new Error('provider down')
    },
  }
  const failed = await classifyWorkRequest({ llm: broken, model: { provider: 'p', model: 'm' }, ...INPUT })
  assert.equal(failed, null)
})

test('n04 模型没有 off/none 时退到最低档', async () => {
  const { llm } = fakeLlm('{"action":"none","reason":"寒暄"}', [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ])
  const decision = await classifyWorkRequest({ llm, model: { provider: 'p', model: 'm' }, ...INPUT })
  assert.equal(decision?.action, 'none')
  assert.equal(await leastEffort({ llm, model: { provider: 'p', model: 'm' }, ...INPUT }), 'low')
})

test('n05 默认模型没有 off 时，自动换到同 provider 里支持 off 的模型', async () => {
  const calls: Array<Record<string, unknown>> = []
  const llm: LlmLike = {
    async listModels() {
      return [{ id: 'fast-no-think' }, { id: 'slow-think' }]
    },
    async resolveModelInfo(_provider, model) {
      return model === 'fast-no-think'
        ? { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }] } }
        : { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
    },
    stream(options) {
      calls.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: '{"action":"none","reason":"闲聊"}' }
      })()
    },
  }
  const chosen = await chooseIntakeModel(llm, { provider: 'prov-n05', model: 'default-think' })
  assert.deepEqual(chosen, { provider: 'prov-n05', model: 'fast-no-think' })
  await classifyWorkRequest({ llm, model: { provider: 'prov-n05', model: 'default-think' }, ...INPUT })
  assert.equal(calls[0].model, 'fast-no-think')
  assert.equal(calls[0].reasoningEffort, 'off')
})
