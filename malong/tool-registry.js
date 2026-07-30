// 六合工具集 — 工具注册中心
// 自动发现 tools/*/manifest.json，动态加载 handler
// 详见：PROTOCOL.md §工具注册协议

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

function extractMetrics(name, result) {
  if (!result || result.error) return undefined
  const m = {}
  switch (name) {
    case 'read_outline':
      if (result.lines && result.tokens_estimate) m.tokens_saved = Math.max(0, result.lines * 12 - result.tokens_estimate)
      break
    case 'repo_map':
      if (result.tokens) m.tokens_served = result.tokens
      break
    case 'impact_analysis':
      if (result.caller_count) m.reads_saved = (result.caller_count.direct || 0) + (result.caller_count.indirect || 0)
      break
    case 'call_chain':
      m.reads_saved = (result.callers?.length || 0) + (result.callees?.length || 0)
      break
    case 'trace_symbol':
      m.searches_saved = result.direct_references?.length || 0
      break
    case 'fix_imports':
      m.issues_caught = result.issues?.length || 0
      break
    case 'guard_patterns':
      m.issues_caught = result.violations?.length || 0
      break
    case 'naming_consistency':
      m.issues_caught = result.issues?.length || 0
      break
    case 'dependency_gatekeeper':
      m.issues_caught = result.issues?.length || 0
      break
    case 'edit_collision_guard':
      if (result.status === 'modified_since_read') m.collisions_detected = 1
      break
    case 'edit_transaction':
      if (result.status === 'rolled_back') m.rollbacks = 1
      break
    case 'inspect':
      m.reads_saved = 2
      break
    case 'rename_symbol':
      if (result.total_edits) m.edits_automated = result.total_edits
      break
    case 'find_tests':
      m.searches_saved = (result.by_convention?.length || 0) + (result.by_import?.length || 0)
      break
    case 'active_todos':
      m.issues_caught = result.total_todos || 0
      break
    case 'exception_guard':
      m.issues_caught = result.summary?.issues_found || 0
      break
    case 'config_drift':
      m.issues_caught = result.summary?.drifts_found || 0
      break
    case 'sweep_dead_code':
      m.issues_caught = (result.summary?.unused_imports || 0) + (result.summary?.unused_functions || 0) + (result.summary?.orphan_files || 0)
      break
    case 'sandbox_validate':
      if (!result.valid) m.issues_caught = result.summary?.errors || 0
      break
    case 'mock_sync':
      m.issues_caught = result.summary?.mismatches_found || 0
      break
    case 'test_bridge':
      if (result.action === 'run' && result.summary) m.tests_verified = result.summary.total || 0
      break
  }
  return Object.keys(m).length > 0 ? m : undefined
}

function getUsagePath() {
  const dir = join(homedir(), '.config', 'opencode')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'malong-usage.jsonl')
}

class ToolRegistry {
  constructor(toolsDir, options = {}) {
    this.toolsDir = toolsDir || join(__dirname, 'tools')
    this.tools = new Map()
    this.log = options.log || ((level, msg) => process.stderr.write(`[registry] [${level}] ${msg}\n`))
    this._usagePath = null
  }

  async loadAll() {
    if (!existsSync(this.toolsDir)) {
      this.log('warn', `tools directory not found: ${this.toolsDir}`)
      return
    }

    const entries = readdirSync(this.toolsDir, { withFileTypes: true })
    let loaded = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('tool-')) continue

      const toolDir = join(this.toolsDir, entry.name)
      const manifestPath = join(toolDir, 'manifest.json')

      if (!existsSync(manifestPath)) {
        this.log('warn', `${entry.name}/ missing manifest.json, skipping`)
        continue
      }

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

        if (!manifest.name) {
          this.log('error', `${entry.name}/manifest.json missing 'name' field`)
          continue
        }
        if (!manifest.handler) {
          this.log('error', `${entry.name}/manifest.json missing 'handler' field`)
          continue
        }

        const handlerPath = join(toolDir, manifest.handler)
        if (!existsSync(handlerPath)) {
          this.log('error', `${entry.name}/ handler not found: ${manifest.handler}`)
          continue
        }

        const handlerModule = await import(pathToFileURL(handlerPath).href)
        if (typeof handlerModule.handle !== 'function') {
          this.log('error', `${entry.name}/ handler.js must export 'handle' function`)
          continue
        }

        if (this.tools.has(manifest.name)) {
          this.log('warn', `duplicate tool name: ${manifest.name}, overwriting`)
        }

        this.tools.set(manifest.name, {
          manifest,
          handler: handlerModule.handle,
          dir: toolDir,
        })
        loaded++
        this.log('info', `loaded: ${manifest.name} (${entry.name})`)
      } catch (e) {
        this.log('error', `failed to load ${entry.name}: ${e.message}`)
      }
    }

    this.log('info', `registry loaded: ${loaded} tools from ${this.toolsDir}`)
    return loaded
  }

  listTools() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.manifest.name,
      description: t.manifest.description,
      inputSchema: t.manifest.inputSchema,
    }))
  }

  getTool(name) {
    return this.tools.get(name) || null
  }

  hasTool(name) {
    return this.tools.has(name)
  }

  async callTool(name, args, context) {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Tool not found: ${name}`)
    }
    const t0 = Date.now()
    let status = 'ok'
    let errorCode = ''
    let result
    try {
      result = await tool.handler(args, context)
      if (result?.error) { status = 'error'; errorCode = result.error_code || result.error || '' }
      return result
    } catch (e) {
      status = 'crash'
      errorCode = e.message?.slice(0, 80) || 'unknown'
      throw e
    } finally {
      try {
        if (!this._usagePath) this._usagePath = getUsagePath()
        const entry = {
          ts: new Date().toISOString(),
          tool: name,
          success: status !== 'crash',
          status,
          error_code: errorCode,
          duration_ms: Date.now() - t0,
        }
        if (status === 'ok') {
          const metrics = extractMetrics(name, result)
          if (metrics) entry.metrics = metrics
        }
        appendFileSync(this._usagePath, JSON.stringify(entry) + '\n')
      } catch {}
    }
  }

  getToolNames() {
    return Array.from(this.tools.keys())
  }

  getToolCount() {
    return this.tools.size
  }
}

export default ToolRegistry
