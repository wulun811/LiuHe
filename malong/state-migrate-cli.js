// state-migrate-cli.js — LH-002：状态迁移子进程入口。
// 父进程（host-config.defaultRunMigrationChild）spawn 本文件；stdout 返回 JSON：
// { moved: [], skipped: [], failed: [] }。子进程崩溃（如 Windows 跨盘 cpSync 0xC0000409）
// 只会让父进程收到 signal/非零退出——fail-soft，不阻断宿主启动。
import { runMigration } from './state-migrate.js'

const [legacy, next] = process.argv.slice(2)
if (!legacy || !next) {
  process.stderr.write('usage: state-migrate-cli <legacyDir> <nextDir>\n')
  process.exit(2)
}
try {
  const r = runMigration(legacy, next, { log: () => {} })
  process.stdout.write(JSON.stringify(r))
  process.exit(0)
} catch (e) {
  process.stderr.write(String(e?.stack || e))
  process.exit(3)
}
