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
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"

// 0.5.13：版本号不再硬编码（旧实现写死 "0.5.9"，每次发版都忘改 → 日志/握手版本与实际包永久漂移）。
// 优先读包内 package.json（一体包用），否则回退到 server/../package.json，最后兜底 "unknown"。
function bridgeVersion() {
  const pkgUrl = new URL("./package.json", import.meta.url)
  try {
    return JSON.parse(readFileSync(pkgUrl, "utf-8")).version || "unknown"
  } catch {
    try {
      return JSON.parse(readFileSync(new URL("./../package.json", import.meta.url), "utf-8")).version || "unknown"
    } catch {
      return "unknown"
    }
  }
}

// 0.5.13：serverPath 缺省时的回退从 reprep.sh 的字符串补丁上移到源码——
// 两种布局各自命中：一体包 <root>/server/mcp-server.js；源码树 ../mcp-server.js。
// 这让 reprep.sh 只负责复制，不再做脆弱的位置断言（旧断言在 import 行变动时就失效）。
function defaultServerPath() {
  for (const rel of ["./server/mcp-server.js", "../mcp-server.js"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url))
      if (existsSync(p)) return p
    } catch {}
  }
  return null
}

export const name = "malong-dsh-bridge"

export const inject = ["tools"]

const SERVER_NAME = "malong"

// 0.5.22：DSH 默认只暴露「六合线」（graph + 状态层 = 13 个工具）——README 推荐的日常入口。
// 旧默认是 classic 全量 44 个：DSH 会话的工具清单被灌满，模型在 44 个里挑错工具。
// 宿主显式设置 MALONG_INTERFACE / MALONG_ENTRY_STATE 时以宿主为准
// （classic = 44 全量；diagnostic = 18（加 5 个分析器））。
const DEFAULT_INTERFACE = "graph"
const DEFAULT_ENTRY_STATE = "1"
const effectiveInterface = process.env.MALONG_INTERFACE || DEFAULT_INTERFACE
const effectiveEntryState = process.env.MALONG_ENTRY_STATE || DEFAULT_ENTRY_STATE

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
  const serverPath = cfg.serverPath ?? defaultServerPath()
  if (typeof serverPath !== "string" || serverPath.length === 0) {
    throw new Error("malong-dsh-bridge: missing config.serverPath (absolute path to mcp-server.js; bundled layout falls back to <pkg>/server/mcp-server.js)")
  }
  const stateDir = typeof cfg.stateDir === "string" && cfg.stateDir !== "" ? cfg.stateDir : join(os.homedir(), ".local", "state", "malong-dsh")
  const timeoutMs = typeof cfg.toolCallTimeoutMs === "number" && cfg.toolCallTimeoutMs > 0 ? cfg.toolCallTimeoutMs : 300000
  const BRIDGE_VERSION = bridgeVersion()
  const logger = (msg) => process.stderr.write(`[malong-dsh-bridge] ${msg}\n`)

  mkdirSync(stateDir, { recursive: true })
  const pending = new Map()
  let seq = 0
  let child = null
  let rl = null
  let backoffMs = 1000
  let restartTimer = null
  let disposed = false

  const failFast = (reason) => {
    for (const [id, waiter] of pending) {
      pending.delete(id)
      waiter.reject(reason)
    }
  }

  const scheduleRestart = () => {
    if (disposed || restartTimer) return
    logger(`mcp-server restart scheduled in ${Math.round(backoffMs / 1000)}s (serverPath=${serverPath})`)
    restartTimer = setTimeout(async () => {
      restartTimer = null
      if (disposed) return
      const tools = await connect()
      // 仅当真正失败（且无新 child 已接管）才续调度，避免 child 存在时空转
      if (tools === null && !child) scheduleRestart()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30000)
  }

  const connect = async () => {
    if (disposed || child) return null
    // dogfood-050 r5：U 状态目录统一适配——新 mcp-server 只认 MALONG_STATE_DIR（getStateDir()，
    // 默认 ~/.config/malong），--workspace 仅作旧状态迁移源（baseDir/data/malong-mcp）。
    // 旧桥接只传 --workspace：升级到 0.5.0 代码后 DSH 状态会落进宿主共享目录与 opencode 混用。
    const c = spawn(process.execPath, [serverPath, "--workspace", stateDir, "--max-old-space-size=512"], {
      cwd: dirname(serverPath),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MALONG_STATE_DIR: stateDir,
        MALONG_INTERFACE: effectiveInterface,
        MALONG_ENTRY_STATE: effectiveEntryState,
      },
    })
    child = c
    c.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) logger(`server: ${line.trim()}`)
      }
    })
    // EPIPE 吞掉记日志：child 死亡后首次 stdin.write 若不监听会以 unhandled error 崩掉 dsh 进程；
    // 管道断 = server 已死（exit 事件可能未到），顺手 failFast 堵住窗口期
    c.stdin.on("error", (err) => {
      logger(`server stdin error: ${err.code ?? err.message} (ignored)`)
      failFast(new Error("malong mcp-server connection lost; restarting — retry shortly"))
    })
    c.on("error", (err) => {
      // spawn 失败（serverPath 坏/文件缺失）：Node 只发 'error' 不发 'exit'，
      // 必须在这里清 child + 续调度，否则 watchdog 永远失效
      const wasCurrent = child === c
      child = null
      if (rl) {
        rl.close()
        rl = null
      }
      logger(`mcp-server spawn error: ${err.code ?? err.message}`)
      failFast(new Error("malong mcp-server failed to start; restarting — retry shortly"))
      if (wasCurrent) scheduleRestart()
    })
    c.on("exit", (code, signal) => {
      const wasCurrent = child === c
      child = null
      if (rl) {
        rl.close()
        rl = null
      }
      // fail-fast：pending 立即 reject，不留 300s 空挂
      failFast(new Error("malong mcp-server exited; restarting — retry shortly"))
      if (wasCurrent) {
        logger(`mcp-server exited (code=${code}, signal=${signal})`)
        scheduleRestart()
      }
    })
    rl = createInterface({ input: c.stdout })
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
    try {
      const init = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "malong-dsh-bridge", version: BRIDGE_VERSION },
      })
      logger(`initialized protocol=${init?.protocolVersion}`)
      const listed = await request("tools/list", {})
      const tools = Array.isArray(listed?.tools) ? listed.tools : []
      logger(`tools/list: ${tools.length} tools`)
      backoffMs = 1000
      return tools
    } catch (e) {
      logger(`connect failed: ${e.message}`)
      try { c.kill() } catch {}
      return null
    }
  }

  const request = (method, params) => {
    if (!child) return Promise.reject(new Error("malong mcp-server restarting — retry shortly"))
    return new Promise((resolve, reject) => {
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
  }

  // 首次连接：重试直到成功（spawn 失败 / init 超时都继续退避）
  let tools = null
  while (tools === null && !disposed) {
    tools = await connect()
    if (tools === null) {
      logger(`initial connect failed; retrying in ${Math.round(backoffMs / 1000)}s`)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  logger(`bridge ready (${tools.length} tools, version=${BRIDGE_VERSION})`)

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
  logger(`registered ${registered} tools (serverName=${SERVER_NAME}, interface=${effectiveInterface}, entryState=${effectiveEntryState}, stateDir=${stateDir})`)

  ctx.on("dispose", () => {
    disposed = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    failFast(new Error("malong-dsh-bridge disposed"))
    child?.kill()
  })
}

export { apply }
