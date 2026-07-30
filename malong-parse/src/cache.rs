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
