use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

// C++ 常见 stdlib/STL 噪声调用
const NOISE_CALLEES: &[&str] = &[
    "printf", "fprintf", "sprintf", "snprintf", "puts", "putchar", "getchar", "gets", "fgets",
    "scanf", "fscanf", "sscanf", "perror", "fopen", "fclose", "fwrite", "fread",
    "malloc", "calloc", "realloc", "free", "memcpy", "memmove", "memset", "memcmp",
    "strlen", "strcpy", "strncpy", "strcat", "strncat", "strcmp", "strncmp", "strchr",
    "strstr", "strtok", "atoi", "atol", "atof", "strtol", "strtod", "exit", "abort", "assert",
    "rand", "srand", "time", "abs", "labs", "pow", "sqrt", "floor", "ceil", "fabs",
    "std::cout", "std::cerr", "std::clog", "std::endl", "std::flush", "std::cin", "std::getline",
    "std::make_shared", "std::make_unique", "std::move", "std::swap", "std::sort",
    "std::vector", "std::map", "std::set", "std::string", "std::to_string", "new", "delete",
    "std::min", "std::max", "std::abs", "std::begin", "std::end", "std::find", "std::copy",
];

#[inline]
fn is_noise_call(name: &str) -> bool {
    NOISE_CALLEES.contains(&name)
}

#[inline]
fn last_segment(full: &str) -> &str {
    full.rsplit(['.', '>', '-', ':']).next().unwrap_or(full).trim()
}


// function_definition 无 name field（tree-sitter-c/cpp）：名字在 declarator 链末端的 identifier / field_identifier
fn function_name_node(node: Node) -> Option<Node> {
    let mut cur = node.child_by_field_name("declarator")?;
    for _ in 0..8 {
        if let Some(d) = cur.child_by_field_name("declarator") {
            cur = d;
        } else {
            break;
        }
    }
    if matches!(cur.kind(), "identifier" | "field_identifier" | "type_identifier") {
        return Some(cur);
    }
    for i in 0..cur.child_count() {
        if let Some(c) = cur.child(i) {
            if matches!(c.kind(), "identifier" | "field_identifier" | "type_identifier") {
                return Some(c);
            }
        }
    }
    None
}

// declarator 链递归找末端标识符：`int x = 5` -> x；`int *p` -> p；`Foo obj` -> obj
fn declarator_identifier(decl: Node) -> Option<Node> {
    if let Some(d) = decl.child_by_field_name("declarator") {
        if let Some(id) = declarator_identifier(d) {
            return Some(id);
        }
    }
    if matches!(decl.kind(), "identifier" | "field_identifier" | "type_identifier") {
        return Some(decl);
    }
    for i in 0..decl.child_count() {
        if let Some(c) = decl.child(i) {
            if matches!(c.kind(), "identifier" | "field_identifier" | "type_identifier") {
                return Some(c);
            }
        }
    }
    None
}

fn extract_typedef_name(node: Node, source: &str) -> Option<(String, u32, u32)> {
    // tree-sitter-c/cpp 的 typedef 无 declarator field：遍历子节点取最后一个 type_identifier（= 别名）
    let mut name_node: Option<Node> = None;
    for i in 0..node.child_count() {
        if let Some(c) = node.child(i) {
            if c.kind() == "type_identifier" {
                name_node = Some(c);
            }
        }
    }
    let name_node = name_node.or_else(|| declarator_identifier(node.child_by_field_name("declarator")?))?;
    Some((
        source[name_node.byte_range()].to_string(),
        name_node.start_position().row as u32 + 1,
        name_node.end_position().row as u32 + 1,
    ))
}

fn push_variables_from_declaration(node: Node, source: &str, symbols: &mut Vec<Symbol>, in_class: bool) {
    if in_class { return; }
    for i in 0..node.child_count() {
        if let Some(c) = node.child(i) {
            if c.kind() == "declarator" {
                if let Some(id) = declarator_identifier(c) {
                    symbols.push(Symbol {
                        name: source[id.byte_range()].to_string(),
                        kind: "variable".to_string(),
                        start_line: id.start_position().row as u32 + 1,
                        end_line: id.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
        }
    }
}

// field_declaration 内的方法声明：`void foo(int x);` -> declarator: function_declarator
fn push_method_from_field_declaration(node: Node, source: &str, class_ctx: Option<&str>, symbols: &mut Vec<Symbol>) {
    if class_ctx.is_none() { return; }
    for i in 0..node.child_count() {
        if let Some(c) = node.child(i) {
            if c.kind() == "function_declarator" {
                if let Some(n) = declarator_identifier(c) {
                    symbols.push(Symbol {
                        name: source[n.byte_range()].to_string(),
                        kind: "method".to_string(),
                        start_line: n.start_position().row as u32 + 1,
                        end_line: n.end_position().row as u32 + 1,
                        impl_for: class_ctx.map(str::to_string),
                    });
                }
            }
        }
    }
}

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, class_ctx: Option<&str>, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_definition" => {
                if let Some(name_node) = function_name_node(node) {
                    // 类体内定义的方法：kind=method + impl_for=类名；自由函数：kind=function
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: if class_ctx.is_some() { "method".to_string() } else { "function".to_string() },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: class_ctx.map(str::to_string),
                    });
                }
            }
            "class_specifier" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                    let ctx = Some(source[name_node.byte_range()].to_string());
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            walk(child, source, depth + 1, ctx.as_deref(), symbols, refs);
                        }
                    }
                    return;
                }
            }
            "struct_specifier" | "enum_specifier" => {
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
            "union_specifier" => {
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
            "type_definition" => {
                if let Some((name, sl, el)) = extract_typedef_name(node, source) {
                    symbols.push(Symbol {
                        name,
                        kind: "type".to_string(),
                        start_line: sl,
                        end_line: el,
                        impl_for: None,
                    });
                }
            }
            "preproc_def" | "preproc_function_def" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "variable".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "field_declaration" => {
                push_method_from_field_declaration(node, source, class_ctx, symbols);
                push_variables_from_declaration(node, source, symbols, true);
            }
            "declaration" => {
                push_variables_from_declaration(node, source, symbols, false);
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let full = &source[fn_node.byte_range()];
                    let last = last_segment(full);
                    if !last.is_empty() && !is_noise_call(last) && !is_noise_call(full) {
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
            "preproc_include" => {
                if let Some(p) = node.child_by_field_name("path") {
                    let target = source[p.byte_range()].trim_matches('"').trim_matches('<').trim_matches('>').to_string();
                    refs.push(Reference {
                        kind: "import".to_string(),
                        name: String::new(),
                        line: node.start_position().row as u32 + 1,
                        module: Some(target),
                        symbols: Some(vec![]),
                    });
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, class_ctx, symbols, refs);
            }
        }
    }

    walk(tree.root_node(), source, 0, None, &mut symbols, &mut refs);

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

    fn walk(node: Node, source: &str, depth: u32, class_ctx: Option<&str>, symbols: &mut Vec<Symbol>, imports: &mut Vec<Import>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_definition" => {
                if let Some(name_node) = function_name_node(node) {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: if class_ctx.is_some() { "method".to_string() } else { "function".to_string() },
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: class_ctx.map(str::to_string),
                    });
                }
            }
            "class_specifier" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "class".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                    let ctx = Some(source[name_node.byte_range()].to_string());
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            walk(child, source, depth + 1, ctx.as_deref(), symbols, imports);
                        }
                    }
                    return;
                }
            }
            "struct_specifier" | "enum_specifier" => {
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
            "union_specifier" => {
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
            "type_definition" => {
                if let Some((name, sl, el)) = extract_typedef_name(node, source) {
                    symbols.push(Symbol {
                        name,
                        kind: "type".to_string(),
                        start_line: sl,
                        end_line: el,
                        impl_for: None,
                    });
                }
            }
            "preproc_def" | "preproc_function_def" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "variable".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "field_declaration" => {
                push_method_from_field_declaration(node, source, class_ctx, symbols);
                push_variables_from_declaration(node, source, symbols, true);
            }
            "declaration" => {
                push_variables_from_declaration(node, source, symbols, false);
            }
            "preproc_include" => {
                if let Some(p) = node.child_by_field_name("path") {
                    let target = source[p.byte_range()].trim_matches('"').trim_matches('<').trim_matches('>').to_string();
                    imports.push(Import { target, kind: "import".to_string() });
                }
            }
            _ => {}
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(child, source, depth + 1, class_ctx, symbols, imports);
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
            "function_definition" => {
                if let Some(name_node) = function_name_node(node) {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "fn".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "class_specifier" | "struct_specifier" | "enum_specifier" => {
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
            "union_specifier" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "type".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "type_definition" => {
                if let Some((name, sl, el)) = extract_typedef_name(node, source) {
                    syms.push(Symbol {
                        name,
                        kind: "type".to_string(),
                        start_line: sl,
                        end_line: el,
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

    fn walk(node: Node, source: &str, depth: u32, refs: &mut Vec<Reference>) {
        if depth > super::MAX_WALK_DEPTH { return; }
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                let full = &source[fn_node.byte_range()];
                let last = last_segment(full);
                if !last.is_empty() && !is_noise_call(last) && !is_noise_call(full) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: full.to_string(),
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
                }
            }
        } else if node.kind() == "preproc_include" {
            if let Some(p) = node.child_by_field_name("path") {
                let target = source[p.byte_range()].trim_matches('"').trim_matches('<').trim_matches('>').to_string();
                refs.push(Reference {
                    kind: "import".to_string(),
                    name: String::new(),
                    line: node.start_position().row as u32 + 1,
                    module: Some(target),
                    symbols: Some(vec![]),
                });
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_cpp(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_cpp::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(src, None).unwrap()
    }

    #[test]
    fn test_cpp_class_methods() {
        let src = r#"
#include <vector>
namespace util {
class Greeter {
public:
    Greeter();
    void hello(const std::string& name);
    int greet_count();
private:
    int count = 0;
};
}
Greeter::Greeter() { count = 0; }
void Greeter::hello(const std::string& name) { printf("hi %s", name.c_str()); }
int Greeter::greet_count() { return count; }
int main() { Greeter g; g.hello("x"); return 0; }
"#;
        let tree = parse_cpp(src);
        let result = extract_all(&tree, src);
        let syms: Vec<(String, String)> = result.symbols.iter().map(|s| (s.name.clone(), s.kind.clone())).collect();
        assert!(syms.contains(&("Greeter".into(), "class".into())), "class Greeter: {:?}", syms);
        assert!(syms.contains(&("hello".into(), "method".into())), "method hello: {:?}", syms);
        assert!(syms.contains(&("greet_count".into(), "method".into())), "method greet_count: {:?}", syms);
        assert!(syms.contains(&("main".into(), "function".into())), "fn main: {:?}", syms);
        assert!(!syms.contains(&("count".into(), "variable".into())), "member var skipped: {:?}", syms);
        let refs: Vec<(String, String)> = result.refs.iter().map(|r| (r.name.clone(), r.kind.clone())).collect();
        assert!(refs.contains(&("g.hello".into(), "call".into())) || refs.iter().any(|(n, k)| n.ends_with("hello") && k == "call"), "call g.hello: {:?}", refs);
        let mods: Vec<&str> = result.refs.iter().filter(|r| r.kind == "import").map(|r| r.module.as_deref().unwrap_or("")).collect();
        assert!(mods.contains(&"vector"), "include vector: {:?}", mods);
    }
}
