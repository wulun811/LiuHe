// outlet-schema.js — 保底出口（invoke_capability）保守子集 schema 校验（R06，0.5.10 审核修复）。
// 原则：只查「确定性问题」——声明了 type 的原始类型不符、声明了 enum 的值不在集合；未知关键字一律忽略；
// 无 type（anyOf/oneOf 等）跳过；undefined/null 视为未提供。宁漏勿错：44 项语料零误报是硬门槛。
export function validateArgsConservative(schema, args) {
  if (!schema || typeof schema !== 'object') return null
  const props = schema.properties
  if (!props || typeof props !== 'object') return null
  const problems = []
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const k of Object.keys(args)) {
      const s = props[k]
      if (!s || typeof s !== 'object') continue
      const v = args[k]
      if (v === undefined || v === null) continue
      const t = s.type
      if (t === 'string' && typeof v !== 'string') problems.push({ kind: 'type_mismatch', arg: k, expected: 'string', got: typeof v })
      else if (t === 'number' && typeof v !== 'number') problems.push({ kind: 'type_mismatch', arg: k, expected: 'number', got: typeof v })
      else if (t === 'boolean' && typeof v !== 'boolean') problems.push({ kind: 'type_mismatch', arg: k, expected: 'boolean', got: typeof v })
      else if (t === 'array' && !Array.isArray(v)) problems.push({ kind: 'type_mismatch', arg: k, expected: 'array', got: typeof v })
      else if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) problems.push({ kind: 'type_mismatch', arg: k, expected: 'object', got: typeof v })
      if (Array.isArray(s.enum) && s.enum.length > 0 && !s.enum.includes(v)) problems.push({ kind: 'enum_mismatch', arg: k, allowed: s.enum.slice(0, 12) })
    }
  }
  return problems.length ? problems : null
}
