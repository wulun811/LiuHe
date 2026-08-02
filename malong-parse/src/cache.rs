use std::time::{Duration, Instant};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use lru::LruCache;
use tree_sitter::Tree;

const MAX_ENTRIES: usize = 100;
const MAX_MEMORY_BYTES: u64 = 50 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(300);

const SOURCE_CACHE_MAX: usize = 50;
const SOURCE_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct CacheKey {
    pub canonical_path: String,
    pub mtime: u64,
    pub size: u64,
}

struct CachedEntry {
    tree: Tree,
    source: String,
    language: String,
    created_at: Instant,
    size_bytes: u64,
}

pub struct TreeCache {
    entries: LruCache<CacheKey, CachedEntry>,
    total_memory: u64,
    hits: u64,
    misses: u64,
}

impl TreeCache {
    pub fn new() -> Self {
        Self {
            entries: LruCache::new(std::num::NonZeroUsize::new(MAX_ENTRIES).unwrap()),
            total_memory: 0,
            hits: 0,
            misses: 0,
        }
    }

    pub fn get(&mut self, file_path: &str) -> Option<(&Tree, &str, &str)> {
        let metadata = std::fs::metadata(file_path).ok()?;
        let mtime = metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        let size = metadata.len();
        let canonical = std::fs::canonicalize(file_path).ok()?;
        let key_str = canonical.to_string_lossy().to_string();
        let key = CacheKey { canonical_path: key_str, mtime, size };

        if let Some(entry) = self.entries.get(&key) {
            if entry.created_at.elapsed() > TTL {
                self.misses += 1;
                return None;
            }
            self.hits += 1;
            Some((&entry.tree, &entry.source, &entry.language))
        } else {
            self.misses += 1;
            None
        }
    }

    pub fn insert(&mut self, file_path: &str, tree: Tree, source: String, language: String) {
        let metadata = match std::fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let mtime = match metadata.modified() {
            Ok(t) => t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
            Err(_) => 0,
        };
        let size = metadata.len();
        let canonical = match std::fs::canonicalize(file_path) {
            Ok(p) => p,
            Err(_) => return,
        };
        let key = CacheKey {
            canonical_path: canonical.to_string_lossy().to_string(),
            mtime,
            size,
        };

        let entry_size = (source.len() * 4) as u64 + language.len() as u64;
        if entry_size > MAX_MEMORY_BYTES {
            return;
        }

        while self.total_memory + entry_size > MAX_MEMORY_BYTES && self.entries.len() > 0 {
            if let Some((_, evicted)) = self.entries.pop_lru() {
                self.total_memory = self.total_memory.saturating_sub(evicted.size_bytes);
            }
        }

        if let Some(old) = self.entries.peek(&key) {
            self.total_memory = self.total_memory.saturating_sub(old.size_bytes);
        }

        self.total_memory += entry_size;
        self.entries.put(key, CachedEntry {
            tree,
            source,
            language,
            created_at: Instant::now(),
            size_bytes: entry_size,
        });
    }

    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({
            "entries": self.entries.len(),
            "max_entries": MAX_ENTRIES,
            "total_memory_bytes": self.total_memory,
            "max_memory_bytes": MAX_MEMORY_BYTES,
            "hits": self.hits,
            "misses": self.misses,
            "hit_ratio": if self.hits + self.misses > 0 { self.hits as f64 / (self.hits + self.misses) as f64 } else { 0.0 },
            "ttl_secs": TTL.as_secs(),
        })
    }
}

fn content_hash(source: &str, ext: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    ext.hash(&mut hasher);
    hasher.finish()
}

struct SourceCacheEntry {
    result: serde_json::Value,
    created_at: Instant,
}

pub struct SourceCache {
    entries: HashMap<u64, SourceCacheEntry>,
    order: Vec<u64>,
    hits: u64,
    misses: u64,
}

impl SourceCache {
    pub fn new() -> Self {
        Self { entries: HashMap::new(), order: Vec::new(), hits: 0, misses: 0 }
    }

    pub fn get(&mut self, source: &str, ext: &str) -> Option<serde_json::Value> {
        let key = content_hash(source, ext);
        let expired = self.entries.get(&key).map(|e| e.created_at.elapsed() > SOURCE_CACHE_TTL).unwrap_or(false);
        if expired {
            self.entries.remove(&key);
            self.order.retain(|k| *k != key);
            self.misses += 1;
            return None;
        }
        if let Some(entry) = self.entries.get(&key) {
            self.hits += 1;
            return Some(entry.result.clone());
        }
        self.misses += 1;
        None
    }

    pub fn insert(&mut self, source: &str, ext: &str, result: serde_json::Value) {
        let key = content_hash(source, ext);
        if self.entries.contains_key(&key) {
            self.entries.get_mut(&key).unwrap().result = result;
            return;
        }
        if self.entries.len() >= SOURCE_CACHE_MAX {
            if let Some(oldest) = self.order.first().copied() {
                self.entries.remove(&oldest);
                self.order.remove(0);
            }
        }
        self.order.push(key);
        self.entries.insert(key, SourceCacheEntry { result, created_at: Instant::now() });
    }

    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({
            "entries": self.entries.len(),
            "max_entries": SOURCE_CACHE_MAX,
            "hits": self.hits,
            "misses": self.misses,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_file(name: &str, content: &str) -> String {
        let path = std::env::temp_dir().join(format!("malong-cache-test-{}-{name}", std::process::id()));
        fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }

    fn sample_tree(source: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        let lang: tree_sitter::Language = tree_sitter_javascript::LANGUAGE.into();
        parser.set_language(&lang).unwrap();
        parser.parse(source, None).unwrap()
    }

    #[test]
    fn source_cache_hit_and_miss_counters() {
        let mut c = SourceCache::new();
        assert!(c.get("let x = 1", ".js").is_none(), "first get must miss");
        assert!(c.get("let x = 1", ".py").is_none(), "different ext must miss");
        c.insert("let x = 1", ".js", serde_json::json!({"symbols": []}));
        assert!(c.get("let x = 1", ".js").is_some(), "same source+ext must hit");
        let s = c.stats();
        assert_eq!(s["hits"], 1);
        assert_eq!(s["misses"], 2);
        assert_eq!(s["entries"], 1);
    }

    #[test]
    fn source_cache_reinsert_same_key_updates() {
        let mut c = SourceCache::new();
        c.insert("a", ".js", serde_json::json!({"v": 1}));
        c.insert("a", ".js", serde_json::json!({"v": 2}));
        assert_eq!(c.get("a", ".js").unwrap()["v"], 2, "reinsert must update value");
        assert_eq!(c.stats()["entries"], 1, "reinsert must not grow entries");
    }

    #[test]
    fn source_cache_evicts_oldest_over_max() {
        let mut c = SourceCache::new();
        for i in 0..SOURCE_CACHE_MAX + 5 {
            c.insert(&format!("src-{i}"), ".js", serde_json::json!({"i": i}));
        }
        let s = c.stats();
        assert_eq!(s["entries"], SOURCE_CACHE_MAX as u64, "capacity must cap at max");
        assert!(c.get("src-0", ".js").is_none(), "oldest must be evicted");
        assert!(c.get(&format!("src-{}", SOURCE_CACHE_MAX + 4), ".js").is_some(), "newest must survive");
    }

    #[test]
    fn source_cache_different_source_same_ext() {
        let mut c = SourceCache::new();
        c.insert("def f(): pass", ".py", serde_json::json!({"a": 1}));
        assert!(c.get("def g(): pass", ".py").is_none(), "different source must not collide");
    }

    #[test]
    fn tree_cache_insert_then_get_hits() {
        let mut c = TreeCache::new();
        let path = tmp_file("tree-hit.js", "function alpha() {}\nfunction beta() {}");
        let tree = sample_tree("function alpha() {}\nfunction beta() {}");
        c.insert(&path, tree, "function alpha() {}".into(), "javascript".into());
        let got = c.get(&path);
        assert!(got.is_some(), "same file must hit after insert");
        let (t, s, l) = got.unwrap();
        assert_eq!(s, "function alpha() {}");
        assert_eq!(l, "javascript");
        let st = c.stats();
        assert_eq!(st["hits"], 1);
        assert_eq!(st["misses"], 0);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn tree_cache_get_missing_file_misses() {
        let mut c = TreeCache::new();
        let missing = tmp_file("tree-miss.js", "");
        fs::remove_file(&missing).unwrap();
        assert!(c.get(&missing).is_none(), "nonexistent file must miss");
        // 设计行为：无法 stat 的文件在统计前提前返回，不累计 misses
        assert_eq!(c.stats()["misses"], 0);
    }

    #[test]
    fn tree_cache_empty_stats_shape() {
        let c = TreeCache::new();
        let s = c.stats();
        assert_eq!(s["entries"], 0);
        assert_eq!(s["max_entries"], MAX_ENTRIES as u64);
        assert_eq!(s["ttl_secs"], 300);
        assert_eq!(s["hit_ratio"], 0.0);
    }

    #[test]
    fn content_hash_deterministic_and_sensitive() {
        let h1 = content_hash("let x = 1", ".js");
        assert_eq!(h1, content_hash("let x = 1", ".js"), "same input must hash same");
        assert_ne!(h1, content_hash("let x = 2", ".js"), "source change must change hash");
        assert_ne!(h1, content_hash("let x = 1", ".py"), "ext change must change hash");
    }

    #[test]
    fn tree_cache_stats_after_evict_release_memory() {
        let mut c = TreeCache::new();
        let path = tmp_file("tree-evict.js", "let x = 1;");
        let tree = sample_tree("let x = 1;");
        c.insert(&path, tree, "let x = 1;".into(), "javascript".into());
        let before = c.stats()["total_memory_bytes"].as_u64().unwrap();
        assert!(before > 0);
        c.stats();
        // 再次插入同 key 不会重复计入内存
        let tree2 = sample_tree("let x = 1;");
        c.insert(&path, tree2, "let x = 1;".into(), "javascript".into());
        let after = c.stats()["total_memory_bytes"].as_u64().unwrap();
        assert_eq!(before, after, "reinsert of same key must not double-count memory");
        fs::remove_file(&path).ok();
    }
}
