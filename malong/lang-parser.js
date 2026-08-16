// 码龙 — 多语言解析器工厂 (v2 P5.0)
// Sprint 5: 彻底卸载 tree-sitter，纯 Rust 服务
// 详见：通天计划 §六 码龙, P3-rust-parser-service.md

import * as parseClient from './parse-client.js'

export const name = 'malong-lang-parser'
export const version = '0.4.5-post8'

let _core

export async function init(core) {
  const mode = process.env.MALONG_PARSE_MODE
  if (mode === 'builtin' || mode === 'shadow') {
    throw new Error(`MALONG_PARSE_MODE=${mode} is not supported in v${version}. Only rust-service mode is available.`)
  }

  _core = core
  await parseClient.init(core)
  await parseClient.connect()

  core.registerService('langParser', {
    getMode() { return 'rust-service' },
    isRustService() { return true },
    getConfigMode() { return parseClient.describeConfig?.() || 'uds' },

    async extractAllAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.extractAll(source, ext, filePath, workspaceRoot)
    },

    async extractSymbolsAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.extractSymbols(source, ext, filePath, workspaceRoot)
    },

    async extractTopLevelAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.extractTopLevel(source, ext, filePath, workspaceRoot)
    },

    async extractReferencesAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.extractReferences(source, ext, filePath, workspaceRoot)
    },

    async hasErrorsAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.hasErrors(source, ext, filePath, workspaceRoot)
    },

    async classifyMessageAsync(content) {
      return await parseClient.classifyMessage(content)
    },

    async computeMetricsAsync(source, ext, filePath, workspaceRoot) {
      return await parseClient.computeMetrics(source, ext, filePath, workspaceRoot)
    },

    async batchExtractAsync(files, workspaceRoot) {
      return await parseClient.batchExtract(files, workspaceRoot)
    },
  })

  core.log('info', `[lang-parser] v${version} rust-service only, tree-sitter removed`)
}

export async function start() {}

export async function stop() {
  await parseClient.disconnect()
}
