use serde::{Deserialize, Serialize};
use crate::parser_pool::ParserPool;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResult {
    pub has_code: bool,
    pub code_ratio: f64,
    pub primary_type: String,
    pub node_count: usize,
}

const CODE_NODE_TYPES: &[&str] = &[
    "function_declaration", "class_declaration", "import_statement", "export_statement",
    "arrow_function", "method_definition",
    "function_definition", "class_definition", "function_item", "struct_item",
];

pub fn classify_message(content: &str, pool: &ParserPool) -> ClassifyResult {
    match pool.parse(content, "javascript") {
        Ok(tree) => {
            let root = tree.root_node();
            let total = root.child_count();

            let mut code_score = 0;
            for i in 0..root.child_count() {
                if let Some(child) = root.child(i) {
                    if CODE_NODE_TYPES.contains(&child.kind()) {
                        code_score += 1;
                    }
                }
            }

            let has_code = code_score > 0;
            let code_ratio = (code_score as f64 / (total.max(1) as f64 * 0.3)).min(1.0);
            let primary_type = if has_code { "code" } else { "text" }.to_string();

            ClassifyResult {
                has_code,
                code_ratio,
                primary_type,
                node_count: total,
            }
        }
        Err(_) => ClassifyResult {
            has_code: false,
            code_ratio: 0.0,
            primary_type: "text".to_string(),
            node_count: 0,
        },
    }
}
