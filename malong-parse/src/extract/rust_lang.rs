use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

// 高频且无歧义的 stdlib / prelude / 方法链噪声调用。
// 这些作为「被调用目标」在 blast-radius 分析里没有意义，索引时直接丢弃。
// 注意：不收 new / default / from / build 等常被路径限定的构造器（如 CpfBuilder::new）。
const NOISE_CALLEES: &[&str] = &[
    // Option / Result 构造器
    "Ok", "Err", "Some", "None",
    // Result / Option / Iterator 组合子
    "map", "map_err", "map_or", "map_or_else", "and_then", "or", "or_else", "or_default",
    "unwrap", "unwrap_or", "unwrap_or_else", "unwrap_or_default", "unwrap_unchecked",
    "expect", "ok_or", "ok_or_else", "filter", "filter_map", "flat_map", "flatten",
    "fold", "fold_first", "collect", "copied", "cloned", "enumerate", "zip", "chain",
    "rev", "take", "take_while", "skip", "skip_while", "position", "rposition",
    "find", "find_map", "any", "all", "count", "sum", "product", "min", "max",
    "min_by", "max_by", "min_by_key", "max_by_key", "sort", "sort_by", "sort_by_key",
    "sort_unstable", "sort_unstable_by", "sort_by_cached_key", "dedup", "dedup_by",
    "partition", "inspect", "for_each", "nth", "nth_back", "next", "next_back",
    "peekable", "fuse", "by_ref", "step_by", "cycle", "intersperse", "reduce",
    "scan", "take_last", "is_sorted", "is_sorted_by",
    // 转换
    "into", "as_str", "as_bytes", "as_mut", "as_ref", "as_deref", "as_deref_mut",
    "as_slice", "as_mut_slice", "to_string", "to_owned", "to_vec", "to_ascii_lowercase",
    "to_ascii_uppercase", "to_lowercase", "to_uppercase", "try_into", "try_from",
    "into_iter", "iter", "iter_mut", "chars", "bytes", "lines", "from_utf8",
    "from_utf8_lossy", "from_str", "as_os_str", "as_path", "to_path_buf", "to_str",
    // 访问器 / 修改器
    "len", "is_empty", "capacity", "push", "push_str", "pop", "insert", "insert_str",
    "remove", "swap_remove", "contains", "get", "get_mut", "get_key_value", "first",
    "last", "clear", "retain", "retain_mut", "drain", "extend", "extend_from_slice",
    "with_capacity", "entry", "or_insert", "or_insert_with", "or_insert_with_key",
    "split", "split_whitespace", "split_terminator", "split_ascii_whitespace",
    "rsplit", "splitn", "rsplitn", "match_indices", "matches", "trim", "trim_start",
    "trim_end", "trim_matches", "trim_start_matches", "trim_end_matches", "replace",
    "replacen", "starts_with", "ends_with", "parse", "is_ascii", "reserve",
    "reserve_exact", "shrink_to_fit", "shrink_to", "truncate", "resize", "resize_with",
    "fill", "fill_with", "copy_from_slice", "clone_from_slice", "windows", "chunks",
    "chunks_exact", "chunks_mut", "rchunks", "rchunks_exact", "split_first",
    "split_last", "split_at", "split_at_mut", "join", "concat", "repeat",
    "escape_default", "escape_unicode", "strip_prefix", "strip_suffix",
    "get_or_insert", "get_or_insert_with",
    // 常见 stdlib 调用
    "clone", "drop", "forget", "take", "swap", "transmute", "size_of", "align_of",
    "type_name", "hash", "eq", "ne", "cmp", "partial_cmp", "is_some", "is_none",
    "is_ok", "is_err", "write", "write_all", "read", "read_to_string", "read_exact",
    "flush", "lock", "stdin", "stdout", "stderr", "create_dir_all", "remove_file",
];

#[inline]
fn is_noise_call(name: &str) -> bool {
    NOISE_CALLEES.contains(&name)
}

// 取调用表达式末段标识符：crate::hash::token_to_id -> token_to_id，self.mmap.len -> len
#[inline]
fn last_path_segment(full: &str) -> &str {
    full.rsplit([':', '.']).next().unwrap_or(full).trim()
}

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, impl_ctx: Option<&str>, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    // impl 块内的函数是方法：kind=method + impl_for=所属类型；其余是自由函数
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: if impl_ctx.is_some() { "method".to_string() } else { "function".to_string() },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: impl_ctx.map(str::to_string),
                    });
                }
            }
            "struct_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "enum_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "trait_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "interface".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "impl_item" => {
                // impl 块本身不产符号（避免假 method/重复 class），但为块内方法提供所属类型上下文
                let type_ctx = node.child_by_field_name("type")
                    .map(|t| source[t.byte_range()].to_string());
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(child, source, depth + 1, type_ctx.as_deref(), symbols, refs);
                    }
                }
                return;
            }
            "let_declaration" => {
                if let Some(pat) = node.child_by_field_name("pattern") {
                    if pat.kind() == "identifier" {
                        symbols.push(Symbol {
                            name: source[pat.byte_range()].to_string(),
                            kind: "variable".to_string(),
                            start_line: pat.start_position().row as u32 + 1,
                            end_line: pat.end_position().row as u32 + 1,
                            impl_for: None,
                        });
                    }
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let full = &source[fn_node.byte_range()];
                    let last = last_path_segment(full);
                    if !last.is_empty() && !is_noise_call(last) {
                        refs.push(Reference {
                            kind: "call".to_string(),
                            name: full.to_string(),
                            line: node.start_position().row as u32 + 1,
                            module: None,
                            symbols: None,
                        });
                    }
                }
            }
            "use_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "use_as_clause" {
                            // 8：`use std::io::Result as IoResult` —— 旧实现 continue 整个跳过，别名导入全丢。
                            // 绑定名 = alias 字段；module = path 字段全路径。name 仅供 live 工具读（DB 存 import 只用 module，不读 name）
                            let path_str = c.child_by_field_name("path")
                                .map(|p| source[p.byte_range()].to_string()).unwrap_or_default();
                            let alias = c.child_by_field_name("alias")
                                .map(|a| source[a.byte_range()].to_string()).unwrap_or_default();
                            if !alias.is_empty() && alias != "*" {
                                refs.push(Reference {
                                    kind: "import".to_string(),
                                    name: alias,
                                    line: c.start_position().row as u32 + 1,
                                    module: Some(path_str),
                                    symbols: Some(vec![]),
                                });
                            }
                            continue;
                        }
                        if c.kind() == "scoped_use_list" {
                            let path = c.child_by_field_name("path");
                            let path_str = path.map(|p| source[p.byte_range()].to_string()).unwrap_or_default();
                            for j in 0..c.child_count() {
                                if let Some(item) = c.child(j) {
                                    if item.kind() == "use_list" {
                                        for k in 0..item.child_count() {
                                            if let Some(u) = item.child(k) {
                                                if u.kind() == "identifier" {
                                                    let module = format!("{}::{}", path_str, &source[u.byte_range()]);
                                                    let binding = last_path_segment(&module).to_string();
                                                    refs.push(Reference {
                                                        kind: "import".to_string(),
                                                        name: binding,
                                                        line: u.start_position().row as u32 + 1,
                                                        module: Some(module),
                                                        symbols: Some(vec![]),
                                                    });
                                                } else if u.kind() == "scoped_identifier" {
                                                    let module = source[u.byte_range()].to_string();
                                                    let binding = last_path_segment(&module).to_string();
                                                    refs.push(Reference {
                                                        kind: "import".to_string(),
                                                        name: binding,
                                                        line: u.start_position().row as u32 + 1,
                                                        module: Some(module),
                                                        symbols: Some(vec![]),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if c.kind() == "scoped_identifier" || c.kind() == "identifier" {
                            let module = source[c.byte_range()].to_string();
                            let binding = last_path_segment(&module).to_string();
                            // 8：glob `use foo::*` 绑定为 *，无法静态判定具体名 → 跳过
                            if binding != "*" {
                                refs.push(Reference {
                                    kind: "import".to_string(),
                                    name: binding,
                                    line: c.start_position().row as u32 + 1,
                                    module: Some(module),
                                    symbols: Some(vec![]),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, impl_ctx, symbols, refs);
            }
        }
    }

    walk(tree.root_node(), source, 0, None, &mut symbols, &mut refs);

    super::ExtractResult {
        symbols,
        imports: vec![],
        refs,
        has_errors: has_error_node(tree.root_node()),
    }
}

pub fn extract_symbols(tree: &Tree, source: &str) -> (Vec<Symbol>, Vec<Import>) {
    let mut symbols = Vec::new();
    let mut imports = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, impl_ctx: Option<&str>, symbols: &mut Vec<Symbol>, imports: &mut Vec<Import>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: if impl_ctx.is_some() { "method".to_string() } else { "function".to_string() },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: impl_ctx.map(str::to_string),
                    });
                }
            }
            "struct_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "enum_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "trait_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "interface".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "impl_item" => {
                let type_ctx = node.child_by_field_name("type")
                    .map(|t| source[t.byte_range()].to_string());
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(child, source, depth + 1, type_ctx.as_deref(), symbols, imports);
                    }
                }
                return;
            }
            "use_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "use_as_clause" {
                            continue;
                        }
                        if c.kind() == "scoped_use_list" {
                            let path = c.child_by_field_name("path");
                            let path_str = path.map(|p| source[p.byte_range()].to_string()).unwrap_or_default();
                            for j in 0..c.child_count() {
                                if let Some(item) = c.child(j) {
                                    if item.kind() == "use_list" {
                                        for k in 0..item.child_count() {
                                            if let Some(u) = item.child(k) {
                                                if u.kind() == "identifier" {
                                                    imports.push(Import {
                                                        target: format!("{}::{}", path_str, &source[u.byte_range()]),
                                                        kind: "import".to_string(),
                                                    });
                                                } else if u.kind() == "scoped_identifier" {
                                                    imports.push(Import {
                                                        target: source[u.byte_range()].to_string(),
                                                        kind: "import".to_string(),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if c.kind() == "scoped_identifier" || c.kind() == "identifier" {
                            imports.push(Import {
                                target: source[c.byte_range()].to_string(),
                                kind: "import".to_string(),
                            });
                        }
                    }
                }
            }
            "let_declaration" => {
                if let Some(pat) = node.child_by_field_name("pattern") {
                    if pat.kind() == "identifier" {
                        symbols.push(Symbol {
                            name: source[pat.byte_range()].to_string(),
                            kind: "variable".to_string(),
                            start_line: pat.start_position().row as u32 + 1,
                            end_line: pat.end_position().row as u32 + 1,
                            impl_for: None,
                        });
                    }
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, impl_ctx, symbols, imports);
            }
        }
    }

    walk(tree.root_node(), source, 0, None, &mut symbols, &mut imports);
    (symbols, imports)
}

pub fn extract_top_level(tree: &Tree, source: &str) -> Vec<Symbol> {
    let mut syms = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, syms: &mut Vec<Symbol>) {
        if depth > 50 { return; }

        match node.kind() {
            "function_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "fn".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "struct_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "struct".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "enum_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "enum".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "trait_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "trait".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "impl_item" => {
                if let Some(type_node) = node.child_by_field_name("type") {
                    syms.push(Symbol {
                        name: source[type_node.byte_range()].to_string(),
                        kind: "impl".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "const_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "const".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, syms);
            }
        }
    }

    walk(tree.root_node(), source, 0, &mut syms);
    syms
}

pub fn extract_references(tree: &Tree, source: &str) -> Vec<Reference> {
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, refs: &mut Vec<Reference>) {
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                let full = &source[fn_node.byte_range()];
                let last = last_path_segment(full);
                if !last.is_empty() && !is_noise_call(last) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: full.to_string(),
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
                }
            }
        } else if node.kind() == "use_declaration" {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "scoped_identifier" {
                        refs.push(Reference {
                            kind: "import".to_string(),
                            name: String::new(),
                            line: c.start_position().row as u32 + 1,
                            module: Some(source[c.byte_range()].to_string()),
                            symbols: Some(vec![]),
                        });
                    } else if c.kind() == "scoped_use_list" {
                        let path = c.child_by_field_name("path");
                        let path_str = path.map(|p| source[p.byte_range()].to_string()).unwrap_or_default();
                        for j in 0..c.child_count() {
                            if let Some(item) = c.child(j) {
                                if item.kind() == "use_list" {
                                    for k in 0..item.child_count() {
                                        if let Some(u) = item.child(k) {
                                            if u.kind() == "identifier" {
                                                refs.push(Reference {
                                                    kind: "import".to_string(),
                                                    name: String::new(),
                                                    line: u.start_position().row as u32 + 1,
                                                    module: Some(format!("{}::{}", path_str, &source[u.byte_range()])),
                                                    symbols: Some(vec![]),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else if c.kind() == "identifier" {
                        refs.push(Reference {
                            kind: "import".to_string(),
                            name: String::new(),
                            line: c.start_position().row as u32 + 1,
                            module: Some(source[c.byte_range()].to_string()),
                            symbols: Some(vec![]),
                        });
                    }
                }
            }
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, refs);
            }
        }
    }

    walk(tree.root_node(), source, &mut refs);
    refs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_rust(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_rust::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(src, None).unwrap()
    }

    #[test]
    fn test_last_path_segment() {
        assert_eq!(last_path_segment("crate::hash::token_to_id"), "token_to_id");
        assert_eq!(last_path_segment("format::read_block"), "read_block");
        assert_eq!(last_path_segment("self.mmap.len"), "len");
        assert_eq!(last_path_segment("Ok"), "Ok");
        assert_eq!(last_path_segment("CpfBuilder::new"), "new");
    }

    #[test]
    fn test_noise_calls_filtered() {
        let src = r#"
fn process(items: &[u32]) -> Result<Vec<u32>, String> {
    let n = items.len();
    let first = items.get(0).ok_or("empty")?;
    let mapped: Vec<u32> = items.iter().map(|x| x * 2).collect();
    if items.is_empty() {
        return Err("no items".to_string());
    }
    Ok(mapped)
}
"#;
        let tree = parse_rust(src);
        let result = extract_all(&tree, src);
        assert!(result.symbols.iter().any(|s| s.name == "process"), "should parse fn process");
        let names: Vec<&str> = result.refs.iter().map(|r| r.name.as_str()).collect();
        for noise in ["len", "get", "ok_or", "iter", "map", "collect", "is_empty", "to_string", "Ok", "Err"] {
            assert!(!names.contains(&noise), "noise {:?} should be filtered; refs={:?}", noise, names);
        }
    }

    #[test]
    fn test_real_calls_kept() {
        let src = r#"
fn build() -> CpfBuilder {
    let mut b = CpfBuilder::new("out.cpf");
    b.add_document(1, 100, &["python"]);
    helper::compute(42);
    b
}
"#;
        let tree = parse_rust(src);
        let result = extract_all(&tree, src);
        let names: Vec<String> = result.refs.iter().map(|r| r.name.clone()).collect();
        assert!(names.iter().any(|n| n.ends_with("new")), "CpfBuilder::new kept: {:?}", names);
        assert!(names.iter().any(|n| n.ends_with("add_document")), "add_document kept: {:?}", names);
        assert!(names.iter().any(|n| n.ends_with("compute")), "helper::compute kept: {:?}", names);
    }

    #[test]
    fn test_extract_references_filters_noise() {
        let src = "fn f(v: &[u8]) -> usize { v.iter().filter(|x| **x > 0).count() }\n";
        let tree = parse_rust(src);
        let refs = extract_references(&tree, src);
        let names: Vec<&str> = refs.iter().map(|r| r.name.as_str()).collect();
        for noise in ["iter", "filter", "count"] {
            assert!(!names.contains(&noise), "noise {:?} filtered in extract_references; refs={:?}", noise, names);
        }
    }

    #[test]
    fn test_use_imports() {
        let src = r#"
use std::collections::HashMap;
use std::{io, fs};
use std::io::Result as IoResult;
use crate::utils::helper;
use serde::*;

fn main() {
    let m = HashMap::new();
}
"#;
        let tree = parse_rust(src);
        let result = extract_all(&tree, src);
        let by_name: std::collections::HashMap<String, String> = result.refs.iter()
            .filter(|r| r.kind == "import")
            .map(|r| (r.name.clone(), r.module.clone().unwrap_or_default()))
            .collect();
        // 8：name = 绑定名（路径末段 / 别名），module = 全路径
        assert_eq!(by_name.get("HashMap").map(|s| s.as_str()), Some("std::collections::HashMap"), "deep path; imports={:?}", by_name);
        assert!(by_name.contains_key("io"), "nested list io; imports={:?}", by_name);
        assert!(by_name.contains_key("fs"), "nested list fs; imports={:?}", by_name);
        assert_eq!(by_name.get("IoResult").map(|s| s.as_str()), Some("std::io::Result"), "alias binding; imports={:?}", by_name);
        assert_eq!(by_name.get("helper").map(|s| s.as_str()), Some("crate::utils::helper"), "crate path; imports={:?}", by_name);
        assert!(!by_name.contains_key("*"), "glob binding must be skipped; imports={:?}", by_name);
    }
}
