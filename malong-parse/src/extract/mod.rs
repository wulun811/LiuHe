pub mod javascript;
pub mod python;
pub mod go;
pub mod rust_lang;

use serde::{Deserialize, Serialize};
use tree_sitter::Tree;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopLevelResult {
    pub symbols: Vec<Symbol>,
}

pub fn extract_all(tree: &Tree, source: &str, language: &str) -> ExtractResult {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_all(tree, source),
        "python" => python::extract_all(tree, source),
        "go" => go::extract_all(tree, source),
        "rust" => rust_lang::extract_all(tree, source),
        _ => ExtractResult {
            symbols: vec![],
            imports: vec![],
            refs: vec![],
            has_errors: false,
        },
    }
}

pub fn extract_symbols(tree: &Tree, source: &str, language: &str) -> (Vec<Symbol>, Vec<Import>) {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_symbols(tree, source),
        "python" => python::extract_symbols(tree, source),
        "go" => go::extract_symbols(tree, source),
        "rust" => rust_lang::extract_symbols(tree, source),
        _ => (vec![], vec![]),
    }
}

pub fn extract_top_level(tree: &Tree, source: &str, language: &str) -> Vec<Symbol> {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_top_level(tree, source),
        "python" => python::extract_top_level(tree, source),
        "go" => go::extract_top_level(tree, source),
        "rust" => rust_lang::extract_top_level(tree, source),
        _ => vec![],
    }
}

pub fn extract_references(tree: &Tree, source: &str, language: &str) -> Vec<Reference> {
    match language {
        "javascript" | "typescript" | "tsx" => javascript::extract_references(tree, source),
        "python" => python::extract_references(tree, source),
        "go" => go::extract_references(tree, source),
        "rust" => rust_lang::extract_references(tree, source),
        _ => vec![],
    }
}

pub fn has_error_node(node: tree_sitter::Node) -> bool {
    if node.kind() == "ERROR" {
        return true;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if has_error_node(child) {
                return true;
            }
        }
    }
    false
}
