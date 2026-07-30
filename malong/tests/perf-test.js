#!/usr/bin/env node
// malong 性能测试套件 — 重启 opencode 后运行: node tests/perf-test.js

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MALONG_DIR = join(__dirname, '..')
const TMP_DIR = join(__dirname, '.perf-tmp')

const results = []
let passed = 0, failed = 0

function record(name, ms, target, extra = '') {
  const ok = ms <= target
  if (ok) passed++; else failed++
  results.push({ name, ms: Math.round(ms), target, ok, extra })
  console.log(`${ok ? '✓' : '✗'} ${name}: ${Math.round(ms)}ms (target ≤${target}ms) ${extra}`)
}

async function timeit(fn) {
  const t0 = performance.now()
  const result = await fn()
  return { ms: performance.now() - t0, result }
}

// ═══════════════════════════════════════════
// 1. Rust parse service 性能
// ═══════════════════════════════════════════
async function testRustParse() {
  console.log('\n═══ 1. Rust Parse Service ═══')

  let parseClient
  try {
    parseClient = await import(join(MALONG_DIR, 'parse-client.js'))
  } catch (e) {
    console.log('✗ 无法加载 parse-client.js:', e.message)
    return
  }

  const connected = await parseClient.connect().catch(() => false)
  if (!connected) {
    console.log('✗ Rust parse service 未运行，跳过')
    return
  }

  // 1a. 小文件解析
  const smallPy = 'def hello(name):\n    return f"Hello, {name}!"\n\nclass Foo:\n    def bar(self):\n        pass\n'
  const { ms: msSmall } = await timeit(() => parseClient.extractAll(smallPy, '.py'))
  record('小文件解析 (Python 6行)', msSmall, 50)

  // 1b. 中文件解析
  const medPy = Array.from({ length: 100 }, (_, i) =>
    `def func_${i}(x, y):\n    """Docstring for func_${i}."""\n    result = x + y\n    return result\n`
  ).join('\n')
  const { ms: msMed } = await timeit(() => parseClient.extractAll(medPy, '.py'))
  record('中文件解析 (Python 400行)', msMed, 100)

  // 1c. 大文件解析 (900KB，接近 1MB 限制)
  const bigLine = 'x' + 'a'.repeat(89) + '\n'
  const bigPy = bigLine.repeat(10000) // ~900KB
  try {
    const { ms: msBig } = await timeit(() => parseClient.extractAll(bigPy, '.py'))
    record('大文件解析 (900KB)', msBig, 500)

    // 1d. 900KB 缓存命中
    const { ms: msCached } = await timeit(() => parseClient.extractAll(bigPy, '.py'))
    record('大文件缓存命中 (900KB)', msCached, 500)
  } catch (e) {
    console.log(`✗ 大文件解析失败: ${e.message}`)
    failed += 2
  }

  // 1e. 多语言并发
  const langs = [
    ['def foo(): pass', '.py'],
    ['function bar() {}', '.js'],
    ['fn baz() {}', '.rs'],
    ['func qux() {}', '.go'],
    ['class A: pass', '.py'],
  ]
  const { ms: msConcurrent } = await timeit(() =>
    Promise.all(langs.map(([code, ext]) => parseClient.extractAll(code, ext)))
  )
  record('5语言并发解析', msConcurrent, 200)

  // 1f. 连续 50 次请求
  const { ms: msBatch } = await timeit(async () => {
    for (let i = 0; i < 50; i++) {
      await parseClient.extractAll(`def f${i}(): return ${i}`, '.py')
    }
  })
  record('50次连续请求', msBatch, 2000)
}

// ═══════════════════════════════════════════
// 2. code-index 索引性能
// ═══════════════════════════════════════════
async function testCodeIndex() {
  console.log('\n═══ 2. Code Index ═══')

  // 创建临时项目
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true })
  mkdirSync(join(TMP_DIR, 'src'), { recursive: true })

  for (let i = 0; i < 50; i++) {
    const content = [
      `import { helper_${i} } from './utils'`,
      `export function process_${i}(data) {`,
      `  const result = helper_${i}(data)`,
      `  return transform_${i}(result)`,
      `}`,
      `function transform_${i}(x) { return x * ${i} }`,
      `export class Handler_${i} {`,
      `  handle(req) { return process_${i}(req.body) }`,
      `}`,
    ].join('\n')
    writeFileSync(join(TMP_DIR, 'src', `module_${i}.js`), content)
  }
  writeFileSync(join(TMP_DIR, 'src', 'utils.js'),
    Array.from({ length: 50 }, (_, i) => `export function helper_${i}(x) { return x + ${i} }`).join('\n')
  )

  let CodeIndex
  try {
    CodeIndex = (await import(join(MALONG_DIR, 'code-index.js'))).default
  } catch (e) {
    console.log('✗ 无法加载 code-index.js:', e.message)
    return
  }

  const services = {}
  const mockCore = {
    log: () => {},
    get: (key, def) => def,
    services,
    registerService: (name, svc) => { services[name] = svc },
    getService: (name) => services[name] || null,
    getWorkspaceDir: (ws) => join(ws, '.malong'),
    emit: () => {},
  }
  mkdirSync(join(TMP_DIR, '.malong'), { recursive: true })

  // 先注册 lang-parser 服务
  try {
    const langParser = await import(join(MALONG_DIR, 'lang-parser.js'))
    await langParser.init(mockCore)
  } catch (e) {
    console.log('⚠ lang-parser 加载失败，code-index 测试可能受限:', e.message)
  }

  await CodeIndex.init(mockCore)
  const ci = services.codeIndex
  if (!ci) {
    console.log('✗ codeIndex 服务未注册')
    return
  }

  // 2a. 索引 51 个文件
  ci.initWorkspace(TMP_DIR)
  const files = Array.from({ length: 51 }, (_, i) =>
    i < 50 ? join(TMP_DIR, 'src', `module_${i}.js`) : join(TMP_DIR, 'src', 'utils.js')
  )
  const { ms: msIndex } = await timeit(() => ci.indexBatch(files, TMP_DIR))
  record('索引 51 个 JS 文件', msIndex, 5000)

  // 2b. 符号查询
  const { ms: msSymbols } = await timeit(() => ci.getSymbols('src/module_0.js'))
  record('getSymbols 查询', msSymbols, 100)

  // 2c. 引用查询
  const { ms: msRefs } = await timeit(() => ci.getReferences('helper_0'))
  record('getReferences 查询', msRefs, 200)

  // 2d. 调用者查询
  const { ms: msCallers } = await timeit(() => ci.getCallers('process_0'))
  record('getCallers 查询', msCallers, 200)

  // 2e. 影响分析
  const { ms: msImpact } = await timeit(() =>
    ci.getImpactAnalysis('src/module_0.js', { symbol: 'process_0', depth: 2 })
  )
  record('getImpactAnalysis', msImpact, 500)

  // 2f. 符号搜索
  const { ms: msSearch } = await timeit(() => ci.searchSymbols('process'))
  record('searchSymbols', msSearch, 200)

  // 2g. 死代码检测
  const { ms: msDead } = await timeit(() => ci.detectDeadCode())
  record('detectDeadCode', msDead, 1000)

  // 2h. 文件大纲
  const { ms: msOutline } = await timeit(() => ci.getFileOutline('src/module_0.js'))
  record('getFileOutline', msOutline, 200)

  // 2i. 模块依赖
  const { ms: msDeps } = await timeit(() => ci.getModuleDependencies('src/module_0.js', { depth: 3 }))
  record('getModuleDependencies', msDeps, 500)

  // 2j. 统计
  const stats = ci.getStats()
  console.log(`  索引统计: ${stats.files} files, ${stats.symbols} symbols, ${stats.refs} refs`)

  await CodeIndex.stop()
  rmSync(TMP_DIR, { recursive: true })
}

// ═══════════════════════════════════════════
// 3. Tool handler 响应时间
// ═══════════════════════════════════════════
async function testToolHandlers() {
  console.log('\n═══ 3. Tool Handlers ═══')

  const context = {
    codeIndexService: null,
    getWorkspaceDir: (ws) => join(ws, '.malong'),
    langParserService: null,
    log: () => {},
  }

  // 3a. error-codes 验证
  const { makeError, validateFilePath } = await import(join(MALONG_DIR, 'error-codes.js'))
  const { ms: msValidate } = await timeit(() => {
    for (let i = 0; i < 1000; i++) validateFilePath(`src/file_${i}.js`)
  })
  record('validateFilePath ×1000', msValidate, 100)

  // 3b. staleness 检查
  const { checkFileStaleness } = await import(join(MALONG_DIR, 'staleness.js'))
  const { ms: msStale } = await timeit(() => {
    for (let i = 0; i < 100; i++) checkFileStaleness(null, '/tmp', `file_${i}.js`)
  })
  record('checkFileStaleness ×100 (no service)', msStale, 100)

  // 3c. file-collector
  const { collectFiles } = await import(join(MALONG_DIR, 'file-collector.js'))
  const { ms: msCollect } = await timeit(() => collectFiles(MALONG_DIR, { maxFiles: 100 }))
  record('collectFiles (100 files)', msCollect, 1000)
}

// ═══════════════════════════════════════════
// 4. 内存占用
// ═══════════════════════════════════════════
async function testMemory() {
  console.log('\n═══ 4. Memory ═══')

  const before = process.memoryUsage()

  // 模拟负载：加载并执行多个模块
  const modules = [
    'error-codes.js', 'staleness.js', 'file-collector.js',
    'code-search.js', 'style-sniffer.js', 'patch-parser.js',
  ]
  for (const m of modules) {
    try { await import(join(MALONG_DIR, m)) } catch {}
  }

  if (typeof global.gc === 'function') global.gc()
  const after = process.memoryUsage()

  const rssMb = Math.round(after.rss / 1048576)
  const heapMb = Math.round(after.heapUsed / 1048576)
  record('RSS 内存占用', rssMb, 150, `${heapMb}MB heap`)
  console.log(`  RSS: ${rssMb}MB, Heap: ${heapMb}MB, 增量: ${Math.round((after.rss - before.rss) / 1048576)}MB`)
}

// ═══════════════════════════════════════════
// 5. sandbox 命令执行
// ═══════════════════════════════════════════
async function testSandbox() {
  console.log('\n═══ 5. Sandbox ═══')

  let sandboxMod
  try {
    sandboxMod = await import(join(MALONG_DIR, 'sandbox.js'))
  } catch (e) {
    console.log('✗ 无法加载 sandbox.js:', e.message)
    return
  }

  const services = {}
  const mockCore = {
    registerService: (name, svc) => { services[name] = svc },
    log: () => {},
    get: (key, def) => def,
  }

  await sandboxMod.init(mockCore)
  const sandbox = services.sandbox
  if (!sandbox) {
    console.log('✗ sandbox 服务未注册')
    return
  }

  // 5a. 简单命令
  const { ms: msEcho } = await timeit(() => sandbox.exec('echo hello', '/tmp', { timeout: 15000 }))
  record('sandbox echo', msEcho, 10000)

  // 5b. 带 env 的命令
  const { ms: msEnv, result: envResult } = await timeit(() =>
    sandbox.exec('echo $TEST_VAR', '/tmp', { timeout: 15000, env: { TEST_VAR: 'hello_env' } })
  )
  const envOk = envResult?.stdout?.includes('hello_env')
  record('sandbox env 传递', msEnv, 15000, envOk ? 'env OK' : 'env MISSING!')
  if (!envOk) { console.log('  ⚠ env 变量未传递到子进程'); failed++; passed-- }

  // 5c. 超时
  const { ms: msTimeout } = await timeit(() => sandbox.exec('sleep 10', '/tmp', { timeout: 500 }))
  record('sandbox 超时 (500ms)', msTimeout, 2000)
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   malong 性能测试套件 v1.0              ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`Node: ${process.version}`)

  try { await testRustParse() } catch (e) { console.log('✗ Rust Parse 测试异常:', e.message) }
  try { await testCodeIndex() } catch (e) { console.log('✗ Code Index 测试异常:', e.message) }
  try { await testToolHandlers() } catch (e) { console.log('✗ Tool Handlers 测试异常:', e.message) }
  try { await testMemory() } catch (e) { console.log('✗ Memory 测试异常:', e.message) }
  try { await testSandbox() } catch (e) { console.log('✗ Sandbox 测试异常:', e.message) }

  // 清理：断开 parse 连接
  try {
    const pc = await import(join(MALONG_DIR, 'parse-client.js'))
    await pc.disconnect()
  } catch {}

  console.log('\n══════════════════════════════════════════')
  console.log(`总计: ${passed} passed, ${failed} failed, ${results.length} total`)

  const failures = results.filter(r => !r.ok)
  if (failures.length > 0) {
    console.log('\n未达标项:')
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.ms}ms > ${f.target}ms`)
    }
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
