// 码龙 — hash 工具（原语化 P1：版本锚点）
// 附录 C：file.hash / symbol.body_hash = 原始字节 SHA-256（裁决用原始）
// normalized_hash 仅供 patch normalized 匹配，不改文件风格

import { createHash } from 'node:crypto'

export function sha256(input) {
  if (typeof input === 'string') return createHash('sha256').update(input, 'utf-8').digest('hex')
  return createHash('sha256').update(input).digest('hex')
}

export function bodyHash(text) {
  return sha256(text)
}

export function signatureHash(signatureText) {
  return sha256(signatureText)
}
