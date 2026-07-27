#!/usr/bin/env python3
"""
batch_edit_test.py - 边界用例测试

基于专家报告的 12 个测试场景
"""

import os
import json
import tempfile
from batch_edit_mvp import batch_edit


def create_test_file(content: str) -> str:
    """创建临时测试文件"""
    fd, path = tempfile.mkstemp(suffix='.txt')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(content)
    return path


def cleanup(path: str):
    """清理临时文件"""
    if os.path.exists(path):
        os.remove(path)


def test_t01_content_override():
    """T01: 案例 A - 内容覆盖（两个独立的 51%）"""
    content = """Line 10: Token 节省 51%，质量不降
Line 42: 在 51% 的节省率下"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "Token 节省 51%", "new_string": "Token 节省 75%"},
            {"old_string": "在 51% 的节省率", "new_string": "在 75% 的节省率"}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        assert result["edits_applied"] == 2
        
        with open(path, 'r') as f:
            final = f.read()
        assert "Token 节省 75%" in final
        assert "在 75% 的节省率" in final
        print("✓ T01: 内容覆盖 - 两个独立的 51% 互不干扰")
    finally:
        cleanup(path)


def test_t02_position_shift():
    """T02: 案例 B - 位置偏移（插入多行）"""
    content = """Line 1
Line 2
Line 3
Line 4
Line 5"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "Line 1", "new_string": "Line 1\nInserted A\nInserted B\nInserted C"},
            {"old_string": "Line 5", "new_string": "Line 5 modified"}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        assert "Inserted A" in final
        assert "Inserted B" in final
        assert "Inserted C" in final
        assert "Line 5 modified" in final
        print("✓ T02: 位置偏移 - 插入多行不影响后续 edit")
    finally:
        cleanup(path)


def test_t03_cascade_creation():
    """T03: 案例 C - 级联创建（原始已有目标）"""
    content = """function foo() {
function bar() {"""
    
    path = create_test_file(content)
    try:
        # LLM 想把 foo 改成 bar，再把 bar 改成 baz
        # 但原始文件中已经有 bar
        edits = [
            {"old_string": "function foo()", "new_string": "function bar()"},
            {"old_string": "function bar()", "new_string": "function baz()"}  # 这会匹配到原始的 bar，不是 edit_1 创建的
        ]
        result = batch_edit(path, edits)
        
        # 这个 case 应该成功，但结果是：
        # - Line 1: function foo() → function bar() (edit_1)
        # - Line 2: function bar() → function baz() (edit_2 匹配原始 bar)
        # 最终：Line 1 = bar, Line 2 = baz
        # 这不是 LLM 的意图（它可能想让 Line 1 也变成 baz）
        
        # 但算法行为是正确的（基于原始快照）
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        # 验证：Line 1 变成 bar（edit_1），Line 2 变成 baz（edit_2 匹配原始 bar）
        lines = final.strip().split('\n')
        assert "function bar()" in lines[0], f"Line 1 should be bar(), got: {lines[0]}"
        assert "function baz()" in lines[1], f"Line 2 should be baz(), got: {lines[1]}"
        print("⚠ T03: 级联创建 - 算法基于原始快照，两个 edit 独立匹配不同的原始文本")
    finally:
        cleanup(path)


def test_t03b_chain_same_position():
    """T03b: 案例 C - 链式替换同一位置"""
    content = """function foo() {"""
    
    path = create_test_file(content)
    try:
        # edit_1 把 foo 改成 bar，edit_2 想基于 edit_1 的结果再改
        edits = [
            {"old_string": "function foo()", "new_string": "function bar()"},
            {"old_string": "function bar()", "new_string": "function baz()"}  # 原始文件中没有 bar
        ]
        result = batch_edit(path, edits)
        
        # edit_2 应该 not_found（原始文件中没有 "function bar()"）
        assert not result["success"], "Expected failure"
        assert result["error_type"] == "not_found"
        print("✓ T03b: 链式替换 - 正确报 not_found（不能依赖其他 edit 的结果）")
    finally:
        cleanup(path)


def test_t04_cross_line():
    """T04: 跨行匹配 - 多行函数签名"""
    content = """def calculateTotal(
    items: list,
    discount: float
) -> float:
    pass"""
    
    path = create_test_file(content)
    try:
        edits = [
            {
                "old_string": "def calculateTotal(\n    items: list,\n    discount: float\n) -> float:",
                "new_string": "def calculateTotal(\n    items: list,\n    discount: float,\n    tax: float\n) -> float:"
            }
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        assert "tax: float" in final
        print("✓ T04: 跨行匹配 - 多行函数签名")
    finally:
        cleanup(path)


def test_t05_conflict_detection():
    """T05: 冲突检测 - 重叠区域"""
    content = """hello world"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "hello", "new_string": "hi"},
            {"old_string": "hello world", "new_string": "goodbye"}  # 与 edit_1 重叠
        ]
        result = batch_edit(path, edits)
        
        assert not result["success"], "Expected failure"
        assert result["error_type"] == "conflict"
        print("✓ T05: 冲突检测 - 重叠区域")
    finally:
        cleanup(path)


def test_t06_ambiguous_detection():
    """T06: 唯一性检测 - 多次出现"""
    content = """hello world
hello world
hello world"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "hello world", "new_string": "hi there"}
        ]
        result = batch_edit(path, edits)
        
        assert not result["success"], "Expected failure"
        assert result["error_type"] == "ambiguous"
        # 检查返回了所有匹配位置
        assert len(result["results"]) > 0
        r = result["results"][0]
        assert r.all_matches is not None or "matches 3 locations" in str(r)
        assert len(r.all_matches) == 3
        print("✓ T06: 唯一性检测 - 多次出现，返回 3 个匹配位置")
    finally:
        cleanup(path)


def test_t07_adjacent_no_conflict():
    """T07: 相邻不冲突 - end == start"""
    content = """abc"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "a", "new_string": "x"},
            {"old_string": "b", "new_string": "y"}  # 与 edit_1 相邻但不重叠
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        assert final == "xyc"
        print("✓ T07: 相邻不冲突 - end == start")
    finally:
        cleanup(path)


def test_t08_empty_insert():
    """T08: 空字符串插入"""
    content = """hello"""
    
    path = create_test_file(content)
    try:
        # 禁止空 old_string
        edits = [
            {"old_string": "", "new_string": "prefix "}
        ]
        result = batch_edit(path, edits)
        
        assert not result["success"], "Expected failure"
        assert "old_string cannot be empty" in str(result)
        print("✓ T08: 空字符串 - 正确禁止空 old_string")
    finally:
        cleanup(path)


def test_t09_delete():
    """T09: 删除操作"""
    content = """hello world"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "hello ", "new_string": ""}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        assert final == "world"
        print("✓ T09: 删除操作 - new_string 为空")
    finally:
        cleanup(path)


def test_t10_crlf_preserve():
    """T10: CRLF 保留"""
    content = "line1\r\nline2\r\nline3"
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "line2", "new_string": "LINE2"}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'rb') as f:
            final_bytes = f.read()
        # 检查 CRLF 是否保留
        assert b"\r\n" in final_bytes, "CRLF should be preserved"
        print("✓ T10: CRLF 保留 - 换行符风格保留")
    finally:
        cleanup(path)


def test_t11_large_file():
    """T11: 大文件性能"""
    # 生成 ~276KB 文件，确保 old_string 唯一
    lines = [f"line_{i:05d}_{'x' * 80}" for i in range(2700)]
    content = "\n".join(lines)
    
    path = create_test_file(content)
    try:
        import time
        start = time.time()
        
        # 匹配一个唯一的字符串
        edits = [
            {"old_string": "line_01350_" + "x" * 80, "new_string": "REPLACED_" + "y" * 80}
        ]
        result = batch_edit(path, edits)
        
        elapsed = time.time() - start
        assert result["success"], f"Expected success, got: {result}"
        
        file_size = len(content.encode('utf-8'))
        print(f"✓ T11: 大文件性能 - {file_size/1024:.1f}KB / {elapsed*1000:.2f}ms")
    finally:
        cleanup(path)


def test_t12_complex_markdown():
    """T12: 真实 Markdown 复杂编辑"""
    content = """# Title

```python
def foo():
    x = 1
    y = 2
    return x + y
```

| Method | F1 | Token |
|--------|:--:|:-----:|
| Pull   | 0.65 | 24K |

- Item 1
- Item 2
- Item 3"""
    
    path = create_test_file(content)
    try:
        edits = [
            # 跨行函数替换
            {
                "old_string": "def foo():\n    x = 1\n    y = 2\n    return x + y",
                "new_string": "def bar():\n    a = 10\n    b = 20\n    return a * b"
            },
            # 表格行替换
            {
                "old_string": "| Pull   | 0.65 | 24K |",
                "new_string": "| Pull   | 0.68 | 23K |"
            },
            # 列表项替换
            {
                "old_string": "- Item 2",
                "new_string": "- Item 2 (modified)"
            }
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        assert result["edits_applied"] == 3
        
        with open(path, 'r') as f:
            final = f.read()
        assert "def bar():" in final
        assert "0.68" in final
        assert "Item 2 (modified)" in final
        print("✓ T12: 真实 Markdown 复杂编辑 - 跨行函数 + 表格 + 列表")
    finally:
        cleanup(path)


def test_t13_chain_replacement_constraint():
    """T13: 不支持链式替换 - 验证 A→B→C 时 B→C not_found"""
    content = """function foo() {"""
    
    path = create_test_file(content)
    try:
        # A→B→C 链式替换：原始文件中只有 "function foo()"
        # edit_1 把 foo 改成 bar（成功，原始文件中有 foo）
        # edit_2 把 bar 改成 baz（失败，原始文件中没有 bar）
        edits = [
            {"old_string": "function foo()", "new_string": "function bar()"},
            {"old_string": "function bar()", "new_string": "function baz()"}
        ]
        result = batch_edit(path, edits)
        
        # edit_2 应该 not_found（原始文件中没有 "function bar()"）
        assert not result["success"], "Expected failure for chained replacement"
        assert result["error_type"] == "not_found"
        print("✓ T13: 链式替换约束 - A→B→C 不支持，B→C 正确报 not_found")
    finally:
        cleanup(path)


def test_t14_replace_all():
    """T14: replace_all=true 全局替换"""
    content = """hello world
hello world
hello world"""
    
    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "world", "new_string": "there", "replace_all": True}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success, got: {result}"
        
        with open(path, 'r') as f:
            final = f.read()
        assert final.count("there") == 3
        assert "world" not in final
        print("✓ T14: replace_all 全局替换 - 3 处全部替换")
    finally:
        cleanup(path)


def test_t15_error_aggregation():
    """T15: 错误聚合 - 多个错误一次性返回"""
    content = """foo
hello world
say hello to everyone"""
    
    path = create_test_file(content)
    try:
        # 提交 4 个 edits，其中多个有错误
        edits = [
            {"old_string": "foo", "new_string": "FOO"},              # OK
            {"old_string": "hello world", "new_string": "hi"},       # OK
            {"old_string": "nonexistent", "new_string": "X"},        # not_found
            {"old_string": "hello", "new_string": "HELLO"},          # ambiguous（出现 2 次）
        ]
        result = batch_edit(path, edits)
        
        assert not result["success"], "Expected failure"
        # 应该同时包含 not_found 和 ambiguous
        assert "not_found" in result.get("error_type", "")
        assert "ambiguous" in result.get("error_type", "")
        # 应该有 error_summary
        assert result.get("error_summary") is not None
        # 检查错误数
        error_count = sum(1 for r in result["results"] if hasattr(r, 'status') and r.status in ("not_found", "ambiguous"))
        assert error_count == 2, f"Expected 2 errors, got {error_count}"
        print("✓ T15: 错误聚合 - 同时返回 not_found 和 ambiguous")
    finally:
        cleanup(path)


def test_t16_whitespace_trailing():
    """T16: 空白容错 - 行尾空格差异自动归一化"""
    content = """Line 1: hello world
Line 2: goodbye world"""

    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "hello world ", "new_string": "hi there"}  # trailing space
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success with trailing whitespace, got: {result}"
        with open(path, 'r') as f:
            final = f.read()
        assert "hi there" in final
        assert "hello world" not in final
        print("✓ T16: 空白容错 - 行尾空格差异自动归一化")
    finally:
        cleanup(path)


def test_t17_whitespace_trailing_eol():
    """T17: 空白容错 - 多行行尾空格"""
    content = """def foo():   
    return 42   
    """

    path = create_test_file(content)
    try:
        edits = [
            {"old_string": "def foo():", "new_string": "def bar():"},
            {"old_string": "return 42", "new_string": "return 0"}
        ]
        result = batch_edit(path, edits)
        assert result["success"], f"Expected success with EOL whitespace, got: {result}"
        with open(path, 'r') as f:
            final = f.read()
        assert "def bar():" in final
        assert "return 0" in final
        print("✓ T17: 空白容错 - 多行行尾空格环境正常匹配")
    finally:
        cleanup(path)


def run_all_tests():
    """运行所有测试"""
    print("=" * 60)
    print("批量编辑工具 MVP - 边界用例测试")
    print("=" * 60)
    print()
    
    tests = [
        test_t01_content_override,
        test_t02_position_shift,
        test_t03_cascade_creation,
        test_t03b_chain_same_position,
        test_t04_cross_line,
        test_t05_conflict_detection,
        test_t06_ambiguous_detection,
        test_t07_adjacent_no_conflict,
        test_t08_empty_insert,
        test_t09_delete,
        test_t10_crlf_preserve,
        test_t11_large_file,
        test_t12_complex_markdown,
        test_t13_chain_replacement_constraint,
        test_t14_replace_all,
        test_t15_error_aggregation,
        test_t16_whitespace_trailing,
        test_t17_whitespace_trailing_eol,
    ]
    
    passed = 0
    failed = 0
    
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"✗ {test.__name__}: {e}")
            failed += 1
    
    print()
    print("=" * 60)
    print(f"结果: {passed} 通过, {failed} 失败")
    print("=" * 60)
    
    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    exit(0 if success else 1)
