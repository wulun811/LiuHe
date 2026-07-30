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
        result.text = Some(if text.len() > 100 {
            format!("{}...", &text[..100])
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
