use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_item" => {
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
            "enum_item" | "trait_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "type".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "impl_item" => {
                let trait_node = node.child_by_field_name("trait");
                let type_node = node.child_by_field_name("type");
                if let Some(type_n) = type_node {
                    symbols.push(Symbol {
                        name: source[type_n.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: trait_node.map(|t| source[t.byte_range()].to_string()),
                    });
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
                                                    refs.push(Reference {
                                                        kind: "import".to_string(),
                                                        name: String::new(),
                                                        line: u.start_position().row as u32 + 1,
                                                        module: Some(format!("{}::{}", path_str, &source[u.byte_range()])),
                                                        symbols: Some(vec![]),
                                                    });
                                                } else if u.kind() == "scoped_identifier" {
                                                    refs.push(Reference {
                                                        kind: "import".to_string(),
                                                        name: String::new(),
                                                        line: u.start_position().row as u32 + 1,
                                                        module: Some(source[u.byte_range()].to_string()),
                                                        symbols: Some(vec![]),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else if c.kind() == "scoped_identifier" || c.kind() == "identifier" {
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
            "function_item" => {
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
            "enum_item" | "trait_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "type".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "impl_item" => {
                let trait_node = node.child_by_field_name("trait");
                let type_node = node.child_by_field_name("type");
                if let Some(type_n) = type_node {
                    symbols.push(Symbol {
                        name: source[type_n.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: trait_node.map(|t| source[t.byte_range()].to_string()),
                    });
                }
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
                refs.push(Reference {
                    kind: "call".to_string(),
                    name: source[fn_node.byte_range()].to_string(),
                    line: node.start_position().row as u32 + 1,
                    module: None,
                    symbols: None,
                });
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
