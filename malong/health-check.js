import { existsSync, readdirSync, readFileSync, writeFileSync, accessSync, constants, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_VERSION = 1

export function readUsageStats() {
  const usagePath = join(homedir(), '.config', 'opencode', 'malong-usage.jsonl')
  if (!existsSync(usagePath)) return null
  try {
    const lines = readFileSync(usagePath, 'utf-8').trim().split('\n').filter(Boolean)
    const byTool = {}
    let totalCalls = 0, totalOk = 0, totalDuration = 0
    const value = { tokens_saved: 0, tokens_served: 0, reads_saved: 0, searches_saved: 0, issues_caught: 0, collisions_detected: 0, rollbacks: 0, edits_automated: 0, tests_verified: 0 }
    let firstTs = null, lastTs = null
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        totalCalls++
        if (r.success) totalOk++
        totalDuration += r.duration_ms || 0
        if (!firstTs) firstTs = r.ts
        lastTs = r.ts
        if (!byTool[r.tool]) byTool[r.tool] = { calls: 0, ok: 0, fail: 0, total_ms: 0 }
        const t = byTool[r.tool]
        t.calls++
        if (r.success) t.ok++; else t.fail++
        t.total_ms += r.duration_ms || 0
        if (r.metrics) {
          for (const [k, v] of Object.entries(r.metrics)) {
            if (k in value) value[k] += v
          }
        }
      } catch {}
    }
    for (const t of Object.values(byTool)) {
      t.avg_ms = Math.round(t.total_ms / t.calls)
      delete t.total_ms
    }
    return {
      total_calls: totalCalls,
      success_rate: Math.round(totalOk / totalCalls * 100) / 100,
      total_duration_ms: totalDuration,
      period: firstTs && lastTs ? `${firstTs.slice(0, 10)} ~ ${lastTs.slice(0, 10)}` : null,
      value,
      by_tool: byTool,
    }
  } catch { return null }
}

export async function runHealthCheck({ stateDir, toolsDir, workspacesDir, registry, log }) {
  const checks = []
  let ok = true

  function add(name, status, detail) {
    checks.push({ name, status, detail })
    if (status === 'FAIL') ok = false
  }

  try {
    accessSync(stateDir, constants.W_OK)
    add('stateDir writable', 'PASS', stateDir)
  } catch {
    add('stateDir writable', 'FAIL', `${stateDir} is not writable`)
  }

  if (existsSync(workspacesDir)) {
    try {
      const entries = readdirSync(workspacesDir, { withFileTypes: true })
      let dbCount = 0
      let badCount = 0
      let totalSizeMB = 0
      const databases = []
      let Database
      try { Database = (await import('better-sqlite3')).default } catch {}
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const dbPath = join(workspacesDir, e.name, 'code-index.db')
        if (existsSync(dbPath)) {
          dbCount++
          let sizeMB = 0, lastAccess = null
          try {
            const st = statSync(dbPath)
            sizeMB = Math.round(st.size / 1024 / 1024 * 10) / 10
            totalSizeMB += sizeMB
            const ageMs = Date.now() - st.mtimeMs
            lastAccess = ageMs < 3600000 ? `${Math.round(ageMs / 60000)}min ago`
              : ageMs < 86400000 ? `${Math.round(ageMs / 3600000)}h ago`
              : `${Math.round(ageMs / 86400000)}d ago`
          } catch {}
          databases.push({ workspace: e.name, size_mb: sizeMB, last_access: lastAccess })
          if (Database) {
            try {
              const db = new Database(dbPath)
              const r = db.pragma('integrity_check')
              const integrityOk = Array.isArray(r) && r.length === 1 && r[0]?.integrity_check === 'ok'
              db.close()
              if (!integrityOk) badCount++
            } catch { badCount++ }
          }
        }
      }
      if (Database) {
        add('DB integrity', badCount === 0 ? 'PASS' : 'WARN', `${dbCount} workspace(s), ${badCount} corrupted, total ${Math.round(totalSizeMB)}MB`)
      } else {
        add('DB integrity', 'PASS', `${dbCount} workspace(s), total ${Math.round(totalSizeMB)}MB — sqlite3 not available for integrity check`)
      }
      if (databases.length > 0) {
        checks.push({ name: 'Workspace databases', status: 'INFO', detail: `${databases.length} database(s)`, databases })
      }
    } catch (e) {
      add('DB integrity', 'WARN', `cannot scan: ${e.message}`)
    }
  } else {
    add('DB integrity', 'PASS', 'no workspaces yet')
  }

  if (existsSync(toolsDir)) {
    const entries = readdirSync(toolsDir, { withFileTypes: true })
    let total = 0
    let bad = 0
    const badNames = []
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('tool-')) continue
      total++
      const mf = join(toolsDir, e.name, 'manifest.json')
      if (!existsSync(mf)) { bad++; badNames.push(`${e.name}/manifest.json`); continue }
      try {
        const m = JSON.parse(readFileSync(mf, 'utf-8'))
        if (!m.name || !m.handler) { bad++; badNames.push(`${e.name}/bad manifest`); continue }
        const hp = join(toolsDir, e.name, m.handler)
        if (!existsSync(hp)) { bad++; badNames.push(`${e.name}/handler missing`); continue }
      } catch { bad++; badNames.push(`${e.name}/invalid JSON`) }
    }
    add('Tool manifests', bad === 0 ? 'PASS' : 'WARN', `${total} tools, ${bad} issues: ${badNames.join(', ')}`)
  } else {
    add('Tool manifests', 'FAIL', `tools dir not found: ${toolsDir}`)
  }

  const schemaPath = join(stateDir, 'schema-version')
  if (existsSync(schemaPath)) {
    try {
      const stored = parseInt(readFileSync(schemaPath, 'utf-8').trim())
      if (stored === SCHEMA_VERSION) {
        add('Schema version', 'PASS', `v${stored}`)
      } else {
        add('Schema version', 'WARN', `stored v${stored}, expected v${SCHEMA_VERSION}`)
      }
    } catch {
      add('Schema version', 'WARN', 'cannot read schema-version file')
    }
  } else {
    try {
      writeFileSync(schemaPath, String(SCHEMA_VERSION))
      add('Schema version', 'PASS', `initialized v${SCHEMA_VERSION}`)
    } catch {
      add('Schema version', 'WARN', 'cannot write schema-version file')
    }
  }

  const sockPath = join(stateDir, '..', 'code-index.sock')
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); add('Stale socket', 'CLEANED', sockPath) }
    catch (e) { add('Stale socket', 'WARN', `cannot remove: ${e.message}`) }
  } else {
    add('Stale socket', 'PASS')
  }

  if (registry) {
    const count = registry.getToolCount()
    add('Tool registry', count > 0 ? 'PASS' : 'WARN', `${count} tools loaded`)
  }

  return { status: ok ? 'ok' : 'warn', checks, timestamp: Date.now() }
}