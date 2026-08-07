use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_definition" => {
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
            "class_definition" => {
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
            "assignment" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" || left.kind() == "attribute" {
                        let name = source[left.byte_range()].split('.').next().unwrap_or("");
                        if name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
                            symbols.push(Symbol {
                                name: name.to_string(),
                                kind: "variable".to_string(),
                                start_line: node.start_position().row as u32 + 1,
                                end_line: node.end_position().row as u32 + 1,
                                impl_for: None,
                            });
                        }
                    }
                }
            }
            "call" => {
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
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "dotted_name" {
                            refs.push(Reference {
                                kind: "import".to_string(),
                                name: String::new(),
                                line: node.start_position().row as u32 + 1,
                                module: Some(source[c.byte_range()].to_string()),
                                symbols: Some(vec![]),
                            });
                        }
                    }
                }
            }
            "import_from_statement" => {
                let module_node = node.child_by_field_name("module_name");
                let mod_name = module_node
                    .map(|m| source[m.byte_range()].to_string())
                    .unwrap_or_default();

                let mut imported = Vec::new();
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c != module_node.unwrap_or(c) {
                            if c.kind() == "dotted_name" || c.kind() == "identifier" {
                                imported.push(source[c.byte_range()].to_string());
                            } else if c.kind() == "aliased_import" {
                                if let Some(alias) = c.child_by_field_name("alias") {
                                    imported.push(source[alias.byte_range()].to_string());
                                }
                            }
                        }
                    }
                }
                refs.push(Reference {
                    kind: "import".to_string(),
                    name: String::new(),
                    line: node.start_position().row as u32 + 1,
                    module: Some(mod_name),
                    symbols: Some(imported),
                });
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

    let (has_errors, truncated) = has_error_node(tree.root_node());
    super::ExtractResult {
        symbols,
        imports: vec![],
        refs,
        has_errors,
        truncated,
    }
}

pub fn extract_symbols(tree: &Tree, source: &str) -> (Vec<Symbol>, Vec<Import>) {
    let mut symbols = Vec::new();
    let mut imports = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, imports: &mut Vec<Import>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_definition" => {
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
            "class_definition" => {
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
            "decorated_definition" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        walk(c, source, depth + 1, symbols, imports);
                    }
                }
                return;
            }
            "import_statement" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        if c.kind() == "dotted_name" {
                            imports.push(Import {
                                target: source[c.byte_range()].to_string(),
                                kind: "import".to_string(),
                            });
                        }
                    }
                }
            }
            "import_from_statement" => {
                let module_node = node.child_by_field_name("module_name");
                if let Some(module) = module_node {
                    let mut has_child_dotted = false;
                    for i in 0..node.child_count() {
                        if let Some(c) = node.child(i) {
                            if c.kind() == "dotted_name" && c != module {
                                let target = format!("{}.{}", &source[module.byte_range()], &source[c.byte_range()]);
                                imports.push(Import { target, kind: "import".to_string() });
                                has_child_dotted = true;
                            }
                        }
                    }
                    if !has_child_dotted {
                        imports.push(Import {
                            target: source[module.byte_range()].to_string(),
                            kind: "import".to_string(),
                        });
                    }
                }
            }
            "assignment" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" || left.kind() == "attribute" {
                        let name = source[left.byte_range()].split('.').next().unwrap_or("");
                        if name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
                            symbols.push(Symbol {
                                name: name.to_string(),
                                kind: "variable".to_string(),
                                start_line: node.start_position().row as u32 + 1,
                                end_line: node.end_position().row as u32 + 1,
                                impl_for: None,
                            });
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
            "function_definition" => {
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
            "class_definition" => {
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
            "decorated_definition" => {
                for i in 0..node.child_count() {
                    if let Some(c) = node.child(i) {
                        walk(c, source, depth + 1, syms);
                    }
                }
                return;
            }
            "assignment" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        let name: &str = &source[left.byte_range()];
                        if name.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
                            && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                        {
                            syms.push(Symbol {
                                name: name.to_string(),
                                kind: "const".to_string(),
                                start_line: node.start_position().row as u32 + 1,
                                end_line: node.end_position().row as u32 + 1,
                                impl_for: None,
                            });
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

    fn walk(node: Node, source: &str, depth: u32, refs: &mut Vec<Reference>) {
        if depth > super::MAX_WALK_DEPTH { return; }
        if node.kind() == "call" {
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
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "dotted_name" {
                        refs.push(Reference {
                            kind: "import".to_string(),
                            name: String::new(),
                            line: node.start_position().row as u32 + 1,
                            module: Some(source[c.byte_range()].to_string()),
                            symbols: Some(vec![]),
                        });
                    }
                }
            }
        } else if node.kind() == "import_from_statement" {
            let module_node = node.child_by_field_name("module_name");
            let mod_name = module_node
                .map(|m| source[m.byte_range()].to_string())
                .unwrap_or_default();

            let mut imported = Vec::new();
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c != module_node.unwrap_or(c) {
                        if c.kind() == "dotted_name" || c.kind() == "identifier" {
                            imported.push(source[c.byte_range()].to_string());
                        } else if c.kind() == "aliased_import" {
                            if let Some(alias) = c.child_by_field_name("alias") {
                                imported.push(source[alias.byte_range()].to_string());
                            }
                        }
                    }
                }
            }
            refs.push(Reference {
                kind: "import".to_string(),
                name: String::new(),
                line: node.start_position().row as u32 + 1,
                module: Some(mod_name),
                symbols: Some(imported),
            });
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, refs);
            }
        }
    }

    walk(tree.root_node(), source, 0, &mut refs);
    refs
}
