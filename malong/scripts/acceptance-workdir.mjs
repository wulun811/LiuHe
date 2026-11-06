// acceptance-workdir.mjs — 验收脚本的测试根目录守卫（R20-F01）
//
// 背景（专家 R20-F01，P1）：旧实现解析 --workdir 后直接
// `rmSync(ROOT, { recursive: true, force: true })`。误传真实工作目录 =
// 不可恢复的数据删除。审查人实测：在自建目录里放 keep.txt，跑脚本后文件没了。
//
// 本模块的判据（硬拒绝，不是软警告）：
//   1. 不传 --workdir → 用 mkdtemp 建全新唯一目录，天然不可能撞上既有数据
//   2. 传了 --workdir → 目标必须【事先不存在】；已存在即拒绝（exit 2），不删不碰
//   3. 传了 --workdir 且父目录不存在 → 拒绝（避免在意外位置凭空建树）
//   4. 拒绝时不递归删除任何东西，只在 stderr 说明原因与正确用法
//   5. 清理只针对本次自己创建的目录（createdByUs 标记），并对它做身份复核
//
// 为什么不用「父目录可信 + 目标不存在」的双条件：判据越少越不易被绕过。
// 「目标必须不存在」一条就足以防止删既有数据——既有目录根本走不到删除逻辑。

import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import os from 'node:os'

export class WorkdirRefused extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkdirRefused'
    this.code = 'WORKDIR_REFUSED'
  }
}

/**
 * 解析并准备测试根目录。
 *
 * @param {string|undefined} explicit --workdir 的原始值（未传则 undefined）
 * @param {string} prefix             mkdtemp 用的前缀（如 'accept-slice-'）
 * @returns {{ root: string, createdByUs: boolean, dispose: () => void }}
 * @throws {WorkdirRefused} 拒绝场景；调用方应 exit 2 而不是继续
 */
export function prepareWorkdir(explicit, prefix = 'malong-accept-') {
  const base = join(os.tmpdir(), 'opencode')

  if (explicit == null || explicit === '') {
    // 常规路径：全新唯一目录。mkdtemp 自带 6 位随机后缀且保证不存在。
    try {
      const root = mkdtempSync(join(base, prefix))
      return { root: resolve(root), createdByUs: true, dispose: makeDisposer(root) }
    } catch {
      // temp 父目录可能不存在 → 建一次再试（仍然只创建，不删除）
      const root = mkdtempSync(join(os.tmpdir(), prefix))
      return { root: resolve(root), createdByUs: true, dispose: makeDisposer(root) }
    }
  }

  const want = resolve(String(explicit))

  // 判据 2：目标已存在 → 硬拒绝。这一条拦住「误传真实工作目录」的全部风险，
  // 因为既有目录根本不会进入任何 rm 路径。
  if (existsSync(want)) {
    throw new WorkdirRefused(
      `--workdir 目标已存在，拒绝执行：${want}\n` +
      `  验收脚本会删除它自己的工作目录，因此不接受既有路径（防止误删真实目录）。\n` +
      `  请二选一：\n` +
      `    a) 省略 --workdir，脚本自行创建临时目录；\n` +
      `    b) 传一个【尚不存在】的路径，例如 ${want}-$(date +%s)`
    )
  }

  // 判据 3：父目录必须已存在。避免在拼错的位置凭空建出一整棵树。
  const parent = dirname(want)
  if (!existsSync(parent)) {
    throw new WorkdirRefused(
      `--workdir 的父目录不存在，拒绝执行：${parent}\n` +
      `  本脚本只创建最后一层测试目录，不替你在意外位置建树。`
    )
  }
  let parentStat
  try {
    parentStat = statSync(parent)
  } catch (e) {
    throw new WorkdirRefused(`--workdir 父目录无法访问，拒绝执行：${parent}（${e.code || e.message}）`)
  }
  if (!parentStat.isDirectory()) {
    throw new WorkdirRefused(`--workdir 的父路径不是目录，拒绝执行：${parent}`)
  }

  // 走到这里：目标不存在、父目录是真实目录 → 创建。
  // 用非递归 mkdir：若期间被别的进程抢先创建，抛 EEXIST 而不是静默接管别人的目录。
  try {
    mkdirSync(want)
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new WorkdirRefused(
        `--workdir 目标在检查后被创建，拒绝接管：${want}\n` +
        `  本脚本从不复用既有目录（可能是别人正在用的）。`
      )
    }
    throw new WorkdirRefused(`--workdir 创建失败：${want}（${e.code || e.message}）`)
  }
  return { root: want, createdByUs: true, dispose: makeDisposer(want) }
}

/**
 * 供验收脚本统一调用的入口：拒绝时打印原因并给出 exit code 2。
 * @returns {{ ok: true, root: string, dispose: () => void } | { ok: false, code: 2 }}
 */
export function prepareWorkdirOrExit(explicit, prefix = 'malong-accept-') {
  try {
    const ctx = prepareWorkdir(explicit, prefix)
    return { ok: true, root: ctx.root, dispose: ctx.dispose }
  } catch (e) {
    if (e instanceof WorkdirRefused) {
      console.error('拒绝执行：' + e.message)
      return { ok: false, code: 2 }
    }
    throw e
  }
}

function makeDisposer(root) {
  return () => {
    // 清理前复核：只删自己创建的、且确实是目录的路径。
    // realpath 对比可挡住「创建后被换成指向他处的符号链接」这类替换。
    try {
      const real = realpathSync(root)
      const expected = resolve(root)
      if (real !== expected) return // 被替换成软链 → 不动
      rmSync(real, { recursive: true, force: true })
    } catch {
      // 已不存在 / 无权限 → 清不掉就算了，不抛（清理失败不该把通过变成失败）
    }
  }
}
