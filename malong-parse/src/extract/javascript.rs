use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

fn collect_binding_names(node: Node, source: &str, out: &mut Vec<(String, u32, u32)>) {
    match node.kind() {
        "identifier" | "shorthand_property_identifier_pattern" => {
            out.push((
                source[node.byte_range()].to_string(),
                node.start_position().row as u32 + 1,
                node.end_position().row as u32 + 1,
            ));
        }
        "pair_pattern" => {
            if let Some(v) = node.child_by_field_name("value") {
                collect_binding_names(v, source, out);
            }
        }
        "object_assignment_pattern" | "assignment_pattern" => {
            if let Some(l) = node.child_by_field_name("left") {
                collect_binding_names(l, source, out);
            }
        }
        "object_pattern" | "array_pattern" | "rest_pattern" => {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    collect_binding_names(c, source, out);
                }
            }
        }
        _ => {}
    }
}

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::with_capacity(256);
    let mut refs = Vec::with_capacity(128);

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        if node.kind() == "export_statement" {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk(child, source, depth, symbols, refs);
                }
            }
            return;
        }

        match node.kind() {
            "function_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "function".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "class_declaration" => {
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
            "interface_declaration" | "type_alias_declaration" | "enum_declaration" | "abstract_class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let kind = match node.kind() {
                        "interface_declaration" => "interface",
                        "type_alias_declaration" => "type",
                        "enum_declaration" => "enum",
                        _ => "class",
                    };
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: kind.to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "method_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                if depth == 1 || node.parent().is_none() {
                    for i in 0..node.child_count() {
                        if let Some(c) = node.child(i) {
                            if c.kind() == "variable_declarator" {
                                if let Some(name_node) = c.child_by_field_name("name") {
                                    let mut names = Vec::new();
                                    collect_binding_names(name_node, source, &mut names);
                                    for (bname, bsl, bel) in names {
                                        symbols.push(Symbol {
                                            name: bname,
                                            kind: "variable".to_string(),
                                            start_line: bsl,
                                            end_line: bel,
                                            impl_for: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let cname = source[fn_node.byte_range()].to_string();
                    // 10（F5）：过滤解析伪影——错误恢复/模板串 ${} 边界令 function 节点跨多行、含 } ) 空白等
                    if is_clean_call_name(&cname) {
                        refs.push(Reference {
                            kind: "call".to_string(),
                            name: cname,
                            line: node.start_position().row as u32 + 1,
                            module: None,
                            symbols: None,
                        });
                    }
                }
            }
            "import_statement" => {
                let source_node = node.child_by_field_name("source");
                let mut imported = Vec::new();
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "import_specifier" || c.kind() == "namespace_import" {
                            if let Some(n) = c.child_by_field_name("name").or_else(|| c.child_by_field_name("local")) {
                                imported.push(source[n.byte_range()].to_string());
                            }
                        }
                    }
                }
                if let Some(s) = source_node {
                    let module_name = source[s.byte_range()].trim_matches(|c| c == '\'' || c == '"').to_string();
                    refs.push(Reference {
                        kind: "import".to_string(),
                        name: String::new(),
                        line: node.start_position().row as u32 + 1,
                        module: Some(module_name),
                        symbols: Some(imported),
                    });
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, symbols, refs);
            }
        }
    }

    walk(tree.root_node(), source, 0, &mut symbols, &mut refs);

    super::ExtractResult {
        symbols,
        imports: vec![],
        refs,
        has_errors: has_error_node(tree.root_node()),
    }
}

pub fn extract_symbols(tree: &Tree, source: &str) -> (Vec<Symbol>, Vec<Import>) {
    let mut symbols = Vec::with_capacity(256);
    let mut imports = Vec::with_capacity(32);

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, imports: &mut Vec<Import>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "function".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "class_declaration" => {
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
            "interface_declaration" | "type_alias_declaration" | "enum_declaration" | "abstract_class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let kind = match node.kind() {
                        "interface_declaration" => "interface",
                        "type_alias_declaration" => "type",
                        "enum_declaration" => "enum",
                        _ => "class",
                    };
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: kind.to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "method_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "import_statement" => {
                if let Some(s) = node.child_by_field_name("source") {
                    let target = source[s.byte_range()].trim_matches(|c| c == '\'' || c == '"').to_string();
                    imports.push(Import { target, kind: "import".to_string() });
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                if depth == 1 || node.parent().is_none() {
                    for i in 0..node.child_count() {
                        if let Some(c) = node.child(i) {
                            if c.kind() == "variable_declarator" {
                                if let Some(name_node) = c.child_by_field_name("name") {
                                    let mut names = Vec::new();
                                    collect_binding_names(name_node, source, &mut names);
                                    for (bname, bsl, bel) in names {
                                        symbols.push(Symbol {
                                            name: bname,
                                            kind: "variable".to_string(),
                                            start_line: bsl,
                                            end_line: bel,
                                            impl_for: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "export_statement" => {
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(child, source, depth, symbols, imports);
                    }
                }
                return;
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, symbols, imports);
            }
        }
    }

    walk(tree.root_node(), source, 0, &mut symbols, &mut imports);
    (symbols, imports)
}

pub fn extract_top_level(tree: &Tree, source: &str) -> Vec<Symbol> {
    let mut syms = Vec::with_capacity(64);

    fn walk(node: Node, source: &str, depth: u32, syms: &mut Vec<Symbol>) {
        if depth > 50 { return; }

        match node.kind() {
            "function_declaration" if depth <= 1 => {
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
            "class_declaration" if depth <= 1 => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "interface_declaration" | "type_alias_declaration" | "enum_declaration" | "abstract_class_declaration" if depth <= 1 => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let kind = match node.kind() {
                        "interface_declaration" => "interface",
                        "type_alias_declaration" => "type",
                        "enum_declaration" => "enum",
                        _ => "class",
                    };
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: kind.to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "method_definition" if depth <= 2 => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "lexical_declaration" if depth <= 1 => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "variable_declarator" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                let mut names = Vec::new();
                                collect_binding_names(name_node, source, &mut names);
                                for (bname, bsl, bel) in names {
                                    syms.push(Symbol {
                                        name: bname,
                                        kind: "const".to_string(),
                                        start_line: bsl,
                                        end_line: bel,
                                        impl_for: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "export_statement" => {
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(child, source, depth, syms);
                    }
                }
                return;
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

// 10（F5）：合法调用名是标识符或成员/可选链（foo、a.b、a?.b、a[0]），单行、无空白/括号/引号。
// 解析错误恢复或模板串 ${} 边界会让 function 节点 byte_range 跨界，产出 "message}`)\n resolve..." 之类伪影
fn is_clean_call_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 || name.contains('\n') || name.contains(' ') || name.contains('\t') {
        return false;
    }
    if name.contains('}') || name.contains('{') || name.contains(')') || name.contains('(')
        || name.contains('"') || name.contains('\'') || name.contains('`') || name.contains(',') {
        return false;
    }
    name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.' || c == '?' || c == '[' || c == ']')
}

pub fn extract_references(tree: &Tree, source: &str) -> Vec<Reference> {
    let mut refs = Vec::with_capacity(128);

    fn walk(node: Node, source: &str, refs: &mut Vec<Reference>) {
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                let cname = source[fn_node.byte_range()].to_string();
                // 10（F5）：过滤解析伪影（同 extract_all）
                if is_clean_call_name(&cname) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: cname,
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
                }
            }
        } else if node.kind() == "import_statement" {
            let source_node = node.child_by_field_name("source");
            let mut imported = Vec::new();
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "import_specifier" || c.kind() == "namespace_import" {
                        if let Some(n) = c.child_by_field_name("name").or_else(|| c.child_by_field_name("local")) {
                            imported.push(source[n.byte_range()].to_string());
                        }
                    }
                }
            }
            let module = source_node
                .map(|s| source[s.byte_range()].trim_matches(|c| c == '\'' || c == '"').to_string())
                .unwrap_or_default();
            refs.push(Reference {
                kind: "import".to_string(),
                name: String::new(),
                line: node.start_position().row as u32 + 1,
                module: Some(module),
                symbols: Some(imported),
            });
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

    fn parse_js(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_javascript::LANGUAGE.into();
        parser.set_language(&lang).expect("set js language");
        parser.parse(src, None).expect("parse js")
    }

    #[test]
    fn clean_call_name_accepts_valid() {
        assert!(is_clean_call_name("foo"));
        assert!(is_clean_call_name("a.b.c"));
        assert!(is_clean_call_name("_core?.log"));
        assert!(is_clean_call_name("arr[0]"));
        assert!(is_clean_call_name("$x"));
        assert!(is_clean_call_name("CamelCase"));
    }

    #[test]
    fn clean_call_name_rejects_artifacts() {
        assert!(!is_clean_call_name(""));
        assert!(!is_clean_call_name("message}`)\n resolve(false)"));
        assert!(!is_clean_call_name("a b"));
        assert!(!is_clean_call_name("foo()"));
        assert!(!is_clean_call_name("a}"));
        assert!(!is_clean_call_name("a{b"));
        assert!(!is_clean_call_name("`tpl`"));
        assert!(!is_clean_call_name("a,b"));
        assert!(!is_clean_call_name("a\tb"));
        assert!(!is_clean_call_name(&"x".repeat(201)));
    }

    #[test]
    fn extract_all_no_garbage_call_names() {
        let src = r#"
function f(err) {
    log(`failed: ${err.message}`);
    return helper(err);
}
"#;
        let tree = parse_js(src);
        let result = extract_all(&tree, src);
        let calls: Vec<&str> = result
            .refs
            .iter()
            .filter(|r| r.kind == "call")
            .map(|r| r.name.as_str())
            .collect();
        for name in &calls {
            assert!(is_clean_call_name(name), "garbage call name leaked: {:?}", name);
            assert!(!name.contains('\n'), "multiline call name: {:?}", name);
        }
        assert!(calls.contains(&"log"), "log call missing; got {:?}", calls);
        assert!(calls.contains(&"helper"), "helper call missing; got {:?}", calls);
    }

    #[test]
    fn extract_references_no_garbage_call_names() {
        let src = "const x = compute(a);\nlog(`v=${x}`);\n";
        let tree = parse_js(src);
        let refs = extract_references(&tree, src);
        let calls: Vec<&str> = refs
            .iter()
            .filter(|r| r.kind == "call")
            .map(|r| r.name.as_str())
            .collect();
        for name in &calls {
            assert!(is_clean_call_name(name), "garbage call name leaked: {:?}", name);
        }
        assert!(calls.contains(&"compute"), "compute missing; got {:?}", calls);
        assert!(calls.contains(&"log"), "log missing; got {:?}", calls);
    }
}
