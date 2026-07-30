use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Tree};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub cyclomatic_complexity: u32,
    pub cognitive_complexity: u32,
    pub max_nesting_depth: u32,
    pub function_count: u32,
    pub class_count: u32,
    pub loc: u32,
    pub comment_ratio: f64,
}

pub fn compute_metrics(tree: &Tree, source: &str, language: &str) -> Metrics {
    let loc = source.lines().count() as u32;
    let total_chars = source.len().max(1) as f64;

    let mut cyc = 1u32;
    let mut cog = 0u32;
    let mut max_nesting = 0u32;
    let mut func_count = 0u32;
    let mut class_count = 0u32;

    let branch_kinds = [
        "if_statement", "for_statement", "while_statement", "do_statement",
        "switch_expression", "catch_clause", "ternary_expression",
        "conditional_expression", "case_expression",
    ];

    let branch_kinds_cog = [
        "if_statement", "else_clause", "for_statement", "while_statement",
        "do_statement", "catch_clause", "ternary_expression",
        "conditional_expression",
    ];

    let func_kinds: &[&str] = match language {
        "javascript" | "typescript" | "tsx" => &["function_declaration", "method_definition", "arrow_function"],
        "python" => &["function_definition"],
        "go" => &["function_declaration", "method_declaration"],
        "rust" => &["function_item"],
        _ => &["function_declaration", "function_definition", "function_item"],
    };

    let class_kinds: &[&str] = match language {
        "javascript" | "typescript" | "tsx" => &["class_declaration"],
        "python" => &["class_definition"],
        "go" => &["type_declaration"],
        "rust" => &["struct_item", "enum_item", "trait_item"],
        _ => &["class_declaration", "class_definition", "struct_item"],
    };

    fn count_cs(source: &str) -> u32 {
        let mut in_block = false;
        let mut in_line = false;
        let mut count = 0u32;
        let chars: Vec<char> = source.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if in_block {
                count += 1;
                if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                    count += 1;
                    i += 2;
                    in_block = false;
                    continue;
                }
            } else if in_line {
                count += 1;
                if chars[i] == '\n' {
                    in_line = false;
                }
            } else {
                if chars[i] == '/' && i + 1 < chars.len() {
                    if chars[i + 1] == '/' {
                        in_line = true;
                        count += 2;
                        i += 2;
                        continue;
                    } else if chars[i + 1] == '*' {
                        in_block = true;
                        count += 2;
                        i += 2;
                        continue;
                    }
                }
            }
            i += 1;
        }
        count
    }

    fn count_py(source: &str) -> u32 {
        let mut count = 0u32;
        for line in source.lines() {
            let t = line.trim();
            if t.starts_with('#') {
                count += line.len() as u32;
            } else if t.starts_with("\"\"\"") || t.starts_with("'''") {
                count += line.len() as u32;
            }
        }
        count
    }

    fn count_hash(source: &str) -> u32 {
        let mut count = 0u32;
        for line in source.lines() {
            let t = line.trim();
            if t.starts_with('#') || t.starts_with("//") {
                count += line.len() as u32;
            }
        }
        count
    }

    let comment_chars = if language == "python" {
        count_py(source)
    } else if language == "go" || language == "rust" {
        count_hash(source) + count_cs(source)
    } else {
        count_cs(source)
    };

    fn walk_metrics(
        node: Node,
        depth: u32,
        cyc: &mut u32,
        cog: &mut u32,
        nesting: u32,
        max_nesting: &mut u32,
        func_count: &mut u32,
        class_count: &mut u32,
        func_kinds: &[&str],
        class_kinds: &[&str],
        branch_kinds: &[&str],
        branch_kinds_cog: &[&str],
    ) {
        let kind = node.kind();

        if func_kinds.contains(&kind) {
            *func_count += 1;
        }
        if class_kinds.contains(&kind) {
            *class_count += 1;
        }

        let is_branch = branch_kinds.contains(&kind);
        if is_branch {
            *cyc += 1;
        }

        let is_branch_cog = branch_kinds_cog.contains(&kind);
        if is_branch_cog {
            *cog += 1 + nesting;
        }

        let current_nesting = if is_branch_cog { nesting + 1 } else { nesting };
        if current_nesting > *max_nesting {
            *max_nesting = current_nesting;
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk_metrics(
                    child,
                    depth + 1,
                    cyc,
                    cog,
                    current_nesting,
                    max_nesting,
                    func_count,
                    class_count,
                    func_kinds,
                    class_kinds,
                    branch_kinds,
                    branch_kinds_cog,
                );
            }
        }
    }

    walk_metrics(
        tree.root_node(),
        0,
        &mut cyc,
        &mut cog,
        0,
        &mut max_nesting,
        &mut func_count,
        &mut class_count,
        func_kinds,
        class_kinds,
        &branch_kinds,
        &branch_kinds_cog,
    );

    let comment_chars = if language == "python" {
        count_py(source)
    } else if language == "go" || language == "rust" {
        count_hash(source) + count_cs(source)
    } else {
        count_cs(source)
    };
    let comment_ratio = (comment_chars as f64 / total_chars * 100.0 * 100.0).round() / 100.0;

    Metrics {
        cyclomatic_complexity: cyc,
        cognitive_complexity: cog,
        max_nesting_depth: max_nesting,
        function_count: func_count,
        class_count: class_count,
        loc,
        comment_ratio,
    }
}
