// malong/parse-client.js — Rust 解析服务客户端
// 通过 Unix socket 连接到 malong-parse 守护进程
// 详见：docs/六合工具集/docs/P3-rust-parser-service.md

import net from 'node:net'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const SOCKET_PATH = `/tmp/malong-parse-${process.getuid()}.sock`
const CONNECT_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 2
const HEARTBEAT_INTERVAL_MS = 30000
const CIRCUIT_BREAKER_THRESHOLD = 3
const BINARY_PATH = `${process.env.HOME || '/home'}/.local/bin/malong-parse`
const MAX_RESTART_ATTEMPTS = 3
const RESTART_COOLDOWN_MS = 10000

let _core = null
let _socket = null
let _connected = false
let _connecting = false
let _pending = new Map()
let _reqId = 0
let _buffer = Buffer.alloc(0)
let _heartbeatTimer = null
let _circuitFailures = 0
let _circuitOpen = false  // true = stop trying Rust, use builtin
let _reconnectPromise = null  // 重连期间的 Promise，用于请求排队

export const name = 'malong-parse-client'
export const version = '0.1.0'

export async function init(core) {
  _core = core
}

export async function connect() {
  if (_connected) return true
  
  // 如果正在重连，等待完成
  if (_reconnectPromise) {
    return _reconnectPromise
  }
  
  if (_connecting) {
    // 等待连接完成
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (_connected) {
          clearInterval(check)
          resolve(true)
        } else if (!_connecting) {
          clearInterval(check)
          resolve(false)
        }
      }, 50)
      setTimeout(() => {
        clearInterval(check)
        resolve(false)
      }, CONNECT_TIMEOUT_MS)
    })
  }

  _connecting = true
  
  // 创建重连 Promise，让其他请求可以等待
  _reconnectPromise = (async () => {
    try {
      if (!existsSync(SOCKET_PATH)) {
        const started = await _startProcess()
        if (!started) {
          _connecting = false
          _reconnectPromise = null
          return false
        }
      }

      const result = await new Promise((resolve) => {
        const sock = net.createConnection(SOCKET_PATH)
        const timer = setTimeout(() => {
          sock.destroy()
          _connecting = false
          _reconnectPromise = null
          resolve(false)
        }, CONNECT_TIMEOUT_MS)

        sock.on('connect', () => {
          clearTimeout(timer)
          _socket = sock
          _connected = true
          _connecting = false
          _reconnectPromise = null
          _setupHandlers()
          _startHeartbeat()
          _circuitRecordSuccess()
          _core?.log('info', '[parse-client] connected to malong-parse')
          _preheat().catch(() => {})
          resolve(true)
        })

        sock.on('error', (err) => {
          clearTimeout(timer)
          _connecting = false
          _reconnectPromise = null
          _core?.log('warn', `[parse-client] connection failed: ${err.message}`)
          resolve(false)
        })
      })
      
      return result
    } catch (err) {
      _connecting = false
      _reconnectPromise = null
      return false
    }
  })()
  
  return _reconnectPromise
}

function _setupHandlers() {
  _socket.on('data', (chunk) => {
    _buffer = Buffer.concat([_buffer, chunk])
    _processBuffer()
  })

  _socket.on('close', () => {
    _connected = false
    _socket = null
    _stopHeartbeat()
    _core?.log('warn', '[parse-client] connection closed')
    // 拒绝所有 pending 请求
    for (const [id, { reject }] of _pending) {
      reject(new Error('connection closed'))
    }
    _pending.clear()
    // auto-reconnect after 1s，设置 _reconnectPromise 让后续请求等待
    let reconnectResolve
    _reconnectPromise = new Promise((resolve) => {
      reconnectResolve = resolve
    })
    setTimeout(async () => {
      _core?.log('info', '[parse-client] attempting reconnect...')
      _reconnectPromise = null  // 清除 promise，让 connect() 执行实际连接
      const ok = await connect()
      reconnectResolve(ok)
      if (ok) {
        _reconnectPromise = null  // 重连成功，清除 promise
      }
      // 如果重连失败，保持 _reconnectPromise 为 false，后续请求会检查并失败
    }, 1000)
  })

  _socket.on('error', (err) => {
    _core?.log('error', `[parse-client] socket error: ${err.message}`)
  })
}

function _startHeartbeat() {
  _stopHeartbeat()
  _heartbeatTimer = setInterval(() => {
    if (!_connected) return
    request('health', {}, 5000).catch(() => {
      _core?.log('warn', '[parse-client] heartbeat failed')
    })
  }, HEARTBEAT_INTERVAL_MS)
  if (_heartbeatTimer.unref) _heartbeatTimer.unref()
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }
}

let _restartAttempts = 0
let _lastRestartTime = 0

async function _startProcess() {
  const now = Date.now()
  if (now - _lastRestartTime < RESTART_COOLDOWN_MS) return false
  if (_restartAttempts >= MAX_RESTART_ATTEMPTS) {
    _core?.log('error', `[parse-client] max restart attempts (${MAX_RESTART_ATTEMPTS}) reached, giving up`)
    return false
  }
  if (!existsSync(BINARY_PATH)) {
    _core?.log('error', `[parse-client] binary not found: ${BINARY_PATH}`)
    return false
  }
  _restartAttempts++
  _lastRestartTime = now
  _core?.log('info', `[parse-client] starting malong-parse (attempt ${_restartAttempts}/${MAX_RESTART_ATTEMPTS})...`)
  const child = spawn(BINARY_PATH, [], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  // wait for socket to appear
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (existsSync(SOCKET_PATH)) {
      _core?.log('info', `[parse-client] socket ready after ${(i + 1) * 200}ms`)
      _restartAttempts = 0
      return true
    }
  }
  _core?.log('warn', `[parse-client] socket not ready after 6s`)
  return false
}

async function _preheat() {
  const jsFixture = 'function foo() { return 1; }; class Bar { constructor() { this.x = 1 } }'
  try {
    await request('extract_all', { source: jsFixture, ext: '.js' }, 5000)
    _core?.log('info', '[parse-client] parser pool warmed')
  } catch (e) {
    // preheat failure is non-fatal
  }
}

function _circuitRecordFailure() {
  _circuitFailures++
  if (_circuitFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitOpen = true
    _core?.log('error', `[parse-client] circuit breaker OPEN after ${_circuitFailures} failures, malong-parse unavailable`)
    // try half-open after 60s
    setTimeout(() => {
      _circuitOpen = false
      _circuitFailures = 0
      _core?.log('info', '[parse-client] circuit breaker half-open, retrying...')
      connect().catch(() => {})
    }, 60000)
  }
}

function _circuitRecordSuccess() {
  _circuitFailures = 0
}

function _processBuffer() {
  while (_buffer.length >= 4) {
    const frameLen = _buffer.readUInt32BE(0)
    if (_buffer.length < 4 + frameLen) break

    const payload = _buffer.slice(4, 4 + frameLen)
    _buffer = _buffer.slice(4 + frameLen)

    try {
      const response = JSON.parse(payload.toString())
      const pending = _pending.get(response.id)
      if (pending) {
        _pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.error) {
          // 业务错误（FILE_TOO_LARGE / FILE_NOT_FOUND 等）：服务本身正常，不算熔断失败
          _circuitRecordSuccess()
          pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
        } else {
          pending.resolve(response.result)
        }
      }
    } catch (err) {
      _core?.log('error', `[parse-client] parse error: ${err.message}`)
    }
  }
}

async function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS, priority = 0) {
  if (_circuitOpen) {
    throw new Error('circuit breaker open')
  }

  if (!_connected) {
    // 如果正在重连，等待重连完成（最多 5 秒）
    if (_reconnectPromise) {
      const waitResult = await Promise.race([
        _reconnectPromise,
        new Promise(resolve => setTimeout(() => resolve(false), 5000))
      ])
      if (!waitResult) {
        throw new Error('reconnect timeout (5s)')
      }
    } else {
      const ok = await connect()
      if (!ok) throw new Error('not connected to malong-parse')
    }
  }

  const id = `req-${++_reqId}`

  let frame
  const rawSource = params?.source
  if (rawSource && typeof rawSource === 'string') {
    const { source, ...restParams } = params
    const sourceBuf = Buffer.from(source, 'utf-8')
    const header = JSON.stringify({ id, method, params: { ...restParams, source_len: sourceBuf.length }, priority })
    const headerBuf = Buffer.from(header, 'utf-8')
    const totalLen = 4 + headerBuf.length + sourceBuf.length
    frame = Buffer.alloc(4 + totalLen)
    frame.writeUInt32BE(totalLen, 0)
    frame.writeUInt32BE(headerBuf.length, 4)
    headerBuf.copy(frame, 8)
    sourceBuf.copy(frame, 8 + headerBuf.length)
  } else {
    const msg = JSON.stringify({ id, method, params, priority })
    const msgBuf = Buffer.from(msg, 'utf-8')
    frame = Buffer.alloc(4 + msgBuf.length)
    frame.writeUInt32BE(msgBuf.length, 0)
    msgBuf.copy(frame, 4)
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      _circuitRecordFailure()
      reject(new Error(`request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    if (!_socket) {
      clearTimeout(timer)
      _pending.delete(id)
      return reject(new Error('not connected'))
    }

    _pending.set(id, {
      resolve: (v) => { _circuitRecordSuccess(); resolve(v) },
      reject: (e) => { _circuitRecordFailure(); reject(e) },
      timer,
    })
    _socket.write(frame)
  })
}

// ── 对外 API（对应 lang-parser.js 的方法） ──

export async function parse(source, ext) {
  // Rust 服务不返回 tree 对象，而是直接做 extract
  // 这个方法主要用于兼容性，实际应该用 extractAll
  return request('has_errors', { source, ext })
}

export async function extractAll(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  const result = await request('extract_all', params)
  return {
    symbols: result.symbols.map(s => ({
      name: s.name,
      type: s.kind,
      startLine: s.start_line,
      endLine: s.end_line,
    })),
    refs: result.refs.map(r => ({
      type: r.kind,
      name: r.name,
      line: r.line,
      module: r.module,
      symbols: r.symbols,
    })),
    hasErrors: result.has_errors,
  }
}

export async function extractSymbols(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  const result = await request('extract_symbols', params)
  return {
    symbols: result.symbols.map(s => ({
      name: s.name,
      type: s.kind,
      startLine: s.start_line,
      endLine: s.end_line,
    })),
    imports: result.imports.map(i => ({
      target: i.target,
      kind: i.kind,
    })),
  }
}

export async function extractTopLevel(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  const result = await request('extract_top_level', params)
  return result.symbols.map(s => ({
    name: s.name,
    type: s.kind,
    line: s.start_line,
  }))
}

export async function extractReferences(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  const result = await request('extract_references', params)
  return result.refs.map(r => ({
    type: r.kind,
    name: r.name,
    line: r.line,
    module: r.module,
    symbols: r.symbols,
  }))
}

export async function hasErrors(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  const result = await request('has_errors', params)
  return result.has_errors
}

export async function simplifyAST(source, ext, depth = 30, filePath) {
  const params = filePath ? { file_path: filePath, ext, options: { max_depth: depth } } : { source, ext, options: { max_depth: depth } }
  return request('simplify_ast', params)
}

export async function classifyMessage(content) {
  return request('classify_message', { content })
}

export async function computeMetrics(source, ext, filePath) {
  const params = filePath ? { file_path: filePath, ext } : { source, ext }
  return request('compute_metrics', params)
}

export async function batchExtract(files) {
  // files: [{path, source}] or [{path, file_path}]
  const result = await request('batch_extract', { files }, 120000, 1)  // priority=1 for batch
  return result.results.map(r => {
    if (r.error) {
      return { path: r.path, error: r.error }
    }
    return {
      path: r.path,
      symbols: r.result.symbols.map(s => ({
        name: s.name,
        type: s.kind,
        startLine: s.start_line,
        endLine: s.end_line,
      })),
      refs: r.result.refs.map(ref => ({
        type: ref.kind,
        name: ref.name,
        line: ref.line,
        module: ref.module,
        symbols: ref.symbols,
      })),
      hasErrors: r.result.has_errors,
    }
  })
}

export async function health() {
  return request('health', {})
}

export function isConnected() {
  return _connected
}

export async function disconnect() {
  if (_socket) {
    _socket.end()
    _socket = null
    _connected = false
  }
}
