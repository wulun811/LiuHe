// malong-dsh-bridge — LiuHe DSH adapter plugin (cordis)
// Self-contained minimal MCP stdio client: spawns mcp-server.js → registers malong__* tools →
// auto-injects workspace_dir = current session workspace (exec.agent.session.header.cwd) on
// every call. Explicit workspace_dir from the model is respected; the tool schema marks
// workspace_dir optional (DSH side).
// Structured output: when content is a single text block and valid JSON, it is parsed into
// structuredContent so the model sees the object directly (including the {error:{code,message}}
// envelope) without manual JSON.parse.
// No dependency on dsh-mcp-client; does not modify dsh node_modules; dsh upgrades are safe.
// Note: does NOT import any @deepseek-ai/* package (the plugin ships with LiuHe and may not
// resolve dsh's node_modules); Config is intentionally not exported (cordis passes config
// through untouched when absent).
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { dirname, join } from "node:path"
import { mkdirSync } from "node:fs"
import os from "node:os"

export const name = "malong-dsh-bridge"

export const inject = ["tools"]

const SERVER_NAME = "malong"

function publicToolName(rawName) {
  return `${SERVER_NAME}__${rawName}`
}

/** Output shape required by dsh tool registration (equivalent to dsh-mcp-client's createOutput, with a native text projection). */
function createOutput(rawName) {
  return {
    schema: {
      type: "object",
      properties: {
        content: { type: "array", items: {} },
        structuredContent: {},
      },
      required: ["content"],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: "text", text: extractText(value.content, rawName) }]
    },
  }
}

function extractText(content, rawName) {
  const parts = []
  for (const value of content) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      parts.push("[unsupported content type: unknown]")
      continue
    }
    switch (value.type) {
      case "text":
        if (value.text !== void 0) parts.push(value.text)
        break
      case "image":
        parts.push(`[image: ${value.mimeType ?? "unknown"}, content discarded]`)
        break
      case "audio":
        parts.push(`[audio: ${value.mimeType ?? "unknown"}, content discarded]`)
        break
      case "resource":
        parts.push(`[resource: ${value.resource?.uri ?? "unknown"}, content discarded]`)
        break
      default:
        parts.push("[unsupported content type]")
    }
  }
  return parts.join("\n")
}

async function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {}
  const serverPath = cfg.serverPath
  if (typeof serverPath !== "string" || serverPath.length === 0) {
    throw new Error("malong-dsh-bridge: missing config.serverPath (absolute path to mcp-server.js)")
  }
  const stateDir = typeof cfg.stateDir === "string" && cfg.stateDir !== "" ? cfg.stateDir : join(os.homedir(), ".local", "state", "malong-dsh")
  const timeoutMs = typeof cfg.toolCallTimeoutMs === "number" && cfg.toolCallTimeoutMs > 0 ? cfg.toolCallTimeoutMs : 300000
  const logger = (msg) => process.stderr.write(`[malong-dsh-bridge] ${msg}\n`)

  mkdirSync(stateDir, { recursive: true })
  const child = spawn(process.execPath, [serverPath, "--workspace", stateDir], {
    cwd: dirname(serverPath),
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) logger(`server: ${line.trim()}`)
    }
  })

  const pending = new Map()
  let seq = 0
  const rl = createInterface({ input: child.stdout })
  rl.on("line", (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === void 0) return
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message ?? "mcp error"))
    else waiter.resolve(msg.result)
  })

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = String(++seq)
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`mcp ${method} timeout after ${timeoutMs}ms`))
      }
    }, timeoutMs)
  })

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "malong-dsh-bridge", version: "0.4.5.post1" },
  })
  logger(`initialized protocol=${init?.protocolVersion}`)

  const listed = await request("tools/list", {})
  const tools = Array.isArray(listed?.tools) ? listed.tools : []
  logger(`tools/list: ${tools.length} tools`)

  let registered = 0
  for (const tool of tools) {
    const rawName = tool.name
    let parameters = tool.inputSchema
    if (parameters && typeof parameters === "object" && parameters.properties?.workspace_dir) {
      parameters = JSON.parse(JSON.stringify(parameters))
      const prop = parameters.properties.workspace_dir
      prop.description = `${prop.description ?? ""} (DSH bridge: optional; omitted when the current session workspace is used automatically)`
      const required = Array.isArray(parameters.required) ? parameters.required.filter((k) => k !== "workspace_dir") : parameters.required
      if (Array.isArray(required) && required.length === 0) delete parameters.required
      else if (Array.isArray(required)) parameters.required = required
    }
    const execute = async (args, exec) => {
      const rawArgs = typeof args === "object" && args !== null ? { ...args } : {}
      const missing = rawArgs.workspace_dir === void 0 || rawArgs.workspace_dir === ""
      const sessionCwd = exec?.agent?.session?.header?.cwd
      if (missing && typeof sessionCwd === "string" && sessionCwd.length > 0) {
        rawArgs.workspace_dir = sessionCwd
      }
      const result = await request("tools/call", { name: rawName, arguments: rawArgs })
      if (!Array.isArray(result?.content)) {
        const rendered = result && "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)"
        const text = typeof rendered === "string" ? rendered : "(no output)"
        if (result?.isError === true) throw new Error(text)
        return { content: [{ type: "text", text }] }
      }
      const text = extractText(result.content, rawName)
      if (result?.isError === true) throw new Error(text)
      const singleText = Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === "text"
      let structuredContent
      if (singleText && typeof result.content[0].text === "string") {
        try {
          const parsed = JSON.parse(result.content[0].text)
          if (parsed !== null && (typeof parsed === "object" || typeof parsed === "number" || typeof parsed === "boolean")) {
            structuredContent = parsed
          }
        } catch {
          structuredContent = void 0
        }
      }
      return {
        content: result.content,
        ...structuredContent !== void 0 ? { structuredContent } : {},
        ...structuredContent === void 0 && result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {},
      }
    }
    ctx.tools.register({
      name: publicToolName(rawName),
      description: tool.description ?? "",
      parameters,
      output: createOutput(rawName),
      execute,
    })
    registered++
  }
  logger(`registered ${registered} tools (serverName=${SERVER_NAME}, stateDir=${stateDir})`)

  ctx.on("dispose", () => {
    child.kill()
  })
}

export { apply }
