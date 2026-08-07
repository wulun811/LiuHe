// 码龙 — write_symbol 原语 handler（原语化 P3）
// 委托 write-runtime.js；工具层只做参数透传 + workspace 初始化

import { writeSymbol } from '../../write-runtime.js'

export async function handle(args, context) {
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir
  if (workspaceDir && codeIndexService) {
    await codeIndexService.initWorkspace(workspaceDir)
  }
  try {
    return await writeSymbol(args || {}, context)
  } catch (e) {
    // R22-⑪：四条写路径唯一裸异常出口——createJournal ENOSPC/EPERM 等此前裸抛到 MCP（错误对象契约违反）
    return {
      error: 'write_failed',
      message: `write_symbol failed: ${e.message}`, ...(e.code ? { errno: e.code } : {}),
      suggestion: 'Check disk space and file permissions; the file was not modified.',
    }
  }
}
