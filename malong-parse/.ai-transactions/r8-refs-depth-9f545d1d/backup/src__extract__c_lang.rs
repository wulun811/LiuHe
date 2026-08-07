use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

// C 语言常见 stdlib 噪声调用（printf 家族/内存/字符串/数学），blast-radius 无意义，索引时丢弃
const NOISE_CALLEES: &[&str] = &[
    "printf", "fprintf", "sprintf", "snprintf", "vprintf", "vfprintf", "vsprintf", "vsnprintf",
    "puts", "putchar", "fputs", "fputc", "getchar", "getc", "fgetc", "gets", "fgets", "scanf",
    "fscanf", "sscanf", "perror", "fwrite", "fread", "fopen", "fclose", "fflush", "feof", "ferror",
    "fseek", "ftell", "rewind", "remove", "rename", "tmpfile", "setbuf", "setvbuf",
    "malloc", "calloc", "realloc", "free", "memcpy", "memmove", "memset", "memcmp", "memchr",
    "strlen", "strcpy", "strncpy", "strcat", "strncat", "strcmp", "strncmp", "strchr", "strrchr",
    "strstr", "strtok", "strdup", "atoi", "atol", "atoll", "atof", "strtol", "strtoul", "strtod",
    "exit", "abort", "assert", "rand", "srand", "time", "clock", "abs", "labs", "llabs",
    "pow", "sqrt", "floor", "ceil", "fabs", "fmod", "log", "log10", "exp", "sin", "cos", "tan",
    "isdigit", "isalpha", "isalnum", "isspace", "tolower", "toupper", "sizeof",
];

#[inline]
fn is_noise_call(name: &str) -> bool {
    NOISE_CALLEES.contains(&name)
}

// 取调用表达式末段：obj.method(args) -> method
#[inline]
fn last_segment(full: &str) -> &str {
    full.rsplit(['.', '>', '-']).next().unwrap_or(full).trim()
}

// function_definition 无 name field（tree-sitter-c/cpp）：名字在 declarator → function_declarator → declarator 链末端的 identifier
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

// declarator 链递归找末端标识符：`int x = 5` -> x；`int *p` -> p；`int arr[5]` -> arr
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

fn push_variables_from_declaration(node: Node, source: &str, symbols: &mut Vec<Symbol>) {
    // `int x = 5, y;` -> declarator -> identifier 提取变量；跳过函数指针/数组等复杂 declarator
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

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "function_definition" => {
                if let Some(name_node) = function_name_node(node) {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "function".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
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
            "declaration" => {
                push_variables_from_declaration(node, source, symbols);
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let full = &source[fn_node.byte_range()];
                    let last = last_segment(full);
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
            "function_definition" => {
                if let Some(name_node) = function_name_node(node) {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "function".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
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
            "declaration" => {
                push_variables_from_declaration(node, source, symbols);
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
            "struct_specifier" | "enum_specifier" => {
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

    fn walk(node: Node, source: &str, refs: &mut Vec<Reference>) {
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                let full = &source[fn_node.byte_range()];
                let last = last_segment(full);
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

    fn parse_c(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_c::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(src, None).unwrap()
    }

    #[test]
    fn test_c_extract_basic() {
        let src = r#"
#include <stdio.h>
#include "local.h"
#define MAX_SIZE 100
typedef struct Point { int x; } Point;
struct Rect { int w; int h; };
enum Color { RED, GREEN };
static int counter = 0;
int add(int a, int b) { return a + b; }
int main() { int x = add(1, 2); printf("%d", x); return 0; }
"#;
        let tree = parse_c(src);
        let result = extract_all(&tree, src);
        let syms: Vec<(String, String)> = result.symbols.iter().map(|s| (s.name.clone(), s.kind.clone())).collect();
        assert!(syms.contains(&("add".into(), "function".into())), "fn add: {:?}", syms);
        assert!(syms.contains(&("main".into(), "function".into())));
        assert!(syms.contains(&("Rect".into(), "class".into())), "struct Rect: {:?}", syms);
        assert!(syms.contains(&("Color".into(), "class".into())), "enum Color: {:?}", syms);
        assert!(syms.contains(&("Point".into(), "type".into())), "typedef Point: {:?}", syms);
        assert!(syms.contains(&("MAX_SIZE".into(), "variable".into())), "define MAX_SIZE: {:?}", syms);
        let refs: Vec<(String, String)> = result.refs.iter().map(|r| (r.name.clone(), r.kind.clone())).collect();
        assert!(refs.contains(&("add".into(), "call".into())), "call add: {:?}", refs);
        assert!(!refs.iter().any(|(n, k)| n == "printf" && k == "call"), "printf filtered: {:?}", refs);
        let mods: Vec<&str> = result.refs.iter().filter(|r| r.kind == "import").map(|r| r.module.as_deref().unwrap_or("")).collect();
        assert!(mods.contains(&"stdio.h"), "include stdio.h: {:?}", mods);
        assert!(mods.contains(&"local.h"), "include local.h: {:?}", mods);
    }

}
