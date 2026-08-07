// tool-write-symbols — P4 批量写原语（§6.4 隐式 all_or_nothing 事务）
import { writeSymbols } from '../../write-runtime.js'

export async function handle(args, context) {
  // r8(D3)：缺 initWorkspace——跨工作区时会查错库（A 库的 range/符号应用到 B 工作区文件）
  const { codeIndexService } = context
  const workspaceDir = args?.workspace_dir
  if (workspaceDir && codeIndexService) {
    await codeIndexService.initWorkspace(workspaceDir)
  }
  try {
    return await writeSymbols(args, context)
  } catch (e) {
    return { success: false, error: { code: 'INTERNAL', message: e.message } }
  }
}
