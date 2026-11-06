// WP04：统一 OperationReceipt serializer（纯函数，无 IO，不落盘）。
// 写 surface（code_patch / code_batch / code_maintain / edit-transaction）从实际操作
// 与恢复事实组装同一 receipt 结构，挂到响应 observation.receipt；响应既有字段全部
// 保留（classic 兼容旧字段，不另造事务存储）。
// 合同要点：
// - effect 与 state_commit 分离（AC15）：文件已写 ≠ 任务状态已提交；committed=false
//   → state_commit='pending'，重试同 request_id 可终态收口。
// - 三类操作保证边界（计划书 §13.1）：modify=需可核对 base 版本；create=目标不存在作
//   base 前提；delete/move=未支持，如实声明不静默扩展。
// - hash 三元组 pre/intended/result 来自操作记录与写入结果；result 为写入内容计算的
//   intended hash，独立回读实测校验未做——在 limitations 显式声明（不冒充已验证）。
// - files 超过 50 条截断显示（files_omitted），scope/truncation 如实呈现。

export const RECEIPT_VERSION = 1

export function opGuarantee(kind, createMode = false) {
  if (createMode) return { op_class: 'create', guarantee: 'target absent as base', note: 'create: base premise is that the file does not exist; undo/rollback deletes it' }
  if (kind === 'delete' || kind === 'move') return { op_class: 'unsupported', guarantee: 'not supported', note: 'delete/move is not supported; declared instead of silently extended' }
  return { op_class: 'modify', guarantee: 'version-anchored edit', note: 'modify: requires a verifiable base version (pre hash / expect anchor)' }
}

export function serializeReceipt(input = {}) {
  const files = Array.isArray(input.files) ? input.files : []
  // WP04 体验修正（live MCP 实测）：回读声明必须与实际一致——writeSymbol/writeSymbols 路径
  // 已强制回读（批 C），这些 surface 传 readback:'enforced'；未回读的路径用默认声明，不冒充已验证
  const readback = input.readback === 'enforced'
    ? 'post-write read-back equality check is enforced on this path; a mismatch fails the write (READBACK_MISMATCH) and the operation is marked indeterminate'
    : 'post-write read-back verification is not performed on this path (declared, not implied)'
  return {
    receipt_version: RECEIPT_VERSION,
    kind: input.kind || 'unknown',
    operation_id: input.operation_id || null,
    request_id: input.request_id || null,
    // R22-F20b（2026-11-05 风暴试用）：no-op 批次不得继续写 effect='workspace_write'。
    // 允许调用方显式覆盖；未给时保持旧默认（其余 surface 行为不变）。
    effect: input.effect || 'workspace_write',
    state_commit: input.state_commit || (input.committed === true ? 'committed' : 'pending'),
    // R16k（2026-11-01）：回读已验证必须可判读。此前只给 limitations 里一段文字
    // （“enforced on this path”就是一句口号），上层（trace / 调用方）读不出“验过了”。
    // 仅当调用方明确给出布尔时带出，不给就不出现（不臆造）。
    ...(typeof input.readback_verified === 'boolean' ? { readback_verified: input.readback_verified } : {}),
    result_kind: input.result_kind || 'partial',
    op_class: input.op_class || 'modify',
    files: files.slice(0, 50).map(f => ({
      file: f.file,
      status: f.status || 'written',
      hashes: { pre: f.pre_file_hash || null, intended: f.intended_file_hash || null, result: f.result_file_hash || null },
    })),
    files_omitted: Math.max(0, files.length - 50),
    index_sync: input.index_sync || { state: 'unknown', note: 'index sync status not reported by this path' },
    ...(input.recovery ? { recovery: input.recovery } : {}),
    ...(input.partial_failures ? { partial_failures: input.partial_failures } : {}),
    ...(input.rolled_back ? { rolled_back: input.rolled_back } : {}),
    ...(input.undo ? { undo: input.undo } : {}),
    ...(input.txn_id ? { txn_id: input.txn_id } : {}),
    limitations: [
      ...(input.limitations || []),
      readback,
    ],
  }
}
