use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

// Java 常见 JDK 噪声调用（打印/集合/字符串/Object 基础方法）
const NOISE_CALLEES: &[&str] = &[
    "System.out.println", "System.out.print", "System.out.printf", "System.err.println",
    "System.err.print", "System.err.printf", "printStackTrace", "toString", "hashCode",
    "equals", "notify", "notifyAll", "wait", "getClass", "clone", "finalize",
    "Integer.parseInt", "Long.parseLong", "Double.parseDouble", "Float.parseFloat",
    "Boolean.parseBoolean", "String.valueOf", "String.format", "String.join",
    "Math.max", "Math.min", "Math.abs", "Math.pow", "Math.sqrt", "Math.floor", "Math.ceil",
    "Math.round", "Math.random", "Arrays.asList", "Arrays.sort", "Arrays.copyOf",
    "Collections.sort", "Collections.emptyList", "Optional.of", "Optional.ofNullable",
    "Objects.requireNonNull", "Objects.equals", "Objects.hash",
    "List.of", "Set.of", "Map.of", "new ArrayList", "new HashMap", "new HashSet",
    "add", "get", "set", "remove", "size", "isEmpty", "contains", "stream", "forEach",
    "map", "filter", "collect", "orElse", "orElseGet", "orElseThrow", "length", "charAt",
    "substring", "split", "trim", "toUpperCase", "toLowerCase", "startsWith", "endsWith",
    "containsKey", "containsValue", "put", "keySet", "entrySet", "values", "append",
    "printStackTrace", "getMessage", "getCause", "super", "this",
];

#[inline]
fn is_noise_call(name: &str) -> bool {
    NOISE_CALLEES.contains(&name)
}

// tree-sitter-java 的 import_declaration 无 scope/name field：名字全在 scoped_identifier 子树里
fn import_module(node: Node, source: &str) -> Option<String> {
    let mut scope: Option<Node> = None;
    let mut bare: Option<Node> = None;
    let mut star = false;
    for i in 0..node.child_count() {
        if let Some(c) = node.child(i) {
            if c.kind() == "scoped_identifier" {
                scope = Some(c);
                for j in 0..c.child_count() {
                    if let Some(s) = c.child(j) {
                        if s.kind() == "asterisk" || (s.kind() == "identifier" && &source[s.byte_range()] == "*") {
                            star = true;
                        }
                    }
                }
            } else if c.kind() == "asterisk" {
                star = true;
            } else if c.kind() == "identifier" {
                let txt = source[c.byte_range()].to_string();
                if txt == "*" || txt == "asterisk" {
                    star = true;
                } else if bare.is_none() {
                    bare = Some(c);
                }
            }
        }
    }
    if let Some(sc) = scope {
        let mut t = source[sc.byte_range()].to_string();
        if star {
            t.push_str(".*");
        }
        Some(t)
    } else {
        bare.map(|b| source[b.byte_range()].to_string())
    }
}

#[inline]
fn last_segment(full: &str) -> &str {
    full.rsplit(['.', '>']).next().unwrap_or(full).trim()
}

pub fn extract_all(tree: &Tree, source: &str) -> super::ExtractResult {
    let mut symbols = Vec::new();
    let mut refs = Vec::new();

    fn walk(node: Node, source: &str, depth: u32, symbols: &mut Vec<Symbol>, refs: &mut Vec<Reference>) {
        if depth > 100 { return; }

        match node.kind() {
            "class_declaration" | "record_declaration" | "enum_declaration" => {
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
            "interface_declaration" => {
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
            "annotation_type_declaration" => {
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
            "method_declaration" | "constructor_declaration" => {
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
            "variable_declarator" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "variable".to_string(),
                        start_line: name_node.start_position().row as u32 + 1,
                        end_line: name_node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "method_invocation" => {
                let name = node.child_by_field_name("name")
                    .map(|n| source[n.byte_range()].to_string())
                    .unwrap_or_default();
                if name.is_empty() { return; }
                let object = node.child_by_field_name("object")
                    .map(|o| source[o.byte_range()].to_string())
                    .unwrap_or_default();
                let full = if object.is_empty() { name.clone() } else { format!("{}.{}", object, name) };
                let last = last_segment(&full);
                if !last.is_empty() && !is_noise_call(last) && !is_noise_call(&full) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: full,
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
                }
            }
            "import_declaration" => {
                if let Some(module) = import_module(node, source) {
                    refs.push(Reference {
                        kind: "import".to_string(),
                        name: String::new(),
                        line: node.start_position().row as u32 + 1,
                        module: Some(module),
                        symbols: Some(vec![]),
                    });
                }
            }
                        "object_creation_expression" => {
                if let Some(type_node) = node.child_by_field_name("type") {
                    let type_name = source[type_node.byte_range()].to_string();
                    if !type_name.is_empty() {
                        refs.push(Reference {
                            kind: "call".to_string(),
                            name: format!("new {}", type_name),
                            line: node.start_position().row as u32 + 1,
                            module: None,
                            symbols: None,
                        });
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
            "class_declaration" | "record_declaration" | "enum_declaration" => {
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
            "interface_declaration" => {
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
            "annotation_type_declaration" => {
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
            "method_declaration" | "constructor_declaration" => {
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
            "variable_declarator" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    symbols.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "variable".to_string(),
                        start_line: name_node.start_position().row as u32 + 1,
                        end_line: name_node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "import_declaration" => {
                if let Some(target) = import_module(node, source) {
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
            "class_declaration" | "record_declaration" | "enum_declaration" => {
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
            "interface_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "interface".to_string(),
                        start_line: node.start_position().row as u32 + 1,
                        end_line: node.end_position().row as u32 + 1,
                        impl_for: None,
                    });
                }
            }
            "annotation_type_declaration" => {
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
        if node.kind() == "method_invocation" {
            let name = node.child_by_field_name("name")
                .map(|n| source[n.byte_range()].to_string())
                .unwrap_or_default();
            if !name.is_empty() {
                let object = node.child_by_field_name("object")
                    .map(|o| source[o.byte_range()].to_string())
                    .unwrap_or_default();
                let full = if object.is_empty() { name.clone() } else { format!("{}.{}", object, name) };
                let last = last_segment(&full);
                if !last.is_empty() && !is_noise_call(last) && !is_noise_call(&full) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: full,
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
                }
            }
        } else if node.kind() == "import_declaration" {
            if let Some(module) = import_module(node, source) {
                refs.push(Reference {
                    kind: "import".to_string(),
                    name: String::new(),
                    line: node.start_position().row as u32 + 1,
                    module: Some(module),
                    symbols: Some(vec![]),
                });
            }
        } else if node.kind() == "object_creation_expression" {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = source[type_node.byte_range()].to_string();
                if !type_name.is_empty() {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: format!("new {}", type_name),
                        line: node.start_position().row as u32 + 1,
                        module: None,
                        symbols: None,
                    });
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

    fn parse_java(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_java::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(src, None).unwrap()
    }

    #[test]
    fn test_java_extract_basic() {
        let src = r#"
import java.util.List;
import java.io.IOException;
public class User {
    private int id;
    public User(int id) { this.id = id; }
    public String greet(String name) {
        String msg = "hi " + name;
        System.out.println(msg);
        return msg;
    }
    public static void main(String[] args) {
        User u = new User(1);
        u.greet("x");
    }
}
interface Walker { void walk(); }
enum Status { OK, FAIL }
"#;
        let tree = parse_java(src);
        let result = extract_all(&tree, src);
        let syms: Vec<(String, String)> = result.symbols.iter().map(|s| (s.name.clone(), s.kind.clone())).collect();
        assert!(syms.contains(&("User".into(), "class".into())), "class User: {:?}", syms);
        assert!(syms.contains(&("greet".into(), "method".into())), "method greet: {:?}", syms);
        assert!(syms.contains(&("User".into(), "method".into())), "constructor: {:?}", syms);
        assert!(syms.contains(&("Walker".into(), "interface".into())), "interface Walker: {:?}", syms);
        assert!(syms.contains(&("Status".into(), "class".into())), "enum Status: {:?}", syms);
        let refs: Vec<(String, String)> = result.refs.iter().map(|r| (r.name.clone(), r.kind.clone())).collect();
        assert!(refs.iter().any(|(n, k)| n == "u.greet" && k == "call"), "call u.greet: {:?}", refs);
        assert!(refs.iter().any(|(n, k)| n == "new User" && k == "call"), "call new User: {:?}", refs);
        assert!(!refs.iter().any(|(n, k)| n == "System.out.println" && k == "call"), "println filtered: {:?}", refs);
        let mods: Vec<&str> = result.refs.iter().filter(|r| r.kind == "import").map(|r| r.module.as_deref().unwrap_or("")).collect();
        assert!(mods.contains(&"java.util.List"), "import List: {:?}", mods);
        assert!(mods.contains(&"java.io.IOException"), "import IOException: {:?}", mods);
    }

}
