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
    //
    // D-04（2026-10-29 专家裁决 B）：旧文案 asserted `the file was not modified.`。
    // 但本 catch 覆盖整个 writeSymbol()，理论上包含写盘之后的步骤（回读/登记写者/索引/审计）。
    // 本轮静态核查后未能注入出可达路径（写后各步均扣异常或降级），但「找不到注入点」
    // 不等于「永不发生」——一旦未来新增写后步骤裸抛，这句话就变成谎报，违反
    // 不变式 #1（真实效果不冒名）。故改为中性表述：不断言未写，只说「结果不确定，去重读」。
    return {
      error: 'write_failed',
      message: `write_symbol failed: ${e.message}`, ...(e.code ? { errno: e.code } : {}),
      suggestion: 'Check disk space and file permissions. The write outcome may be uncertain — re-read the file to verify its actual state before retrying.',
      outcome_uncertain: true,
    }
  }
}
