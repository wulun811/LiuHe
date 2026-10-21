// workflow/review.js — S4.2 审查/维护：规则版本、误报台账、发现归一化。
// G4 纪律：零命中不证明安全（证据带 limitation）；动态引用未知不自动删（auto_remove=false）；
//          误报可保留并记理由（ledger，按 fingerprint 抑制）。
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { getStateDir } from '../host-config.js'

// 规则集版本（审查发现携带，便于证据溯源；升级规则时递增）
export const RULESET_VERSION = {
  code_review: 'shape-v2',
  security_review: 'sec-v1',
  exception_guard: 'panic-v1',
  guard_patterns: 'ast-v1',
  dependency_gatekeeper: 'deps-v1',
  config_drift: 'cfg-v1',
  dead_code: 'dead-v1',
  code_quality: 'quality-v1',
}

const LEDGER_ROOT = 'review-ledger'

function wsHash(workspaceDir) {
  // malong-ignore: 仅用于缓存目录名
  return createHash('md5').update(resolve(workspaceDir)).digest('hex').slice(0, 12)
}
export function ledgerPath(workspaceDir) { return join(getStateDir(), LEDGER_ROOT, `${wsHash(workspaceDir)}.jsonl`) }

// 发现指纹：check+file+行+消息（不含 severity，避免升降级导致重复）
export function findingFingerprint(check, f) {
  const basis = [check, f?.file || '', f?.line ?? '', String(f?.message || f?.msg || '').trim()].join('|')
  // malong-ignore: 台账去重指纹，非密码学用途
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

export function readLedger(workspaceDir) {
  const p = ledgerPath(workspaceDir)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

export function acceptedFingerprints(workspaceDir) {
  const s = new Set()
  for (const e of readLedger(workspaceDir)) if (e?.fingerprint) s.add(e.fingerprint)
  return s
}

export function appendLedger(workspaceDir, entry) {
  const p = ledgerPath(workspaceDir)
  const d = join(getStateDir(), LEDGER_ROOT)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  return entry
}

// 归一化各分析器输出 → 统一 finding {check, severity, file, line, message, rule_version, auto_remove?}
const SEV = { high: 'high', error: 'high', warn: 'medium', warning: 'medium', medium: 'medium', info: 'low', low: 'low' }
export function normalizeFinding(check, raw, file, { deadCode = false } = {}) {
  const finding = {
    check,
    severity: SEV[raw?.severity] || (deadCode ? 'info' : 'low'),
    file: raw?.file || file || null,
    line: raw?.line ?? raw?.start_line ?? null,
    message: raw?.message || raw?.msg || raw?.reason || raw?.type || '(no message)',
    rule_version: RULESET_VERSION[check] || null,
  }
  if (deadCode) {
    finding.auto_remove = false
    finding.reason = 'dead-code scan covers graph+text refs; dynamic/reflection wiring is NOT covered — manual confirmation required (G4)'
  }
  return finding
}

// 证据 result：analyzer 跑通且（去误报后）无发现 → passed；有发现 → failed；未跑 → skipped
export function evidenceResult(ran, findingCount) {
  if (!ran) return 'skipped'
  return findingCount > 0 ? 'failed' : 'passed'
}