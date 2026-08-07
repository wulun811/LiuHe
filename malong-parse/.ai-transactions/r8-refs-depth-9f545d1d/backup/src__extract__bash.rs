use tree_sitter::{Node, Tree};
use super::{Symbol, Import, Reference, has_error_node};

// Shell 常用内置命令/外部工具——作为调用目标无 blast-radius 意义，过滤
const NOISE_COMMANDS: &[&str] = &[
    "echo", "printf", "cd", "pwd", "ls", "dir", "mkdir", "rmdir", "rm", "cp", "mv", "touch",
    "cat", "more", "less", "head", "tail", "grep", "egrep", "fgrep", "sed", "awk", "cut",
    "sort", "uniq", "wc", "tr", "diff", "patch", "tar", "gzip", "gunzip", "bzip2", "xz",
    "unzip", "zip", "make", "cmake", "gcc", "g++", "clang", "cc", "python", "python3",
    "node", "npm", "npx", "yarn", "pnpm", "go", "rustc", "cargo", "java", "javac",
    "ssh", "scp", "curl", "wget", "exit", "return", "export", "read", "test", "true",
    "false", "exec", "shift", "set", "unset", "declare", "local", "readonly", "trap",
    "source", ".", "eval", "let", "case", "in", "esac", "done", "fi", "then", "else",
    "elif", "for", "while", "until", "if", "do", "function", "break", "continue",
    "sudo", "apt", "apt-get", "yum", "dnf", "pip", "pip3", "git", "find", "xargs",
    "chmod", "chown", "chgrp", "ln", "stat", "du", "df", "free", "top", "ps", "kill",
    "sleep", "date", "basename", "dirname", "realpath", "readlink", "which", "whereis",
    "env", "nohup", "bg", "fg", "jobs", "ulimit", "umask", "hash", "command", "type",
    "killall", "pkill", "pgrep", "id", "whoami", "hostname", "uname", "uptime", "wc",
];

#[inline]
fn is_noise_command(name: &str) -> bool {
    NOISE_COMMANDS.contains(&name)
}

fn command_name_text(node: Node, source: &str) -> Option<String> {
    // command 的 name 字段：command_name / variable_name / string
    let name_node = node.child_by_field_name("name")?;
    Some(source[name_node.byte_range()].to_string())
}

// `source file.sh` / `. file.sh` 的导入目标：name 节点之后的第一个 word/argument
fn source_target(node: Node, source: &str) -> Option<String> {
    let name_id = node.child_by_field_name("name").map(|n| n.id());
    for i in 0..node.child_count() {
        if let Some(c) = node.child(i) {
            if Some(c.id()) == name_id { continue; }
            if c.kind() == "word" || c.kind() == "argument" {
                let t = source[c.byte_range()].trim_matches('"').trim_matches('\'').to_string();
                if !t.is_empty() { return Some(t); }
            }
        }
    }
    None
}

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
            "variable_assignment" => {
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
            "command" => {
                let name = command_name_text(node, source).unwrap_or_default();
                if !name.is_empty() && (name == "source" || name == ".") {
                    // source 文件 / . 文件 -> import
                    if let Some(target) = source_target(node, source) {
                        refs.push(Reference {
                            kind: "import".to_string(),
                            name: String::new(),
                            line: node.start_position().row as u32 + 1,
                            module: Some(target),
                            symbols: Some(vec![]),
                        });
                    }
                } else if !name.is_empty() && !is_noise_command(&name) {
                    refs.push(Reference {
                        kind: "call".to_string(),
                        name: name.clone(),
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
            "variable_assignment" => {
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
            "command" => {
                let name = command_name_text(node, source).unwrap_or_default();
                if name == "source" || name == "." {
                    if let Some(target) = source_target(node, source) {
                        imports.push(Import { target, kind: "import".to_string() });
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
            "variable_assignment" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    syms.push(Symbol {
                        name: source[name_node.byte_range()].to_string(),
                        kind: "const".to_string(),
                        start_line: name_node.start_position().row as u32 + 1,
                        end_line: name_node.end_position().row as u32 + 1,
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
        if node.kind() == "command" {
            let name = command_name_text(node, source).unwrap_or_default();
            if !name.is_empty() && (name == "source" || name == ".") {
                if let Some(target) = source_target(node, source) {
                    refs.push(Reference {
                        kind: "import".to_string(),
                        name: String::new(),
                        line: node.start_position().row as u32 + 1,
                        module: Some(target),
                        symbols: Some(vec![]),
                    });
                }
            } else if !name.is_empty() && !is_noise_command(&name) {
                refs.push(Reference {
                    kind: "call".to_string(),
                    name: name.clone(),
                    line: node.start_position().row as u32 + 1,
                    module: None,
                    symbols: None,
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

    fn parse_bash(src: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_bash::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(src, None).unwrap()
    }


    #[test]
    fn test_bash_extract_basic() {
        let src = r#"
#!/bin/bash
source ./lib.sh
VERSION=1.0
deploy() {
    echo "deploying $VERSION"
    do_build --force
}
run_checks() {
    do_build --fast
}
deploy
"#;
        let tree = parse_bash(src);
        let result = extract_all(&tree, src);
        let syms: Vec<(String, String)> = result.symbols.iter().map(|s| (s.name.clone(), s.kind.clone())).collect();
        assert!(syms.contains(&("deploy".into(), "function".into())), "fn deploy: {:?}", syms);
        assert!(syms.contains(&("run_checks".into(), "function".into())), "fn run_checks: {:?}", syms);
        assert!(syms.contains(&("VERSION".into(), "variable".into())), "var VERSION: {:?}", syms);
        let refs: Vec<(String, String)> = result.refs.iter().map(|r| (r.name.clone(), r.kind.clone())).collect();
        assert!(refs.contains(&("do_build".into(), "call".into())), "call do_build: {:?}", refs);
        assert!(!refs.iter().any(|(n, k)| n == "echo" && k == "call"), "echo filtered: {:?}", refs);
        let mods: Vec<&str> = result.refs.iter().filter(|r| r.kind == "import").map(|r| r.module.as_deref().unwrap_or("")).collect();
        assert!(mods.contains(&"./lib.sh"), "source ./lib.sh: {:?}", mods);
    }
}
