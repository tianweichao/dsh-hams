/**
 * 测试沙箱：所有临时目录都由本文件创建并登记，清理只删登记过的根目录。
 *
 * 这一条是硬约束（~/AGENTS.md 数据安全）：测试绝不能碰真实 $DSH_HOME，
 * 也不能对「看起来像临时目录」的路径做递归删除。没登记过的路径一律拒绝删除。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const SANDBOX_PREFIX = 'hams-test-'
const registered = new Set<string>()

export function createSandbox(t: { after: (fn: () => void) => void }): string {
  const root = path.resolve(mkdtempSync(path.join(tmpdir(), SANDBOX_PREFIX)))
  registered.add(root)
  t.after(() => {
    assert.ok(registered.has(root), `拒绝删除未登记的目录：${root}`)
    assert.ok(isInsideSandbox(root), `拒绝删除沙箱之外的目录：${root}`)
    rmSync(root, { recursive: true, force: true })
    registered.delete(root)
  })
  return root
}

export function isInsideSandbox(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of registered) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return true
  }
  return false
}

export function sandboxPath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments)
  assert.ok(isInsideSandbox(resolved), `路径逃出沙箱：${resolved}`)
  return resolved
}
