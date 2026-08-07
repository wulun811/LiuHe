pub mod javascript;
pub mod python;
pub mod go;
pub mod rust_lang;
pub mod c_lang;
pub mod cpp;
pub mod java;
pub mod bash;
pub mod metrics;

use serde::{Deserialize, Serialize};
use tree_sitter::Tree;

/// 树遍历最大深度（r8：防深嵌套输入栈溢出杀 daemon——栈溢出是 abort，catch_unwind 拦不住）。
/// 真实代码 AST 深度几乎不超 100；512 已远超，同时远低于 spawn_blocking 2MB 栈的溢出阈值（约 6000 层）。
pub const MAX_WALK_DEPTH: u32 = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impl_for: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub kind: String,
    pub name: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbols: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractResult {
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub refs: Vec<Reference>,
    pub has_errors: bool,
    // r9(A1/A2)：遍历深度上限截断标注——超深代码无法完全验证时 has_errors 保守为 true（宁可报错不可静默失真），
    // truncated 供消费方透明识别（写盘门禁可见：不是真有错而是未能验证）
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(b: &bool) -> bool {
    !b
}

pub fn extract_all(tree: &Tree, source: &str, language: &str) -> ExtractResult {
    let mut result = match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_all(tree, source),
        "python" => python::extract_all(tree, source),
        "go" => go::extract_all(tree, source),
        "rust" => rust_lang::extract_all(tree, source),
        "c" => c_lang::extract_all(tree, source),
        "cpp" => cpp::extract_all(tree, source),
        "java" => java::extract_all(tree, source),
        "bash" => bash::extract_all(tree, source),
        _ => ExtractResult {
            symbols: vec![],
            imports: vec![],
            refs: vec![],
            has_errors: false,
            truncated: false,
        },
    };
    // Y002-S3：变量引用追踪（JS/TS spike）——extract_all 也并入 use/assign，
    // code-index 索引入库（走 extract_all）与 extract_references 走同一语义
    if matches!(language, "javascript" | "typescript" | "tsx") {
        result.refs.extend(javascript::extract_variable_refs(tree, source));
    }
    result
}

pub fn extract_symbols(tree: &Tree, source: &str, language: &str) -> (Vec<Symbol>, Vec<Import>) {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_symbols(tree, source),
        "python" => python::extract_symbols(tree, source),
        "go" => go::extract_symbols(tree, source),
        "rust" => rust_lang::extract_symbols(tree, source),
        "c" => c_lang::extract_symbols(tree, source),
        "cpp" => cpp::extract_symbols(tree, source),
        "java" => java::extract_symbols(tree, source),
        "bash" => bash::extract_symbols(tree, source),
        _ => (vec![], vec![]),
    }
}

pub fn extract_top_level(tree: &Tree, source: &str, language: &str) -> Vec<Symbol> {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_top_level(tree, source),
        "python" => python::extract_top_level(tree, source),
        "go" => go::extract_top_level(tree, source),
        "rust" => rust_lang::extract_top_level(tree, source),
        "c" => c_lang::extract_top_level(tree, source),
        "cpp" => cpp::extract_top_level(tree, source),
        "java" => java::extract_top_level(tree, source),
        "bash" => bash::extract_top_level(tree, source),
        _ => vec![],
    }
}

pub fn extract_references(tree: &Tree, source: &str, language: &str) -> Vec<Reference> {
    match language {
        // Y002-S3：JS/TS spike——追加模块级变量 use/assign 引用（refs 表支持，此前只 call/import）
        "javascript" | "typescript" | "tsx" => {
            let mut refs = javascript::extract_references(tree, source);
            refs.extend(javascript::extract_variable_refs(tree, source));
            refs
        }
        "python" => python::extract_references(tree, source),
        "go" => go::extract_references(tree, source),
        "rust" => rust_lang::extract_references(tree, source),
        "c" => c_lang::extract_references(tree, source),
        "cpp" => cpp::extract_references(tree, source),
        "java" => java::extract_references(tree, source),
        "bash" => bash::extract_references(tree, source),
        _ => vec![],
    }
}

pub fn has_error_node(node: tree_sitter::Node) -> (bool, bool) {
    has_error_node_depth(node, 0)
}

// r9(A1)：返回 (has_errors, truncated)。超深（>MAX_WALK_DEPTH）无法验证 → has_errors 保守 true（用户决策：
// 宁可报错不可静默失真——写盘门禁不得放行未能完整验证的代码）+ truncated 标注透明化。
// 注意：真实代码 AST 深度 <100（mod.rs:15 验证），超深仅压平/生成代码可达。
fn has_error_node_depth(node: tree_sitter::Node, depth: u32) -> (bool, bool) {
    if depth > MAX_WALK_DEPTH {
        return (true, true);
    }
    if node.kind() == "ERROR" {
        return (true, false);
    }
    let mut truncated = false;
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let (e, t) = has_error_node_depth(child, depth + 1);
            if e {
                return (true, truncated || t);
            }
            truncated |= t;
        }
    }
    (false, truncated)
}
