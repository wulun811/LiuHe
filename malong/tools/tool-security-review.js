import { extname } from 'node:path'

export const name = 'tool-security-review'
export const version = '0.1.0'

let _core

const PATTERNS = [
  { id: 'eval', severity: 'high', category: 'code-injection', re: /\beval\s*\(/g, msg: 'eval() 允许任意代码执行，存在注入风险' },
  { id: 'Function-ctor', severity: 'high', category: 'code-injection', re: /\bnew\s+Function\s*\(/g, msg: 'Function 构造函数存在代码注入风险' },
  { id: 'exec-cmd', severity: 'high', category: 'command-injection', re: /\b(exec|execSync|execFileSync)\s*\([^)]*\+/g, msg: 'exec 中拼接字符串可能导致命令注入' },
  { id: 'exec-raw', severity: 'high', category: 'command-injection', re: /\b(child_process\.)?exec\s*\(/g, msg: 'exec 调用 shell，避免拼接用户输入' },
  { id: 'spawn-shell', severity: 'high', category: 'command-injection', re: /spawn\s*\([^,]+,\s*[^,]+,\s*{[^}]*shell:\s*true/g, msg: 'spawn 启用 shell=true 可能引入命令注入' },
  { id: 'sql-concat', severity: 'high', category: 'sql-injection', re: /(SELECT|INSERT|UPDATE|DELETE)\s+.+?['"]\s*\+\s*\w+/gis, msg: 'SQL 字符串拼接可能导致 SQL 注入' },
  { id: 'innerHTML', severity: 'medium', category: 'xss', re: /\.innerHTML\s*=/g, msg: 'innerHTML 可导致 XSS，建议用 textContent 或 safe DOM API' },
  { id: 'dangerouslySet', severity: 'medium', category: 'xss', re: /dangerouslySetInnerHTML/g, msg: 'dangerouslySetInnerHTML 可导致 XSS' },
  { id: 'fs-unlink-sync', severity: 'medium', category: 'file-access', re: /fs\.(unlinkSync|rmSync|rmdirSync)\s*\(/g, msg: '同步删除大文件会阻塞事件循环' },
  { id: 'process-exit', severity: 'medium', category: 'stability', re: /\bprocess\.exit\s*\(/g, msg: 'process.exit() 硬终止进程，应使用错误返回' },
  { id: 'crypto-md5', severity: 'low', category: 'crypto', re: /crypto\.createHash\s*\(\s*['"]md5['"]\s*\)/gi, msg: 'MD5 不适合安全哈希，推荐 SHA-256' },
  { id: 'jwt-hardcoded', severity: 'high', category: 'secrets', re: /jwt\.sign\s*\([^,]+,\s*['"][a-zA-Z0-9_\-]{8,}['"]/g, msg: 'JWT secret 硬编码在代码中，应使用环境变量' },
  { id: 'password-hardcode', severity: 'high', category: 'secrets', re: /password\s*[=:]\s*['"][^'"]{4,}['"]/gi, msg: '密码硬编码在代码中' },
  { id: 'api-key-hardcode', severity: 'high', category: 'secrets', re: /(api[_-]?key|apikey|secret|token)\s*[=:]\s*['"][a-zA-Z0-9_\-]{8,}['"]/gi, msg: 'API key/secret/token 硬编码在代码中' },
  { id: 'allow-all-cors', severity: 'medium', category: 'cors', re: /(Access-Control-Allow-Origin|origin)\s*[=:]\s*['"]\*['"]/gi, msg: 'CORS 设置为 * 允许所有域访问' },
  { id: 'no-rate-limit', severity: 'low', category: 'dos', re: /app\.(get|post|put|delete|patch)\s*\(['"][^'"]+['"]\s*,\s*(async\s*)?\(/g, msg: '路由缺少速率限制中间件' },
  { id: 'debug-log', severity: 'low', category: 'info-leak', re: /console\.(log|dir|table)\s*\([^)]*(password|secret|token|key)/gi, msg: '调试日志可能泄露敏感信息' },
  { id: 'insecure-compare', severity: 'medium', category: 'timing', re: /===?\s*['"].{4,}['"]\s*\|\|\s*['"].{4,}['"]\s*!==?\s*['"]/g, msg: '字符串比较可能被时序攻击' },
  { id: 'no-input-validation', severity: 'medium', category: 'input-validation', re: /\bbody\.[a-zA-Z]+\b(?:\s*\)|\.\s*map|\s*\.\s*forEach)/g, msg: '直接使用请求体未做输入验证' },
]

export async function init(core) {
  _core = core

  core.registerService('securityReview', {
    async scan(source, filePath, opts) {
      const s = String(source)
      const ext = extname(filePath || '')
      const findings = []

      for (const p of PATTERNS) {
        p.re.lastIndex = 0
        let m
        while ((m = p.re.exec(s)) !== null) {
          const lineNum = s.slice(0, m.index).split('\n').length
          findings.push({
            id: p.id, severity: p.severity, category: p.category,
            message: p.msg, line: lineNum, match: m[0].slice(0, 80),
          })
        }
      }

      return {
        summary: {
          total: findings.length,
          high: findings.filter(f => f.severity === 'high').length,
          medium: findings.filter(f => f.severity === 'medium').length,
          low: findings.filter(f => f.severity === 'low').length,
          score: Math.max(0, 100 - findings.filter(f => f.severity === 'high').length * 30
            - findings.filter(f => f.severity === 'medium').length * 10
            - findings.filter(f => f.severity === 'low').length * 3),
        },
        findings,
        filePath,
        language: ext.slice(1) || 'unknown',
      }
    },

    async scanDirectory(files, opts) {
      const results = []
      for (const { source, filePath } of files) {
        const r = await this.scan(source, filePath, opts)
        if (r.summary.total > 0) results.push(r)
      }
      return {
        filesScanned: files.length,
        filesWithIssues: results.length,
        totalFindings: results.reduce((s, r) => s + r.summary.total, 0),
        results,
      }
    },
  })
}
