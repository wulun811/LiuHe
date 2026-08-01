use std::collections::HashMap;
use std::sync::Mutex;
use tree_sitter::{Language, Parser};

pub struct ParserPool {
    languages: HashMap<String, Language>,
    parsers: Mutex<HashMap<String, Parser>>,
}

impl ParserPool {
    pub fn new() -> Self {
        let mut languages = HashMap::new();

        languages.insert("javascript".to_string(), tree_sitter_javascript::LANGUAGE.into());
        languages.insert("typescript".to_string(), tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        languages.insert("tsx".to_string(), tree_sitter_typescript::LANGUAGE_TSX.into());
        languages.insert("python".to_string(), tree_sitter_python::LANGUAGE.into());
        languages.insert("go".to_string(), tree_sitter_go::LANGUAGE.into());
        languages.insert("rust".to_string(), tree_sitter_rust::LANGUAGE.into());
        languages.insert("c".to_string(), tree_sitter_c::LANGUAGE.into());
        languages.insert("cpp".to_string(), tree_sitter_cpp::LANGUAGE.into());
        languages.insert("java".to_string(), tree_sitter_java::LANGUAGE.into());
        languages.insert("bash".to_string(), tree_sitter_bash::LANGUAGE.into());

        Self {
            languages,
            parsers: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_language(&self, name: &str) -> Option<&Language> {
        self.languages.get(name)
    }

    pub fn supported_languages(&self) -> Vec<String> {
        self.languages.keys().cloned().collect()
    }

    pub fn parse(&self, source: &str, language: &str) -> Result<tree_sitter::Tree, String> {
        let lang = self.languages.get(language)
            .ok_or_else(|| format!("unsupported language: {}", language))?;

        let mut parser = {
            let mut parsers = self.parsers.lock().unwrap();
            parsers.remove(language).unwrap_or_else(|| {
                let mut p = Parser::new();
                p.set_language(lang).expect("failed to set language");
                p
            })
        };

        let tree = parser.parse(source, None)
            .ok_or_else(|| "parse failed".to_string())?;

        self.parsers.lock().unwrap().insert(language.to_string(), parser);

        Ok(tree)
    }
}

impl Default for ParserPool {
    fn default() -> Self {
        Self::new()
    }
}

pub fn ext_to_language(ext: &str) -> Option<&'static str> {
    match ext {
        ".js" | ".mjs" | ".cjs" => Some("javascript"),
        ".ts" | ".mts" | ".cts" => Some("typescript"),
        ".tsx" => Some("tsx"),
        ".py" => Some("python"),
        ".go" => Some("go"),
        ".rs" => Some("rust"),
        ".c" => Some("c"),
        ".h" => Some("c"),
        ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx" => Some("cpp"),
        ".java" => Some("java"),
        ".sh" | ".bash" => Some("bash"),
        _ => None,
    }
}

pub fn ext_to_language_name(ext: &str) -> Option<&'static str> {
    ext_to_language(ext)
}
