use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
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
            "method_declaration" => {
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
            "type_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "type_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                symbols.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "type".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
                                });
                            }
                        }
                    }
                }
            }
            "import_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "import_spec" {
                            if let Some(p) = c.child_by_field_name("path") {
                                let target = source[p.byte_range()].trim_matches('"').to_string();
                                refs.push(Reference {
                                    kind: "import".to_string(),
                                    name: String::new(),
                                    line: c.start_position().row as u32 + 1,
                                    module: Some(target),
                                    symbols: Some(vec![]),
                                });
                            }
                        } else if c.kind() == "import_spec_list" {
                            for j in 0..c.child_count() {
                                if let Some(s) = c.child(j) {
                                    if s.kind() == "import_spec" {
                                        if let Some(p) = s.child_by_field_name("path") {
                                            let target = source[p.byte_range()].trim_matches('"').to_string();
                                            refs.push(Reference {
                                                kind: "import".to_string(),
                                                name: String::new(),
                                                line: s.start_position().row as u32 + 1,
                                                module: Some(target),
                                                symbols: Some(vec![]),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "short_var_declaration" | "var_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "identifier" {
                            symbols.push(Symbol {
                                name: source[c.byte_range()].to_string(),
                                kind: "variable".to_string(),
                                start_line: c.start_position().row as u32 + 1,
                                end_line: c.end_position().row as u32 + 1,
                                impl_for: None,
                            });
                        } else if c.kind() == "var_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                symbols.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "variable".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
                                });
                            }
                        }
                    }
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: source[fn_node.byte_range()].to_string(),
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
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
    let mut symbols = Vec::new();
    let mut imports = Vec::new();

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
            "method_declaration" => {
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
            "type_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "type_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                symbols.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "type".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
                                });
                            }
                        }
                    }
                }
            }
            "import_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "import_spec" {
                            if let Some(p) = c.child_by_field_name("path") {
                                let target = source[p.byte_range()].trim_matches('"').to_string();
                                imports.push(Import { target, kind: "import".to_string() });
                            }
                        } else if c.kind() == "import_spec_list" {
                            for j in 0..c.child_count() {
                                if let Some(s) = c.child(j) {
                                    if s.kind() == "import_spec" {
                                        if let Some(p) = s.child_by_field_name("path") {
                                            let target = source[p.byte_range()].trim_matches('"').to_string();
                                            imports.push(Import { target, kind: "import".to_string() });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "short_var_declaration" | "var_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "identifier" {
                            symbols.push(Symbol {
                                name: source[c.byte_range()].to_string(),
                                kind: "variable".to_string(),
                                start_line: c.start_position().row as u32 + 1,
                                end_line: c.end_position().row as u32 + 1,
                                impl_for: None,
                            });
                        } else if c.kind() == "var_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                symbols.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "variable".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
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
                walk(child, source, depth + 1, symbols, imports);
            }
        }
    }

    walk(tree.root_node(), source, 0, &mut symbols, &mut imports);
    (symbols, imports)
}

pub fn extract_top_level(tree: &Tree, source: &str) -> Vec<Symbol> {
    let mut syms = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, syms: &mut Vec<Symbol>) {
        if depth > 50 { return; }

        match node.kind() {
            "function_declaration" => {
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
            "method_declaration" => {
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
            "type_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "type_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                syms.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "type".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
                                });
                            }
                        }
                    }
                }
            }
            "const_declaration" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "const_spec" {
                            if let Some(name_node) = c.child_by_field_name("name") {
                                syms.push(Symbol {
                                    name: source[name_node.byte_range()].to_string(),
                                    kind: "const".to_string(),
                                    start_line: c.start_position().row as u32 + 1,
                                    end_line: c.end_position().row as u32 + 1,
                                    impl_for: None,
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
                refs.push(Reference {
                    kind: "call".to_string(),
                    name: source[fn_node.byte_range()].to_string(),
                    line: node.start_position().row as u32 + 1,
                    module: None,
                    symbols: None,
                });
            }
        } else if node.kind() == "import_declaration" {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "import_spec" {
                        if let Some(p) = c.child_by_field_name("path") {
                            refs.push(Reference {
                                kind: "import".to_string(),
                                name: String::new(),
                                line: c.start_position().row as u32 + 1,
                                module: Some(source[p.byte_range()].trim_matches('"').to_string()),
                                symbols: Some(vec![]),
                            });
                        }
                    } else if c.kind() == "import_spec_list" {
                        for j in 0..c.child_count() {
                            if let Some(s) = c.child(j) {
                                if s.kind() == "import_spec" {
                                    if let Some(p) = s.child_by_field_name("path") {
                                        refs.push(Reference {
                                            kind: "import".to_string(),
                                            name: String::new(),
                                            line: s.start_position().row as u32 + 1,
                                            module: Some(source[p.byte_range()].trim_matches('"').to_string()),
                                            symbols: Some(vec![]),
                                        });
                                    }
                                }
                            }
                        }
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
