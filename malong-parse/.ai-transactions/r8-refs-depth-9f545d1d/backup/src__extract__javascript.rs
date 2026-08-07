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

// ── Y002-S3：变量引用追踪（spike：JS/TS 模块级绑定） ──
// 捕获模块级（顶层）变量/常量的读写引用（kind=use/assign）——refs 表 schema 允许
// assign/use 但此前只填 call/import。排除：属性访问（member_expression 的 property）、
// 对象键、声明位置、函数参数、调用名（call 已覆盖）。
// 说明：不做完整作用域分析（type inference 已否决）——只报「顶层绑定名」的引用，
// 局部变量（函数内声明）不追踪；阴影同名变量（局部遮蔽顶层）会误报顶层，spike 接受，
// 后续可用 bindings 表做精确遮蔽。

fn collect_top_level_bindings(node: Node, source: &str, out: &mut Vec<String>) {
    if node.kind() == "lexical_declaration" || node.kind() == "variable_declaration" {
        // 只收顶层（parent 是 program）
        let is_top = node.parent().map(|p| p.kind() == "program").unwrap_or(false);
        if is_top {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "variable_declarator" {
                        if let Some(name) = c.child_by_field_name("name") {
                            if name.kind() == "identifier" {
                                out.push(source[name.byte_range()].to_string());
                            }
                        }
                    }
                }
            }
        }
    } else if node.kind() == "import_statement" {
        // Y002-S3 补充：import 的 local/name 也是模块级绑定（跨文件常量/变量引用的典型入口）。
        // import_statement 子树含 import_clause 层，需递归找 import_specifier / namespace_import
        fn collect_import_binding(n: Node, source: &str, out: &mut Vec<String>) {
            if n.kind() == "import_specifier" || n.kind() == "namespace_import" {
                if let Some(nn) = n.child_by_field_name("name").or_else(|| n.child_by_field_name("local")) {
                    out.push(source[nn.byte_range()].to_string());
                }
                return;
            }
            for i in 0..n.child_count() {
                if let Some(c) = n.child(i) {
                    collect_import_binding(c, source, out);
                }
            }
        }
        collect_import_binding(node, source, out);
    }
}

pub fn extract_variable_refs(tree: &Tree, source: &str) -> Vec<Reference> {
    let mut refs = Vec::with_capacity(64);
    let mut top_bindings = Vec::new();

    fn walk_collect(node: Node, source: &str, out: &mut Vec<String>) {
        collect_top_level_bindings(node, source, out);
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                walk_collect(c, source, out);
            }
        }
    }
    walk_collect(tree.root_node(), source, &mut top_bindings);
    if top_bindings.is_empty() {
        return refs;
    }

    fn is_property_access(node: Node) -> bool {
        // identifier 是 member_expression 的 property → 属性访问（obj.name），不追踪
        if let Some(p) = node.parent() {
            if p.kind() == "member_expression" {
                if let Some(prop) = p.child_by_field_name("property") {
                    if prop.id() == node.id() {
                        return true;
                    }
                }
            }
            if p.kind() == "pair" {
                if let Some(key) = p.child_by_field_name("key") {
                    if key.id() == node.id() {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn is_declaration_site(node: Node) -> bool {
        if let Some(p) = node.parent() {
            if p.kind() == "variable_declarator" {
                if let Some(name) = p.child_by_field_name("name") {
                    if name.id() == node.id() {
                        return true;
                    }
                }
            }
            if p.kind() == "formal_parameters" || p.kind() == "required_parameter" || p.kind() == "optional_parameter" {
                return true;
            }
            if p.kind() == "call_expression" {
                if let Some(fn_node) = p.child_by_field_name("function") {
                    if fn_node.id() == node.id() {
                        return true; // 调用名：call ref 已覆盖
                    }
                }
            }
            if p.kind() == "import_specifier" || p.kind() == "namespace_import" {
                return true; // import 声明名：import ref 已覆盖
            }
        }
        false
    }

    fn is_assignment_target(node: Node) -> bool {
        if let Some(p) = node.parent() {
            if p.kind() == "assignment_expression" {
                if let Some(l) = p.child_by_field_name("left") {
                    return l.id() == node.id();
                }
            }
            // update_expression (x++) 的 argument
            if p.kind() == "update_expression" {
                if let Some(a) = p.child_by_field_name("argument") {
                    return a.id() == node.id();
                }
            }
        }
        false
    }

    fn walk(node: Node, source: &str, top: &[String], refs: &mut Vec<Reference>) {
        if node.kind() == "identifier" {
            let name = source[node.byte_range()].to_string();
            if top.contains(&name) && !is_property_access(node) && !is_declaration_site(node) {
                let kind = if is_assignment_target(node) { "assign" } else { "use" };
                refs.push(Reference {
                    kind: kind.to_string(),
                    name,
                    line: node.start_position().row as u32 + 1,
                    module: None,
                    symbols: None,
                });
            }
        }
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                walk(c, source, top, refs);
            }
        }
    }
    walk(tree.root_node(), source, &top_bindings, &mut refs);
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

    #[test]
    fn extract_all_filters_chained_member_calls() {
        // 11#7：链式成员调用（a.b().c()）的 function 节点跨整个链，含 ( ) 空白——必须被过滤
        let src = "const x = extname(filePath || '').toLowerCase();\nfoo.bar().baz();\n";
        let tree = parse_js(src);
        let result = extract_all(&tree, src);
        let calls: Vec<&str> = result
            .refs
            .iter()
            .filter(|r| r.kind == "call")
            .map(|r| r.name.as_str())
            .collect();
        for name in &calls {
            assert!(is_clean_call_name(name), "garbage chained call leaked: {:?}", name);
            assert!(!name.contains('(') && !name.contains(' '), "chained call not filtered: {:?}", name);
        }
    }

    // ── Y002-S3：变量引用追踪（use/assign） ──
    fn parse_js_tree(src: &str) -> Tree {
        parse_js(src)
    }

    fn extract_var(src: &str) -> Vec<(String, String)> {
        let tree = parse_js_tree(src);
        extract_variable_refs(&tree, src)
            .into_iter()
            .map(|r| (r.kind, r.name))
            .collect()
    }

    #[test]
    fn variable_refs_use_module_level_const() {
        let src = "const MAX_RETRY = 5;\nfunction f() {\n  if (count > MAX_RETRY) { return MAX_RETRY }\n}\n";
        let refs = extract_var(src);
        assert!(refs.iter().any(|(k, n)| k == "use" && n == "MAX_RETRY"), "module const use missing: {:?}", refs);
    }

    #[test]
    fn variable_refs_assign_module_level_var() {
        let src = "let config = {};\nfunction init() {\n  config = { a: 1 };\n  config.count = 2;\n}\n";
        let refs = extract_var(src);
        assert!(refs.iter().any(|(k, n)| k == "assign" && n == "config"), "assign missing: {:?}", refs);
        assert!(!refs.iter().any(|(k, n)| n == "count"), "property access must not be tracked: {:?}", refs);
    }

    #[test]
    fn variable_refs_skip_declaration_and_properties() {
        let src = "const A = 1;\nconst C = A + 1;\nobj.A;\n";
        let refs = extract_var(src);
        // 声明处 A（const A = 1）不算 use；右侧 A + 1 是 use
        assert_eq!(refs.iter().filter(|(k, n)| k == "use" && n == "A").count(), 1, "A use missing: {:?}", refs);
        // obj.A 的 A 是属性访问 → 不追踪
        assert!(!refs.iter().any(|(_, n)| n == "B"), "property access must not be tracked: {:?}", refs);
    }

    #[test]
    fn variable_refs_local_var_not_tracked() {
        let src = "function f() {\n  let local = 1;\n  return local + 2;\n}\n";
        let refs = extract_var(src);
        assert!(refs.iter().all(|(_, n)| n != "local"), "local var must not be tracked: {:?}", refs);
    }

    #[test]
    fn variable_refs_call_name_not_duplicated() {
        let src = "const helper = () => 1;\nfunction g() { helper(); }\n";
        let refs = extract_var(src);
        // 调用名 helper 由 call ref 覆盖（is_declaration_site 跳过），变量 refs 不含 helper
        assert!(refs.iter().all(|(_, n)| n != "helper"), "call name must not appear as use: {:?}", refs);
    }

    #[test]
    fn variable_refs_import_local_is_module_binding() {
        let src = "import { API_TIMEOUT } from './a.js';\nfunction wait() {\n  return API_TIMEOUT * 2;\n}\n";
        let refs = extract_var(src);
        assert!(refs.iter().any(|(k, n)| k == "use" && n == "API_TIMEOUT"), "import local use missing: {:?}", refs);
    }
}
