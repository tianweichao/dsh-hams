/**
 * 项目交付物：把项目推进过程中 bot 工作区里生成的文件归集出来看。
 *
 * 两类来源（与会话适配器的工作目录约定一致）：
 * - 工作项：`<dataDir>/bots/<memberId>/work/<workItemId>/…`（只认本项目的工作项）；
 * - 项目群聊：`<dataDir>/bots/<memberId>/chats/chat-project-<projectId>/…` 与
 *   `chats/chat-group-<projectId>-<memberId>/…`（推进 bot 与群成员在群里写下的东西）。
 * 只读扫描；预览只读文本且限制大小，绝不返回二进制内容。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HamsError } from '../domain/errors.ts'

export interface DeliverableItem {
  /** 相对 dataDir 的路径，作为稳定 id，也用于预览时再次校验。 */
  relPath: string
  projectId: string
  workItemId: string
  workItemTitle: string
  workItemStatus: string
  memberId: string
  memberName: string
  /** work = 工作项产物；chat = 项目群聊产物。 */
  source: 'work' | 'chat'
  /** 工作项标题或「项目群聊」。 */
  label: string
  name: string
  size: number
  mtime: number
}

export interface DeliverableList {
  items: DeliverableItem[]
  truncated: boolean
  /** 扫描过的项目工作项数，便于界面解释「为什么是空的」。 */
  workItems: number
}

export interface DeliverableFile {
  relPath: string
  name: string
  size: number
  mtime: number
  binary: boolean
  truncated: boolean
  content: string
}

const MAX_FILES = 500
const MAX_DEPTH = 6
const MAX_PREVIEW_BYTES = 256 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.venv', '__pycache__'])

interface WorkItemRef {
  id: string
  title: string
  status: string
}

function workItemsOfProject(db: DatabaseSync, projectId: string): WorkItemRef[] {
  return db
    .prepare('SELECT id, title, status FROM work_item WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as WorkItemRef[]
}

function memberNames(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT id, name FROM member WHERE kind = 'bot'").all() as { id: string; name: string }[]
  return new Map(rows.map((row) => [row.id, row.name]))
}

function walk(root: string, relRoot: string, onFile: (rel: string, size: number, mtime: number) => void, budget: { left: number }, depth = 0): void {
  if (budget.left <= 0 || depth > MAX_DEPTH) return
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left <= 0) return
    if (entry.isSymbolicLink()) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, `${relRoot}/${entry.name}`, onFile, budget, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    budget.left -= 1
    onFile(`${relRoot}/${entry.name}`, stat.size, stat.mtimeMs)
  }
}

export function listDeliverables(options: { db: DatabaseSync; dataDir: string; projectId: string; limit?: number }): DeliverableList {
  const dataDir = path.resolve(options.dataDir)
  const botsRoot = path.join(dataDir, 'bots')
  const workItems = workItemsOfProject(options.db, options.projectId)
  if (!existsSync(botsRoot)) return { items: [], truncated: false, workItems: workItems.length }
  const names = memberNames(options.db)
  const budget = { left: Math.min(Math.max(options.limit ?? MAX_FILES, 1), MAX_FILES) }
  const items: DeliverableItem[] = []
  let truncated = false
  for (const memberId of readdirSync(botsRoot)) {
    const memberDir = path.join(botsRoot, memberId)
    let isDir = false
    try {
      isDir = statSync(memberDir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    for (const item of workItems) {
      const workDir = path.join(memberDir, 'work', item.id)
      if (!existsSync(workDir)) continue
      const relBase = `bots/${memberId}/work/${item.id}`
      walk(workDir, relBase, (relPath, size, mtime) => {
        items.push({
          relPath,
          projectId: options.projectId,
          workItemId: item.id,
          workItemTitle: item.title,
          workItemStatus: item.status,
          memberId,
          memberName: names.get(memberId) || memberId,
          source: 'work',
          label: item.title,
          name: path.posix.basename(relPath),
          size,
          mtime: Math.round(mtime),
        })
      }, budget)
      if (budget.left <= 0) {
        truncated = true
        break
      }
    }
    if (truncated) break
    // 项目群聊产物：chats/chat-project-<pid>/ 与 chats/chat-group-<pid>-<memberId>/
    const chatsDir = path.join(memberDir, 'chats')
    if (!existsSync(chatsDir)) continue
    for (const chatEntry of readdirSync(chatsDir)) {
      const isProjectChat = chatEntry === `chat-project-${options.projectId}`
        || chatEntry.startsWith(`chat-group-${options.projectId}-`)
      if (!isProjectChat) continue
      const chatDir = path.join(chatsDir, chatEntry)
      let isDir = false
      try {
        isDir = statSync(chatDir).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      const relBase = `bots/${memberId}/chats/${chatEntry}`
      walk(chatDir, relBase, (relPath, size, mtime) => {
        items.push({
          relPath,
          projectId: options.projectId,
          workItemId: '',
          workItemTitle: '',
          workItemStatus: '',
          memberId,
          memberName: names.get(memberId) || memberId,
          source: 'chat',
          label: '项目群聊',
          name: path.posix.basename(relPath),
          size,
          mtime: Math.round(mtime),
        })
      }, budget)
      if (budget.left <= 0) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  items.sort((a, b) => b.mtime - a.mtime)
  return { items, truncated, workItems: workItems.length }
}

export function readDeliverable(options: {
  db: DatabaseSync
  dataDir: string
  projectId: string
  relPath: string
}): DeliverableFile {
  const dataDir = path.resolve(options.dataDir)
  const botsRoot = path.join(dataDir, 'bots')
  const raw = String(options.relPath || '').trim()
  if (!raw) throw new HamsError('STATE_INVALID', '缺少文件路径')
  if (path.isAbsolute(raw)) throw new HamsError('POLICY_DENIED', '只接受项目工作区内的相对路径')
  const resolved = path.resolve(dataDir, raw)
  const base = botsRoot + path.sep
  if (!resolved.startsWith(base)) throw new HamsError('POLICY_DENIED', '只允许看 bot 工作区里的文件')
  const parts = path.relative(dataDir, resolved).split(path.sep)
  // bots/<memberId>/work/<workItemId>/... 或 bots/<memberId>/chats/<chatKey>/...
  if (parts.length < 5 || parts[0] !== 'bots') {
    throw new HamsError('POLICY_DENIED', '路径不在交付物目录约定内')
  }
  if (parts[2] === 'work') {
    const workItemId = parts[3]
    const owned = options.db
      .prepare('SELECT 1 AS ok FROM work_item WHERE id = ? AND project_id = ?')
      .get(workItemId, options.projectId) as { ok: number } | undefined
    if (!owned) throw new HamsError('POLICY_DENIED', '这个文件不属于当前项目的工作项')
  } else if (parts[2] === 'chats') {
    const chatKey = parts[3]
    const isProjectChat = chatKey === `chat-project-${options.projectId}`
      || chatKey.startsWith(`chat-group-${options.projectId}-`)
    if (!isProjectChat) throw new HamsError('POLICY_DENIED', '这个文件不属于当前项目的群聊工作区')
  } else {
    throw new HamsError('POLICY_DENIED', '路径不在交付物目录约定内')
  }
  let stat
  try {
    stat = statSync(resolved)
  } catch {
    throw new HamsError('STATE_INVALID', '文件不存在或已移走')
  }
  if (!stat.isFile()) throw new HamsError('STATE_INVALID', '不是普通文件')
  const readBytes = Math.min(stat.size, MAX_PREVIEW_BYTES)
  const buffer = readFileSync(resolved).subarray(0, readBytes)
  const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)
  return {
    relPath: path.relative(dataDir, resolved).split(path.sep).join('/'),
    name: path.posix.basename(resolved),
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    binary,
    truncated: stat.size > readBytes,
    content: binary ? '' : buffer.toString('utf8'),
  }
}
