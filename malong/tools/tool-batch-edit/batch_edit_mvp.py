#!/usr/bin/env python3
"""
batch_edit_mvp.py - 批量编辑工具 MVP

工具描述：
    批量编辑工具，用于在单个文件中进行多次替换。
    文件必须先被查看才能编辑（由框架强制）。
    所有 old_string 都基于原始文件内容匹配。
    每个 old_string 必须在文件中唯一匹配（除非 replace_all=true）。

使用约束：
    - 文件必须先被 view 过（由 opencode 框架强制执行）
    - 所有 edits 基于原始文件快照，不依赖其他 edit 的结果
    - 每个 old_string 必须在文件中唯一匹配，否则返回 ambiguous 错误（除非 replace_all=true）
    - edits 之间不能有重叠的字符范围，否则返回 conflict 错误
    - 不支持链式替换（A→B→C）。如需链式替换，请在单条 edit 中完成（A→C）

核心算法：
1. 加载整个文件到内存
2. 字符级匹配 old_string（支持跨行）
3. 检查唯一性（必须恰好匹配一次，或 replace_all=true）
4. 检查冲突（不能有重叠的字符范围）
5. 按位置倒序应用 edits（避免位置偏移）
6. 原子写入（全有或全无）
7. 自动备份（--backup 选项）

用法：
    python batch_edit_mvp.py <file> <edits_json> [--dry-run] [--backup] [--edits-file <path>]

edits_json 格式：
    [
        {"old_string": "...", "new_string": "...", "replace_all": false},
        {"old_string": "...", "new_string": "..."}
    ]

选项：
    --dry-run        预览模式，输出 unified diff
    --backup         自动备份原文件（file.bak）
    --edits-file     从文件读取 edits JSON（避免 shell 转义问题）

错误类型：
    - not_found: old_string 在文件中不存在（含相似匹配建议）
    - ambiguous: old_string 匹配多个位置（返回所有匹配位置）
    - conflict: 多个 edits 有重叠的字符范围
"""

import sys
import json
import difflib
import os
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict


@dataclass
class Edit:
    old_string: str
    new_string: str
    index: int  # 原始顺序
    replace_all: bool = False  # 是否替换所有匹配


@dataclass
class Match:
    edit: Edit
    start: int  # 字符偏移
    end: int    # 字符偏移（exclusive）
    start_line: int  # 行号（1-indexed）
    start_col: int   # 列号（1-indexed）


@dataclass
class EditResult:
    edit_index: int
    status: str  # "success" | "not_found" | "ambiguous" | "conflict"
    start_line: Optional[int] = None
    start_col: Optional[int] = None
    message: Optional[str] = None
    all_matches: Optional[List[Dict]] = None  # ambiguous 时返回所有匹配位置
    warnings: Optional[List[str]] = None  # 警告信息


def offset_to_line_col(content: str, offset: int) -> Tuple[int, int]:
    """将字符偏移转换为行号和列号"""
    line = content[:offset].count('\n') + 1
    last_newline = content.rfind('\n', 0, offset)
    col = offset - last_newline if last_newline >= 0 else offset + 1
    return line, col


def find_matches_lenient(content: str, old_string: str) -> Tuple[List[int], str, str]:
    positions = find_all_matches(content, old_string)
    if positions:
        return positions, old_string, "exact"

    normalized = old_string.rstrip()
    if normalized != old_string:
        positions = find_all_matches(content, normalized)
        if positions:
            return positions, normalized, "trailing_whitespace_stripped"

    return [], old_string, "no_match"


def find_all_matches(content: str, old_string: str) -> List[int]:
    """找到 old_string 在 content 中的所有匹配位置（字符偏移）"""
    matches = []
    start = 0
    while True:
        pos = content.find(old_string, start)
        if pos == -1:
            break
        matches.append(pos)
        start = pos + 1
    return matches


def check_conflicts(matches: List[Match]) -> Optional[Dict]:
    """
    检查是否有冲突（重叠的字符范围）
    返回包含冲突详情的 dict，无冲突返回 None
    """
    sorted_matches = sorted(matches, key=lambda m: m.start)

    for i in range(len(sorted_matches) - 1):
        m1 = sorted_matches[i]
        m2 = sorted_matches[i + 1]
        if m1.end > m2.start:
            return {
                "idx1": m1.edit.index,
                "idx2": m2.edit.index,
                "start1": m1.start,
                "end1": m1.end,
                "start2": m2.start,
                "end2": m2.end,
                "line1": m1.start_line,
                "line2": m2.start_line,
                "m1_replace_all": m1.edit.replace_all,
                "m2_replace_all": m2.edit.replace_all,
            }

    return None


def apply_edits(content: str, matches: List[Match]) -> str:
    """
    应用 edits（按位置倒序，避免位置偏移）
    """
    # 按 start 倒序排序
    sorted_matches = sorted(matches, key=lambda m: m.start, reverse=True)
    
    result = content
    for match in sorted_matches:
        # 替换 [start, end) 区间
        result = result[:match.start] + match.edit.new_string + result[match.end:]
    
    return result


def find_similar_match(content: str, old_string: str, max_lines: int = 3) -> Optional[Dict]:
    """
    当 old_string 找不到时，尝试找到相似的匹配（基于编辑距离 ≤ 2）
    搜索策略：在文件内容中找包含 old_string 前 10 个字符的行
    """
    if len(old_string) < 3:
        return None
    
    # 搜索包含 old_string 前缀的行
    prefix = old_string[:10]
    lines = content.split('\n')
    candidates = []
    
    for i, line in enumerate(lines):
        if prefix in line:
            # 计算相似度（编辑距离）
            ratio = difflib.SequenceMatcher(None, old_string, line.strip()).ratio()
            candidates.append((ratio, i + 1, line.strip()))
    
    if not candidates:
        return None
    
    # 按相似度排序，取最佳
    candidates.sort(key=lambda x: -x[0])
    best_ratio, best_line, best_content = candidates[0]
    
    if best_ratio > 0.5:
        return {"match": best_content[:80], "line": best_line, "ratio": round(best_ratio, 2)}
    
def visualize_whitespace_diff(content: str, old_string: str) -> Optional[Dict]:
    if len(old_string) < 2:
        return None

    lines = content.split('\n')
    candidates = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        ratio = difflib.SequenceMatcher(None, old_string, line).ratio()
        candidates.append((ratio, i + 1, line))

    if not candidates:
        return None

    candidates.sort(key=lambda x: -x[0])
    best_ratio, best_line, best_content = candidates[0]

    if best_ratio < 0.3:
        return None

    def vis(text: str) -> str:
        return text[:80].replace(' ', '\u00b7').replace('\t', '\u2192')

    return {
        "old_visualized": vis(old_string),
        "file_visualized": vis(best_content),
        "line": best_line
    }


# Unicode confusable characters
UNICODE_CONFUSABLES = {
    '\u201c': ('"', 'LEFT DOUBLE QUOTATION MARK \u201c'),
    '\u201d': ('"', 'RIGHT DOUBLE QUOTATION MARK \u201d'),
    '\u2018': ("'", 'LEFT SINGLE QUOTATION MARK \u2018'),
    '\u2019': ("'", 'RIGHT SINGLE QUOTATION MARK \u2019'),
    '\u2013': ('-', 'EN DASH \u2013'),
    '\u2014': ('-', 'EM DASH \u2014'),
    '\u00a0': (' ', 'NON-BREAKING SPACE'),
    '\u00ab': ('\u00ab', 'LEFT GUILLEMET \u00ab'),
    '\u00bb': ('\u00bb', 'RIGHT GUILLEMET \u00bb'),
    '\u3001': (',', 'IDEOGRAPHIC COMMA \u3001'),
    '\u3002': ('.', 'IDEOGRAPHIC FULL STOP \u3002'),
    '\uff01': ('!', 'FULLWIDTH EXCLAMATION \uff01'),
    '\uff0c': (',', 'FULLWIDTH COMMA \uff0c'),
    '\uff0e': ('.', 'FULLWIDTH FULL STOP \uff0e'),
    '\uff1a': (':', 'FULLWIDTH COLON \uff1a'),
    '\uff1b': (';', 'FULLWIDTH SEMICOLON \uff1b'),
    '\uff1f': ('?', 'FULLWIDTH QUESTION \uff1f'),
}


def detect_unicode_mismatch(content: str, old_string: str) -> Optional[Dict]:
    if len(old_string) < 2:
        return None

    lines = content.split('\n')
    candidates = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        ratio = difflib.SequenceMatcher(None, old_string, line).ratio()
        candidates.append((ratio, i + 1, line))

    if not candidates:
        return None

    candidates.sort(key=lambda x: -x[0])
    best_ratio, best_line, best_content = candidates[0]

    if best_ratio < 0.3:
        return None

    mismatches = []
    has_confusable = False
    sm = difflib.SequenceMatcher(None, old_string, best_content)

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue

        old_part = old_string[i1:i2]
        file_part = best_content[j1:j2]

        if tag == 'replace':
            min_len = min(len(old_part), len(file_part))
            for k in range(min_len):
                oc = old_part[k]
                fc = file_part[k]
                if oc == fc:
                    continue
                oc_info = UNICODE_CONFUSABLES.get(oc)
                fc_info = UNICODE_CONFUSABLES.get(fc)
                if oc_info and oc_info[0] == fc:
                    mismatches.append(f"pos {i1+k}: your '{oc}' is {oc_info[1]}, should be plain '{fc}' U+{ord(fc):04X}")
                    has_confusable = True
                elif fc_info and fc_info[0] == oc:
                    mismatches.append(f"pos {i1+k}: file has '{fc}' ({fc_info[1]}), your old_string uses plain '{oc}'")
                    has_confusable = True
                elif oc_info and fc_info and oc_info[0] == fc_info[0]:
                    mismatches.append(f"pos {i1+k}: your '{oc}' ({oc_info[1]}) vs file '{fc}' ({fc_info[1]})")
                    has_confusable = True
            if len(old_part) > len(file_part):
                extra = old_part[min_len:]
                mismatches.append(f"pos {i1+min_len}: your extra '{extra}' not in file")
            elif len(file_part) > len(old_part):
                extra = file_part[min_len:]
                mismatches.append(f"pos {i1+min_len}: file has extra '{extra}' not in your old_string")
        elif tag == 'insert':
            mismatches.append(f"pos {i1}: file has '{file_part[:20]}' not in your old_string")
        elif tag == 'delete':
            mismatches.append(f"pos {i1}: your '{old_part[:20]}' not in file")

    if not mismatches or not has_confusable:
        return None

    return {
        'line': best_line,
        'mismatches': mismatches,
    }


def generate_diff(original: str, modified: str, file_path: str) -> str:
    """生成 unified diff"""
    original_lines = original.splitlines(keepends=True)
    modified_lines = modified.splitlines(keepends=True)
    
    diff = difflib.unified_diff(
        original_lines,
        modified_lines,
        fromfile=f"a/{os.path.basename(file_path)}",
        tofile=f"b/{os.path.basename(file_path)}",
        lineterm=''
    )
    
    return ''.join(diff)


class EditResultEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles dataclass instances and additional types."""
    def default(self, obj):
        if isinstance(obj, (EditResult, Match)):
            return asdict(obj)
        return super().default(obj)


def serialize_result(result: Dict) -> Dict:
    """递归将结果中的 dataclass 实例转换为 dict"""
    serialized = {}
    for k, v in result.items():
        if isinstance(v, EditResult):
            serialized[k] = asdict(v)
        elif isinstance(v, list) and v and isinstance(v[0], EditResult):
            serialized[k] = [asdict(item) for item in v]
        else:
            serialized[k] = v
    return serialized

def batch_edit(file_path: str, edits_data: List[Dict], dry_run: bool = False, backup: bool = False, partial: bool = False) -> Dict:
    """
    批量编辑主函数
    
    返回：
    {
        "success": bool,
        "edits_applied": int,
        "final_content": str (if success and not dry_run),
        "results": [EditResult, ...]
    }
    """
    # 读取文件（保留原始换行符）
    try:
        with open(file_path, 'r', encoding='utf-8', newline='') as f:
            original_content = f.read()
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to read file: {e}",
            "edits_applied": 0,
            "results": []
        }
    
    # 解析 edits
    edits = []
    for i, edit_dict in enumerate(edits_data):
        old_string = edit_dict.get("old_string", "")
        new_string = edit_dict.get("new_string", "")
        
        # 检查空 old_string
        if not old_string:
            return {
                "success": False,
                "error": f"Edit {i}: old_string cannot be empty",
                "edits_applied": 0,
                "results": [EditResult(i, "error", message="old_string cannot be empty")]
            }
        
        replace_all = edit_dict.get("replace_all", False)
        edits.append(Edit(old_string, new_string, i, replace_all))
    
    # 匹配阶段：在原始内容上独立匹配每个 edit，收集所有错误
    matches = []
    results = []
    errors = []
    
    for edit in edits:
        all_positions, matched_old, match_mode = find_matches_lenient(original_content, edit.old_string)

        if len(all_positions) == 0:
            suggestion = find_similar_match(original_content, edit.old_string)
            ws_diff = visualize_whitespace_diff(original_content, edit.old_string)
            unicode_diff = detect_unicode_mismatch(original_content, edit.old_string)

            msg = "old_string not found in file"
            if ws_diff:
                msg += (f"\n  Whitespace diff (\u00b7=space, \u2192=tab):\n"
                        f"  Your old_string: {ws_diff['old_visualized']}\n"
                        f"  File around L{ws_diff['line']}: {ws_diff['file_visualized']}")
            if unicode_diff:
                msg += f"\n  Unicode character encoding mismatch at line {unicode_diff['line']}:"
                for m in unicode_diff['mismatches']:
                    msg += f"\n    {m}"
            if suggestion:
                msg += f"\n  Did you mean: '{suggestion['match']}' at line {suggestion['line']}?"
            errors.append(EditResult(
                edit_index=edit.index,
                status="not_found",
                message=msg
            ))

        elif len(all_positions) > 1 and not edit.replace_all:
            all_matches_info = []
            for pos in all_positions:
                line, col = offset_to_line_col(original_content, pos)
                context_start = max(0, pos - 50)
                context_end = min(len(original_content), pos + len(matched_old) + 50)
                context = original_content[context_start:context_end].replace('\n', ' ')
                all_matches_info.append({
                    "line": line,
                    "column": col,
                    "context": f"...{context}..."
                })

            errors.append(EditResult(
                edit_index=edit.index,
                status="ambiguous",
                message=f"old_string matches {len(all_positions)} locations. "
                        f"Set replace_all=true to replace all, or refine old_string.",
                all_matches=all_matches_info
            ))

        else:
            warnings = None
            if match_mode != "exact":
                warnings = [f"Matched via '{match_mode}' (original: '{edit.old_string}', actual: '{matched_old}')"]

            for pos in all_positions:
                line, col = offset_to_line_col(original_content, pos)
                match = Match(
                    edit=edit,
                    start=pos,
                    end=pos + len(matched_old),
                    start_line=line,
                    start_col=col
                )
                matches.append(match)

            results.append(EditResult(
                edit_index=edit.index,
                status="matched",
                start_line=line,
                start_col=col,
                warnings=warnings
            ))
    
    # 如果有错误，一次性返回全部（错误聚合）
    if errors:
        if partial and matches:
            # partial 模式：成功的写入，失败的返回让 LLM 修
            conflict = check_conflicts(matches)
            if conflict:
                skip = {conflict['idx1'], conflict['idx2']}
                matches = [m for m in matches if m.edit.index not in skip]
                errors.append(EditResult(
                    edit_index=-1, status="conflict",
                    message=f"Edit {conflict['idx1']} and {conflict['idx2']} overlap, both skipped in partial mode"
                ))
            if matches:
                final_content = apply_edits(original_content, matches)
                diff = generate_diff(original_content, final_content, file_path)
                if not dry_run:
                    if backup:
                        import shutil
                        shutil.copy2(file_path, file_path + '.bak')
                    with open(file_path, 'w', encoding='utf-8', newline='') as f:
                        f.write(final_content)
                applied_indices = sorted(set(m.edit.index for m in matches))
                failed_indices = sorted(e.edit_index for e in errors if e.edit_index >= 0)
                retry_edits = [edits_data[i] for i in failed_indices if i < len(edits_data)]
                for r in results:
                    if r.status == 'matched':
                        r.status = 'success'
                return {
                    "success": True,
                    "partial": True,
                    "edits_applied": len(matches),
                    "edits_failed": len([e for e in errors if e.edit_index >= 0]),
                    "applied_indices": applied_indices,
                    "failed_indices": failed_indices,
                    "retry_edits": retry_edits,
                    "diff": diff,
                    "results": results + errors,
                }
        error_types = set(e.status for e in errors)
        return {
            "success": False,
            "error_type": "+".join(sorted(error_types)),
            "error_summary": f"{len(errors)} error(s) found across {len(edits)} edits",
            "edits_applied": 0,
            "results": results + errors
        }
    
    # 归一化等价去重：rstrip 后相同的 old_string 匹配到同一位置视为冲突
    seen_norm = {}
    for m in matches:
        norm = edits[m.edit.index].old_string.rstrip()
        key = (norm, m.start)
        if key in seen_norm:
            prev = seen_norm[key]
            results.append(EditResult(
                edit_index=-1,
                status="conflict",
                message=f"Edit {prev} and Edit {m.edit.index} both match "
                        f"'{norm}' at position {m.start} after whitespace normalization"
            ))
            return {
                "success": False,
                "error_type": "conflict",
                "edits_applied": 0,
                "results": results
            }
        seen_norm[key] = m.edit.index

    # 冲突检测
    conflict = check_conflicts(matches)
    if conflict:
        idx1, idx2 = conflict["idx1"], conflict["idx2"]
        parts = []
        if conflict.get("m1_replace_all") or conflict.get("m2_replace_all"):
            r1 = " (replace_all=true)" if conflict["m1_replace_all"] else ""
            r2 = " (replace_all=true)" if conflict["m2_replace_all"] else ""
            parts.append(f"Edit {idx1}{r1} at line {conflict['line1']} and Edit {idx2}{r2} at line {conflict['line2']}")
            parts.append(f"Try making old_string more specific or avoid replace_all when it overlaps other edits")
        else:
            parts.append(f"Edit {idx1} at line {conflict['line1']} and Edit {idx2} at line {conflict['line2']}")
            parts.append(f"Try adjusting old_string or merging related edits into one")

        results.append(EditResult(
            edit_index=-1,
            status="conflict",
            message="; ".join(parts)
        ))
        return {
            "success": False,
            "error_type": "conflict",
            "edits_applied": 0,
            "results": results
        }
    
    # 应用 edits（基于原始快照，不支持链式替换 A→B→C）
    final_content = apply_edits(original_content, matches)
    diff = generate_diff(original_content, final_content, file_path)

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "edits_applied": len(matches),
            "diff": diff,
            "results": results
        }
    else:
        if backup:
            import shutil
            shutil.copy2(file_path, file_path + '.bak')

        try:
            with open(file_path, 'w', encoding='utf-8', newline='') as f:
                f.write(final_content)
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to write file: {e}",
                "edits_applied": 0,
                "results": []
            }

        for r in results:
            if r.status == "matched":
                r.status = "success"

        return {
            "success": True,
            "edits_applied": len(matches),
            "diff": diff,
            "results": results
        }


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Batch edit tool for single-file multiple replacements")
    parser.add_argument("file", help="File to edit")
    parser.add_argument("edits_json", nargs="?", default=None,
                        help='JSON array of edits: \'[{"old_string": "...", "new_string": "..."}]\'')
    parser.add_argument("--edits-file", type=str, default=None,
                        help="Read edits from a JSON file (alternative to edits_json argument)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview changes as unified diff, don't apply")
    parser.add_argument("--backup", action="store_true",
                        help="Create .bak backup before writing")
    parser.add_argument("--partial", action="store_true",
                        help="Apply successful edits even if some fail")
    
    args = parser.parse_args()
    
    # 读取 edits
    if args.edits_file:
        try:
            with open(args.edits_file, 'r', encoding='utf-8') as f:
                edits_data = json.load(f)
        except Exception as e:
            print(f"Error reading edits file: {e}")
            sys.exit(1)
    elif args.edits_json:
        try:
            edits_data = json.loads(args.edits_json)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON: {e}")
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)
    
    result = batch_edit(args.file, edits_data, dry_run=args.dry_run, backup=args.backup, partial=args.partial)
    
    # 输出：JSON 到 stdout，状态到 stderr
    print(json.dumps(result, indent=2, ensure_ascii=False, cls=EditResultEncoder))

    if result["success"]:
        msg = f"\n\u2713 Applied {result['edits_applied']} edits"
        if args.dry_run:
            msg = f"\n[DRY-RUN] {result['edits_applied']} edits previewed. No changes applied."
        print(msg, file=sys.stderr)
    else:
        print(f"\n\u2717 Failed: {result.get('error_type', result.get('error', 'unknown'))}", file=sys.stderr)
        if result.get("error_summary"):
            print(f"  {result['error_summary']}", file=sys.stderr)
        if result.get("results"):
            for r in result["results"]:
                if hasattr(r, 'status') and r.status in ("not_found", "ambiguous", "conflict"):
                    print(f"  Edit {r.edit_index} [{r.status}]: {r.message}", file=sys.stderr)
                    if hasattr(r, 'all_matches') and r.all_matches:
                        for m in r.all_matches:
                            print(f"    Line {m['line']}: {m['context']}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
