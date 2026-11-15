import test from 'node:test'
import assert from 'node:assert/strict'
import { bootstrapStore } from '../../src/store/bootstrap.ts'
import { HamsService } from '../../src/service/hams.ts'
import { createSandbox, sandboxPath } from '../store/helpers.ts'
import { AT, IDS, alertInput, seedTestData } from './fixtures.ts'

test('t01 插件启动路径：bootstrap 出来的库可以直接跑闭环', () => {
  const root = createSandbox(test)
  const runtime = bootstrapStore({ dataDir: sandboxPath(root, 'hams'), now: () => AT })
  try {
    assert.equal(runtime.report.runtimeEpoch, 1)
    seedTestData(runtime.db)

    const clock = { now: AT }
    const service = new HamsService({ db: runtime.db, now: () => clock.now })
    const ingested = service.ingestAlert({ principalId: 'system', channel: 'system', correlationId: 'c1' }, alertInput())
    const workItemId = ingested.objectId as string
    const claimed = service.claim(
      { principalId: IDS.bot, channel: 'tool', correlationId: 'c2' },
      { workItemId, sessionId: 'sess-boot-1' },
    )
    const runId = String(claimed.detail?.runId)
    const run = runtime.db.prepare('SELECT runtime_epoch, status FROM task_run WHERE id = ?').get(runId) as {
      runtime_epoch: number
      status: string
    }
    assert.equal(run.runtime_epoch, 1, '运行应当带上 bootstrap 写入的启动代次')
    assert.equal(run.status, 'queued')

    service.startRun({ principalId: IDS.bot, channel: 'tool', correlationId: 'c3' }, { runId })
    service.appendEvidence(
      { principalId: IDS.bot, channel: 'tool', correlationId: 'c4' },
      { workItemId, kind: 'reading', ref: 'r1', observedAt: AT, runId },
    )
    service.appendEvidence(
      { principalId: IDS.bot, channel: 'tool', correlationId: 'c5' },
      { workItemId, kind: 'reading', ref: 'r2', observedAt: AT, runId },
    )
    service.appendEvidence(
      { principalId: IDS.bot, channel: 'tool', correlationId: 'c6' },
      { workItemId, kind: 'photo', ref: 'p1', observedAt: AT, runId },
    )
    const submitted = service.submitResult(
      { principalId: IDS.bot, channel: 'tool', correlationId: 'c7' },
      { runId, summary: '完成' },
    )
    assert.ok(submitted.detail?.checkId)
    const item = service.getWorkItem({ principalId: IDS.owner, channel: 'ui', correlationId: 'c8' }, workItemId)
    assert.equal(item.status, 'waiting_check')
    assert.equal(runtime.report.meta.schema_version, '9')
  } finally {
    runtime.close()
  }
})
