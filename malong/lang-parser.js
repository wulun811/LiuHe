// 码龙 — 多语言解析器工厂 (v2 P5.0)
// Sprint 5: 彻底卸载 tree-sitter，纯 Rust 服务
// 详见：通天计划 §六 码龙, P3-rust-parser-service.md

import * as parseClient from './parse-client.js'

export const name = 'malong-lang-parser'
export const version = '0.7.0'

let _core

export async function init(core) {
  const mode = process.env.MALONG_PARSE_MODE
  if (mode === 'builtin' || mode === 'shadow') {
    throw new Error(`MALONG_PARSE_MODE=${mode} is not supported in v0.7.0. Only rust-service mode is available.`)
  }

  _core = core
  await parseClient.init(core)
  await parseClient.connect()

  core.registerService('langParser', {
    getMode() { return 'rust-service' },
    isRustService() { return true },
    getConfigMode() { return parseClient.describeConfig?.() || 'uds' },

    async extractAllAsync(source, ext, filePath) {
      return await parseClient.extractAll(source, ext, filePath)
    },

    async extractSymbolsAsync(source, ext, filePath) {
      return await parseClient.extractSymbols(source, ext, filePath)
    },

    async extractTopLevelAsync(source, ext, filePath) {
      return await parseClient.extractTopLevel(source, ext, filePath)
    },

    async extractReferencesAsync(source, ext, filePath) {
      return await parseClient.extractReferences(source, ext, filePath)
    },

    async hasErrorsAsync(source, ext, filePath) {
      return await parseClient.hasErrors(source, ext, filePath)
    },

    async classifyMessageAsync(content) {
      return await parseClient.classifyMessage(content)
    },

    async computeMetricsAsync(source, ext, filePath) {
      return await parseClient.computeMetrics(source, ext, filePath)
    },

    async batchExtractAsync(files) {
      return await parseClient.batchExtract(files)
    },
  })

  core.log('info', `[lang-parser] v0.7.0 rust-service only, tree-sitter removed`)
}

export async function start() {}

export async function stop() {
  await parseClient.disconnect()
}
