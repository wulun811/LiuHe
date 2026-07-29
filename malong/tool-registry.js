// 六合工具集 — 工具注册中心
// 自动发现 tools/*/manifest.json，动态加载 handler
// 详见：PROTOCOL.md §工具注册协议

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
    let success = true
    let errorCode = ''
    try {
      const result = await tool.handler(args, context)
      if (result?.error) { success = false; errorCode = result.error_code || result.error || '' }
      return result
    } catch (e) {
      success = false
      errorCode = e.message?.slice(0, 80) || 'unknown'
      throw e
    } finally {
      try {
        if (!this._usagePath) this._usagePath = getUsagePath()
        const entry = {
          ts: new Date().toISOString(),
          tool: name,
          success,
          error_code: errorCode,
          duration_ms: Date.now() - t0,
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
