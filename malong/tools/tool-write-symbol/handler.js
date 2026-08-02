// 码龙 — write_symbol 原语 handler（原语化 P3）
// 委托 write-runtime.js；工具层只做参数透传 + workspace 初始化

import { writeSymbol } from '../../write-runtime.js'

export async function handle(args, context) {
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir
  if (workspaceDir && codeIndexService) {
    await codeIndexService.initWorkspace(workspaceDir)
  }
  return writeSymbol(args || {}, context)
}
