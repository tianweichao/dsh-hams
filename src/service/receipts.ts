/**
 * 写命令幂等：`command_receipt`。
 *
 * 与 `outbox` 分开（backend-design §4.9）：这里回答「这个请求做过没有」，
 * outbox 回答「这个外部动作发出去了没有」。同键同载荷返回首次回执；同键不同载荷
 * 直接拒绝（IDEMPOTENCY_MISMATCH），绝不「按新载荷再跑一次」。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function receiptScopeKey(principalId: string, action: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${principalId}\u0000${action}\u0000${idempotencyKey}`).digest('hex')
}

export interface StoredReceipt {
  payloadHash: string
  receiptJson: string
}

export function loadReceipt(db: DatabaseSync, scopeKey: string): StoredReceipt | undefined {
  const row = db
    .prepare('SELECT payload_hash, receipt_json FROM command_receipt WHERE scope_key = ?')
    .get(scopeKey) as { payload_hash: string; receipt_json: string } | undefined
  return row ? { payloadHash: row.payload_hash, receiptJson: row.receipt_json } : undefined
}

export interface SaveReceiptInput {
  scopeKey: string
  commandId: string
  principalId: string
  action: string
  payloadHash: string
  receiptJson: string
  at: number
}

export function saveReceipt(db: DatabaseSync, input: SaveReceiptInput): void {
  db.prepare(
    `INSERT INTO command_receipt
       (scope_key, command_id, principal_id, action, payload_hash, receipt_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.scopeKey,
    input.commandId,
    input.principalId,
    input.action,
    input.payloadHash,
    input.receiptJson,
    input.at,
  )
}
