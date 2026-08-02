use serde::{Deserialize, Serialize};
use tree_sitter::Node;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstNode {
    pub node_type: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<AstNode>>,
}

const COMMON_AST_TYPES: &[&str] = &[
    "source_file", "module", "program",
    "function_definition", "function_declaration", "function_item",
    "class_definition", "class_declaration", "struct_item",
    "let_declaration", "variable_declaration",
    "import_statement", "import_from_statement", "import_declaration", "use_declaration",
    "if_statement", "for_statement", "while_statement", "loop_expression",
    "return_statement", "call_expression",
];

pub fn simplify_ast(node: Node, source: &str, depth: u32, max_depth: u32) -> Option<AstNode> {
    if depth > max_depth {
        return None;
    }

    let mut result = AstNode {
        node_type: node.kind().to_string(),
        start_line: node.start_position().row as u32 + 1,
        end_line: node.end_position().row as u32 + 1,
        name: None,
        text: None,
        children: None,
    };

    if let Some(name_field) = node.child_by_field_name("name") {
        result.name = Some(source[name_field.byte_range()].to_string());
    }

    if node.child_count() == 0 || !COMMON_AST_TYPES.contains(&node.kind()) {
        let text = source[node.byte_range()].to_string();
        // r34-fix: `&text[..100]` 字节切片在 UTF-8 多字节字符边界会 panic
        // （中文/emoji 落在第 100 字节内）——改为字符级截断
        result.text = Some(if text.len() > 100 {
            let truncated: String = text.chars().take(100).collect();
            format!("{}...", truncated)
        } else {
            text
        });
        return Some(result);
    }

    let mut children = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if let Some(simplified) = simplify_ast(child, source, depth + 1, max_depth) {
                children.push(simplified);
            }
        }
    }

    if !children.is_empty() {
        result.children = Some(children);
    }

    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_pool::ParserPool;

    fn simplify(source: &str, max_depth: u32) -> Option<AstNode> {
        let pool = ParserPool::new();
        let tree = pool.parse(source, "javascript").unwrap();
        simplify_ast(tree.root_node(), source, 0, max_depth)
    }

    #[test]
    fn simplify_basic_function() {
        let r = simplify("function foo() { return 1 }", 10).unwrap();
        assert_eq!(r.node_type, "program");
        assert!(r.children.is_some(), "must have children");
        let fns = r.children.as_ref().unwrap();
        assert!(fns.iter().any(|c| c.node_type == "function_declaration"), "must contain function_declaration");
        let fnNode = fns.iter().find(|c| c.node_type == "function_declaration").unwrap();
        assert_eq!(fnNode.name.as_deref(), Some("foo"), "function name captured");
        assert_eq!(fnNode.start_line, 1);
    }

    #[test]
    fn simplify_depth_limit_drops_deep_nodes() {
        // depth 超限的子树整体返回 None（静默丢弃，非 "..." 标记）
        let r = simplify("function outer() { function inner() { function deep() { return 1 } } }", 2).unwrap();
        let text = serde_json::to_string(&r).unwrap();
        assert!(!text.contains(r#""name":"deep""#), "depth>max 的子树节点被丢弃");
        assert!(!text.contains(r#""name":"inner""#), "depth>max 的内层节点被丢弃");
        assert!(text.contains(r#""name":"outer""#), "浅层节点保留");
    }

    #[test]
    fn simplify_depth_limit_shallow_keeps_all() {
        let r = simplify("function outer() { function inner() { return 1 } }", 10).unwrap();
        let text = serde_json::to_string(&r).unwrap();
        assert!(text.contains("inner"), "足够深度下全部保留");
    }

    #[test]
    fn simplify_utf8_truncation_no_panic() {
        // r34-fix 回归：长中文叶子节点（字节截断会 panic）
        let comment = "// ".to_string() + &"中".repeat(60);
        let r = simplify(&comment, 10).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("中"), "Chinese text preserved");
        assert!(json.contains("..."), "truncation marker present");
    }

    #[test]
    fn simplify_emoji_truncation_no_panic() {
        let e = "// ".to_string() + &"🚀".repeat(40);
        let r = simplify(&e, 10).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("🚀"), "emoji preserved");
    }

    #[test]
    fn simplify_leaf_under_100_untouched() {
        let r = simplify("let x = 1", 10).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("..."), "short text must not be truncated");
    }

    #[test]
    fn simplify_name_field_captured_for_class() {
        let r = simplify("class MyClass { method() {} }", 10).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("MyClass"), "class name captured");
    }

    #[test]
    fn simplify_line_numbers() {
        let r = simplify("let a = 1;\nlet b = 2;", 10).unwrap();
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"start_line\":2") || json.contains("start_line\":2"), "multi-line spans tracked");
    }
}
