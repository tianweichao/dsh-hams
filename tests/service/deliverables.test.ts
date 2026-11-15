/**
 * 项目交付物：只扫本项目工作项目录、只认 bot 工作区、文本才预览。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { listDeliverables, readDeliverable } from '../../src/service/deliverables.ts'
import { createHarness, IDS } from './fixtures.ts'

function createItem(h: ReturnType<typeof createHarness>, title: string, projectId?: string): string {
  const receipt = h.service.createWorkItem(h.ctx(IDS.owner), {
    domain: '安全',
    category: '巡检',
    title,
    projectId,
    templateVersionId: IDS.templateVersion,
    ownerHumanId: IDS.owner,
  })
  return String(receipt.objectId)
}

test('d01 只列本项目工作项目录下的文件；文本可读、二进制不返回正文、越权路径拒绝', (t) => {
  const h = createHarness(t)
  const dataDir = path.join(h.root, 'hams-data')
  const itemId = createItem(h, '生成处置报告', IDS.project)
  const outDir = path.join(dataDir, 'bots', IDS.bot, 'work', itemId, 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'report.md'), '# 处置报告\n\n结论：过放已恢复。\n')
  writeFileSync(path.join(outDir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))

  const list = listDeliverables({ db: h.db, dataDir, projectId: IDS.project })
  assert.equal(list.items.length, 2)
  const report = list.items.find((row) => row.name === 'report.md')!
  assert.equal(report.relPath, `bots/${IDS.bot}/work/${itemId}/out/report.md`)
  assert.equal(report.workItemId, itemId)
  assert.equal(report.memberId, IDS.bot)

  const text = readDeliverable({ db: h.db, dataDir, projectId: IDS.project, relPath: report.relPath })
  assert.equal(text.binary, false)
  assert.match(text.content, /处置报告/)
  const png = readDeliverable({
    db: h.db,
    dataDir,
    projectId: IDS.project,
    relPath: `bots/${IDS.bot}/work/${itemId}/out/chart.png`,
  })
  assert.equal(png.binary, true)
  assert.equal(png.content, '')

  // 越权：跳出 bots 目录、指向别的工作项
  assert.throws(() => readDeliverable({ db: h.db, dataDir, projectId: IDS.project, relPath: '../../etc/passwd' }), /POLICY_DENIED|工作区/)
  const foreign = createItem(h, '别的项目之外的活', undefined)
  mkdirSync(path.join(dataDir, 'bots', IDS.bot, 'work', foreign), { recursive: true })
  writeFileSync(path.join(dataDir, 'bots', IDS.bot, 'work', foreign, 'secret.md'), 'secret')
  assert.throws(
    () => readDeliverable({ db: h.db, dataDir, projectId: IDS.project, relPath: `bots/${IDS.bot}/work/${foreign}/secret.md` }),
    /不属于当前项目/,
  )
  const otherList = listDeliverables({ db: h.db, dataDir, projectId: IDS.project })
  assert.equal(otherList.items.some((row) => row.workItemId === foreign), false)
})

test('d03 项目群聊工作区里的文件也算交付物；别的项目的群聊目录不给看', (t) => {
  const h = createHarness(t)
  const dataDir = path.join(h.root, 'hams-data')
  const chatDir = path.join(dataDir, 'bots', IDS.bot, 'chats', `chat-project-${IDS.project}`)
  mkdirSync(chatDir, { recursive: true })
  writeFileSync(path.join(chatDir, 'example.md'), '# 示例\n\n内容')
  const otherChat = path.join(dataDir, 'bots', IDS.bot, 'chats', 'chat-project-other')
  mkdirSync(otherChat, { recursive: true })
  writeFileSync(path.join(otherChat, 'secret.md'), 'secret')

  const list = listDeliverables({ db: h.db, dataDir, projectId: IDS.project })
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].source, 'chat')
  assert.equal(list.items[0].label, '项目群聊')
  const file = readDeliverable({
    db: h.db, dataDir, projectId: IDS.project,
    relPath: `bots/${IDS.bot}/chats/chat-project-${IDS.project}/example.md`,
  })
  assert.match(file.content, /示例/)
  assert.throws(
    () => readDeliverable({ db: h.db, dataDir, projectId: IDS.project, relPath: `bots/${IDS.bot}/chats/chat-project-other/secret.md` }),
    /不属于当前项目的群聊/,
  )
})

test('d02 没有工作项目录时返回空表而不是报错；limit 截断会标记 truncated', (t) => {
  const h = createHarness(t)
  const dataDir = path.join(h.root, 'hams-data')
  assert.deepEqual(listDeliverables({ db: h.db, dataDir, projectId: IDS.project }), { items: [], truncated: false, workItems: 0 })

  const itemId = createItem(h, '批量产物', IDS.project)
  const dir = path.join(dataDir, 'bots', IDS.bot, 'work', itemId)
  mkdirSync(dir, { recursive: true })
  for (let index = 0; index < 5; index += 1) writeFileSync(path.join(dir, `f${index}.txt`), 'x')
  const limited = listDeliverables({ db: h.db, dataDir, projectId: IDS.project, limit: 2 })
  assert.equal(limited.items.length, 2)
  assert.equal(limited.truncated, true)
})
