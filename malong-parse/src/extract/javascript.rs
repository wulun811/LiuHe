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
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: source[fn_node.byte_range()].to_string(),
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
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

pub fn extract_references(tree: &Tree, source: &str) -> Vec<Reference> {
    let mut refs = Vec::with_capacity(128);

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
