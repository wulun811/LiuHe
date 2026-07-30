// malong/parse-client.js — Rust 解析服务客户端
// 通过 Unix socket 连接到 malong-parse 守护进程
// 详见：docs/六合工具集/docs/P3-rust-parser-service.md

import net from 'node:net'
import { existsSync } from 'node:fs'

const SOCKET_PATH = `/tmp/malong-parse-${process.getuid()}.sock`
const CONNECT_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 2

let _core = null
let _socket = null
let _connected = false
let _connecting = false
let _pending = new Map()
let _reqId = 0
let _buffer = Buffer.alloc(0)

export const name = 'malong-parse-client'
export const version = '0.1.0'

export async function init(core) {
  _core = core
}

export async function connect() {
  if (_connected) return true
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

  if (!existsSync(SOCKET_PATH)) {
    _connecting = false
    return false
  }

  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH)
    const timer = setTimeout(() => {
      sock.destroy()
      _connecting = false
      resolve(false)
    }, CONNECT_TIMEOUT_MS)

    sock.on('connect', () => {
      clearTimeout(timer)
      _socket = sock
      _connected = true
      _connecting = false
      _setupHandlers()
      _core?.log('info', '[parse-client] connected to malong-parse')
      resolve(true)
    })

    sock.on('error', (err) => {
      clearTimeout(timer)
      _connecting = false
      _core?.log('warn', `[parse-client] connection failed: ${err.message}`)
      resolve(false)
    })
  })
}

function _setupHandlers() {
  _socket.on('data', (chunk) => {
    _buffer = Buffer.concat([_buffer, chunk])
    _processBuffer()
  })

  _socket.on('close', () => {
    _connected = false
    _socket = null
    _core?.log('warn', '[parse-client] connection closed')
    // 拒绝所有 pending 请求
    for (const [id, { reject }] of _pending) {
      reject(new Error('connection closed'))
    }
    _pending.clear()
  })

  _socket.on('error', (err) => {
    _core?.log('error', `[parse-client] socket error: ${err.message}`)
  })
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

async function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!_connected) {
    const ok = await connect()
    if (!ok) throw new Error('not connected to malong-parse')
  }

  const id = `req-${++_reqId}`
  const msg = JSON.stringify({ id, method, params })
  const frame = Buffer.alloc(4 + Buffer.byteLength(msg))
  frame.writeUInt32BE(Buffer.byteLength(msg), 0)
  frame.write(msg, 4)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      reject(new Error(`request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    _pending.set(id, { resolve, reject, timer })
    _socket.write(frame)
  })
}

// ── 对外 API（对应 lang-parser.js 的方法） ──

export async function parse(source, ext) {
  // Rust 服务不返回 tree 对象，而是直接做 extract
  // 这个方法主要用于兼容性，实际应该用 extractAll
  return request('has_errors', { source, ext })
}

export async function extractAll(source, ext) {
  const result = await request('extract_all', { source, ext })
  // 转换格式以匹配 lang-parser.js 的输出
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

export async function extractSymbols(source, ext) {
  const result = await request('extract_symbols', { source, ext })
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

export async function extractTopLevel(source, ext) {
  const result = await request('extract_top_level', { source, ext })
  return result.symbols.map(s => ({
    name: s.name,
    type: s.kind,
    line: s.start_line,
  }))
}

export async function extractReferences(source, ext) {
  const result = await request('extract_references', { source, ext })
  return result.refs.map(r => ({
    type: r.kind,
    name: r.name,
    line: r.line,
    module: r.module,
    symbols: r.symbols,
  }))
}

export async function hasErrors(source, ext) {
  const result = await request('has_errors', { source, ext })
  return result.has_errors
}

export async function simplifyAST(source, ext, depth = 30) {
  return request('simplify_ast', { source, ext, options: { max_depth: depth } })
}

export async function classifyMessage(content) {
  return request('classify_message', { content })
}

export async function batchExtract(files) {
  // files: [{path, source}]
  const result = await request('batch_extract', { files }, 120000)
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
