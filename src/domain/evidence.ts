/**
 * 证据集与关单判据。
 *
 * 两条规则来自 backend-design §4.6 / §6：
 * 1. `evidence_set_hash` 只覆盖 `status='active'` 的证据，按 id 固定排序拼接后取 sha256；
 *    id 是 ULID，所以「固定顺序」= 追加顺序，任何人重算都能得到同一个值。
 * 2. 关单需要的证据种类与最低条数写在 `work_template_version.required_evidence_json`，
 *    形如 `[{kind:'reading',min_count:2,max_age_hours:24}]`。缺一项就是 EVIDENCE_INCOMPLETE，
 *    不靠人肉记忆。
 *
 * 已知缺口（记在 progress §9）：证据行没有数值字段，所以「连续两次读数 ≥ 80%」这类
 * 数值判据目前只能靠具名验证器从 `ref` 指向的外部内容里读，或改用 metric_observation。
 * 本文件只做「种类 / 条数 / 时效」这层可判定的部分，并在 requestClosure 里对未注册的
 * 验证器**失败关闭**（HOST_CAPABILITY_MISSING），不假装已经校验过。
 */
import { createHash } from 'node:crypto'

export interface EvidenceSnapshotRow {
  id: string
  kind: string
  contentHash: string
  observedAt: number
  status: string
}

export interface EvidenceRequirement {
  kind: string
  minCount: number
  maxAgeHours: number | null
}

export interface RequirementMissing {
  kind: string
  need: number
  have: number
  reason: 'count' | 'stale'
}

export interface RequirementCheck {
  satisfied: boolean
  missing: RequirementMissing[]
  used: number
  totalActive: number
}

export function evidenceSetHash(rows: EvidenceSnapshotRow[]): string {
  const active = rows
    .filter((row) => row.status === 'active')
    .map((row) => `${row.id}:${row.kind}:${row.contentHash}:${row.observedAt}`)
    .sort()
  return createHash('sha256').update(active.join('\n')).digest('hex')
}

function toRequirement(raw: unknown): EvidenceRequirement | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
  if (!kind) return null
  const minCountRaw = item.min_count ?? item.minCount ?? 1
  const maxAgeRaw = item.max_age_hours ?? item.maxAgeHours ?? null
  const minCount = Number(minCountRaw)
  const maxAgeHours = maxAgeRaw === null || maxAgeRaw === undefined ? null : Number(maxAgeRaw)
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw new Error(`required_evidence 的 min_count 必须是 ≥1 的整数：${JSON.stringify(raw)}`)
  }
  if (maxAgeHours !== null && (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)) {
    throw new Error(`required_evidence 的 max_age_hours 必须是正数：${JSON.stringify(raw)}`)
  }
  return { kind, minCount, maxAgeHours }
}

export function parseEvidenceRequirements(json: string | null | undefined): EvidenceRequirement[] {
  if (!json || !json.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`required_evidence_json 不是合法 JSON：${json}`)
  }
  if (!Array.isArray(parsed)) throw new Error('required_evidence_json 必须是数组')
  return parsed.map(toRequirement).filter((item): item is EvidenceRequirement => item !== null)
}

export function evaluateRequirements(
  rows: EvidenceSnapshotRow[],
  requirements: EvidenceRequirement[],
  nowMs: number,
): RequirementCheck {
  const active = rows.filter((row) => row.status === 'active')
  const missing: RequirementMissing[] = []
  let used = 0

  for (const requirement of requirements) {
    const ofKind = active.filter((row) => row.kind === requirement.kind)
    const fresh =
      requirement.maxAgeHours === null
        ? ofKind
        : ofKind.filter((row) => nowMs - row.observedAt <= requirement.maxAgeHours! * 3_600_000)
    if (fresh.length >= requirement.minCount) {
      used += requirement.minCount
      continue
    }
    missing.push({
      kind: requirement.kind,
      need: requirement.minCount,
      have: fresh.length,
      reason: fresh.length < ofKind.length ? 'stale' : 'count',
    })
  }

  return { satisfied: missing.length === 0, missing, used, totalActive: active.length }
}

/** 判据快照：写进 approval.criteria_json，让「批的是哪一版规则」可回看。 */
export interface CriteriaSnapshot {
  templateVersionId: string | null
  requirements: EvidenceRequirement[]
  result: RequirementCheck
  evidenceSetHash: string
}

export function buildCriteriaSnapshot(
  templateVersionId: string | null,
  requirements: EvidenceRequirement[],
  rows: EvidenceSnapshotRow[],
  nowMs: number,
): CriteriaSnapshot {
  return {
    templateVersionId,
    requirements,
    result: evaluateRequirements(rows, requirements, nowMs),
    evidenceSetHash: evidenceSetHash(rows),
  }
}
