// 六合工具集 — 工具注册中心
// 自动发现 tools/*/manifest.json，动态加载 handler
// 详见：PROTOCOL.md §工具注册协议

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

class ToolRegistry {
  constructor(toolsDir, options = {}) {
    this.toolsDir = toolsDir || join(__dirname, 'tools')
    this.tools = new Map()  // name -> { manifest, handler, dir }
    this.log = options.log || ((level, msg) => process.stderr.write(`[registry] [${level}] ${msg}\n`))
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
    return await tool.handler(args, context)
  }

  getToolNames() {
    return Array.from(this.tools.keys())
  }

  getToolCount() {
    return this.tools.size
  }
}

export default ToolRegistry
