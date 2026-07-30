use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::Semaphore;
use tracing::{info, warn, error};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};

use crate::cache::TreeCache;

use crate::parser_pool::ParserPool;
use crate::protocol::{Request, Response, encode_frame, decode_frame};
use crate::extract;
use crate::simplify;
use crate::classify;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONCURRENCY: usize = 16;

pub struct ServerState {
    pub parser_pool: ParserPool,
    pub start_time: Instant,
    pub requests_served: tokio::sync::Mutex<u64>,
    pub cache: std::sync::Mutex<TreeCache>,
    pub concurrency: Semaphore,
    pub lang_stats: std::sync::Mutex<HashMap<String, u64>>,
    pub sym_count_buckets: std::sync::Mutex<[u64; 5]>, // 0-10, 11-50, 51-200, 201-1000, 1000+
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            parser_pool: ParserPool::new(),
            start_time: Instant::now(),
            requests_served: tokio::sync::Mutex::new(0),
            cache: Mutex::new(TreeCache::new()),
            concurrency: Semaphore::new(MAX_CONCURRENCY),
            lang_stats: Mutex::new(HashMap::new()),
            sym_count_buckets: Mutex::new([0; 5]),
        }
    }
}

// Priority queue wrapper for requests
#[derive(Eq, PartialEq)]
struct PrioritizedRequest {
    request: Request,
    sequence: u64,  // For FIFO within same priority
}

impl Ord for PrioritizedRequest {
    fn cmp(&self, other: &Self) -> Ordering {
        // Higher priority first, then lower sequence (earlier) first
        other.request.priority.cmp(&self.request.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

impl PartialOrd for PrioritizedRequest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub async fn handle_connection(stream: UnixStream, state: Arc<ServerState>) {
    let (mut reader, mut writer) = stream.into_split();
    let mut buf = vec![0u8; 65536];
    let mut data = Vec::new();
    let mut request_queue: BinaryHeap<PrioritizedRequest> = BinaryHeap::new();
    let mut sequence = 0u64;

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                warn!("read error: {}", e);
                break;
            }
        };
        data.extend_from_slice(&buf[..n]);

        // Decode all available requests and add to priority queue
        while let Some((consumed, req)) = decode_frame(&data) {
            data.drain(..consumed);
            request_queue.push(PrioritizedRequest {
                request: req,
                sequence,
            });
            sequence += 1;
        }

        // Process requests from priority queue
        while let Some(prioritized) = request_queue.pop() {
            let response = handle_request(prioritized.request, &state).await;

            match encode_frame(&response) {
                Ok(frame) => {
                    if let Err(e) = writer.write_all(&frame).await {
                        warn!("write error: {}", e);
                        return;
                    }
                }
                Err(e) => {
                    error!("encode error: {}", e);
                }
            }
        }
    }
}

async fn handle_request(req: Request, state: &Arc<ServerState>) -> Response {
    // concurrency limit
    let _permit = match tokio::time::timeout(Duration::from_millis(500), state.concurrency.acquire()).await {
        Ok(Ok(permit)) => permit,
        _ => return Response::error(req.id, "SERVER_BUSY", "too many concurrent requests"),
    };

    let start = Instant::now();
    let state_arc = state.clone();
    let req_id = req.id.clone();
    let req_method = req.method.clone();

    let result = tokio::time::timeout(REQUEST_TIMEOUT, async move {
        match tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(req, &state_arc)))
        })
        .await
        {
            Ok(r) => r,
            Err(je) => Err(Box::new(je.to_string()) as Box<dyn std::any::Any + Send>),
        }
    })
    .await;

    let duration = start.elapsed();

    match result {
        Ok(Ok(resp)) => {
            let mut count = state.requests_served.lock().await;
            *count += 1;
            let ms = duration.as_millis();
            if ms > 100 {
                info!("SLOW {} {} -> {}ms", req_method, req_id, ms);
            } else {
                info!("{} {} -> {}ms", req_method, req_id, ms);
            }
            resp
        }
        Ok(Err(panic_info)) => {
            let msg = panic_info
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic_info.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());

            error!("PANIC in {}: {}", req_method, msg);
            Response::error_with_detail(req_id, "PARSE_PANIC", "tree-sitter panic recovered", msg)
        }
        Err(_) => {
            error!("TIMEOUT {} {} after {}ms", req_method, req_id, REQUEST_TIMEOUT.as_millis());
            Response::error(req_id, "REQUEST_TIMEOUT", "request timed out")
        }
    }
}

fn resolve_source(params: &serde_json::Value) -> Result<(String, String, String), String> {
    if let Some(source) = params["source"].as_str() {
        let ext = params["ext"].as_str().unwrap_or("");
        if source.len() > 1_000_000 {
            return Err("source exceeds 1MB limit".to_string());
        }
        Ok((source.to_string(), ext.to_string(), String::new()))
    } else if let Some(file_path) = params["file_path"].as_str() {
        if let Some(workspace_root) = params["workspace_root"].as_str() {
            let canonical_path = match std::fs::canonicalize(file_path) {
                Ok(p) => p,
                Err(_) => return Err("file path canonicalization failed".to_string()),
            };
            let canonical_root = match std::fs::canonicalize(workspace_root) {
                Ok(p) => p,
                Err(_) => return Err("workspace_root canonicalization failed".to_string()),
            };
            if !canonical_path.starts_with(&canonical_root) {
                return Err("file path is outside workspace root".to_string());
            }
        }

        let path = Path::new(file_path);
        let ext = path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();
        let metadata = match std::fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return Err("file not found".to_string()),
        };
        if metadata.len() > 1_000_000 {
            return Err("file exceeds 1MB limit".to_string());
        }
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => return Err("file read error".to_string()),
        };
        Ok((source, ext, file_path.to_string()))
    } else {
        Err("missing source or file_path parameter".to_string())
    }
}

fn record_stats(state: &ServerState, ext: &str, sym_count: usize) {
    if let Ok(mut lang_stats) = state.lang_stats.lock() {
        let lang = crate::parser_pool::ext_to_language_name(ext).unwrap_or("unknown").to_string();
        *lang_stats.entry(lang).or_insert(0) += 1;
    }
    if let Ok(mut buckets) = state.sym_count_buckets.lock() {
        let idx = if sym_count <= 10 { 0 } else if sym_count <= 50 { 1 } else if sym_count <= 200 { 2 } else if sym_count <= 1000 { 3 } else { 4 };
        buckets[idx] += 1;
    }
}

fn dispatch(req: Request, state: &ServerState) -> Response {
    let params = req.params;

    match req.method.as_str() {
        "health" => {
            let uptime = state.start_time.elapsed().as_secs();
            let count = state.requests_served.try_lock().map(|c| *c).unwrap_or(0);
            let cache_stats = state.cache.lock().unwrap().stats();
            let lang_stats = state.lang_stats.lock().unwrap();
            let sym_buckets = state.sym_count_buckets.lock().unwrap();
            Response::success(req.id, serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "uptime": uptime,
                "parsers_loaded": state.parser_pool.supported_languages(),
                "requests_served": count,
                "cache": cache_stats,
                "stats": {
                    "by_language": *lang_stats,
                    "symbol_counts": {
                        "0_10": sym_buckets[0],
                        "11_50": sym_buckets[1],
                        "51_200": sym_buckets[2],
                        "201_1000": sym_buckets[3],
                        "1000_plus": sym_buckets[4],
                    }
                },
            }))
        }

        "extract_all" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            if !file_path.is_empty() {
                let mut cache_lock = state.cache.lock().unwrap();
                if let Some((t, s, l)) = cache_lock.get(&file_path) {
                    let result = extract::extract_all(t, s, l);
                    record_stats(state, &ext, result.symbols.len());
                    return Response::success(req.id, serde_json::to_value(result).unwrap_or(serde_json::Value::Null));
                }
            }

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let result = extract::extract_all(&tree, &source, language);
                    record_stats(state, &ext, result.symbols.len());
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::to_value(result).unwrap())
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_symbols" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            if !file_path.is_empty() {
                let mut cache_lock = state.cache.lock().unwrap();
                if let Some((t, s, l)) = cache_lock.get(&file_path) {
                    let result = extract::extract_symbols(t, s, l);
                    return Response::success(req.id, serde_json::json!({ "symbols": result.0, "imports": result.1 }));
                }
            }

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let (symbols, imports) = extract::extract_symbols(&tree, &source, language);
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::json!({ "symbols": symbols, "imports": imports }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_top_level" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            if !file_path.is_empty() {
                let mut cache_lock = state.cache.lock().unwrap();
                if let Some((t, s, l)) = cache_lock.get(&file_path) {
                    let symbols = extract::extract_top_level(t, s, l);
                    return Response::success(req.id, serde_json::json!({ "symbols": symbols }));
                }
            }

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let symbols = extract::extract_top_level(&tree, &source, language);
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::json!({ "symbols": symbols }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_references" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            if !file_path.is_empty() {
                let mut cache_lock = state.cache.lock().unwrap();
                if let Some((t, s, l)) = cache_lock.get(&file_path) {
                    let refs = extract::extract_references(t, s, l);
                    return Response::success(req.id, serde_json::json!({ "refs": refs }));
                }
            }

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let refs = extract::extract_references(&tree, &source, language);
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::json!({ "refs": refs }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "has_errors" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let has_errors = extract::has_error_node(tree.root_node());
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::json!({ "has_errors": has_errors }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "simplify_ast" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };
            let max_depth = params["options"]["max_depth"].as_u64().unwrap_or(30) as u32;

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let ast = simplify::simplify_ast(tree.root_node(), &source, 0, max_depth);
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::to_value(ast).unwrap_or(serde_json::Value::Null))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "classify_message" => {
            let content = params["content"].as_str().unwrap_or("");

            let result = classify::classify_message(content, &state.parser_pool);
            Response::success(req.id, serde_json::to_value(result).unwrap())
        }

        "compute_metrics" => {
            let (source, ext, file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let metrics = extract::metrics::compute_metrics(&tree, &source, language);
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::to_value(metrics).unwrap())
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "batch_extract" => {
            let files = params["files"].as_array();
            if files.is_none() {
                return Response::error(req.id, "INVALID_PARAMS", "files array required");
            }

            let files = files.unwrap();
            let _concurrency = params["concurrency"].as_u64().unwrap_or(4) as usize;

            let results: Vec<serde_json::Value> = files.par_iter()
                .map(|f| {
                    let path = f["path"].as_str().unwrap_or("");
                    let file_path = f["file_path"].as_str().unwrap_or("");

                    // try cache first (file_path mode)
                    if !file_path.is_empty() {
                        let mut cache_lock = state.cache.lock().unwrap();
                        if let Some((t, s, l)) = cache_lock.get(file_path) {
                            let result = extract::extract_all(t, s, l);
                            return serde_json::json!({
                                "path": path,
                                "result": serde_json::to_value(result).unwrap()
                            });
                        }
                    }

                    // support both source and file_path
                    let source = if let Some(s) = f["source"].as_str() {
                        if s.len() > 1_000_000 {
                            return serde_json::json!({
                                "path": path,
                                "error": "FILE_TOO_LARGE"
                            });
                        }
                        s.to_string()
                    } else if !file_path.is_empty() {
                        let metadata = match std::fs::metadata(file_path) {
                            Ok(m) => m,
                            Err(_) => return serde_json::json!({ "path": path, "error": "FILE_NOT_FOUND" }),
                        };
                        if metadata.len() > 1_000_000 {
                            return serde_json::json!({ "path": path, "error": "FILE_TOO_LARGE" });
                        }
                        match std::fs::read_to_string(file_path) {
                            Ok(s) => s,
                            Err(_) => return serde_json::json!({ "path": path, "error": "FILE_READ_ERROR" }),
                        }
                    } else {
                        return serde_json::json!({ "path": path, "error": "MISSING_SOURCE" });
                    };

                    let ext = std::path::Path::new(path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| format!(".{}", e))
                        .unwrap_or_default();

                    let language = match crate::parser_pool::ext_to_language(&ext) {
                        Some(l) => l,
                        None => return serde_json::json!({
                            "path": path,
                            "error": "UNSUPPORTED_EXT"
                        }),
                    };

                    match state.parser_pool.parse(&source, language) {
                        Ok(tree) => {
                            let result = extract::extract_all(&tree, &source, language);
                            if !file_path.is_empty() {
                                state.cache.lock().unwrap().insert(file_path, tree, source, language.to_string());
                            }
                            serde_json::json!({
                                "path": path,
                                "result": serde_json::to_value(result).unwrap()
                            })
                        }
                        Err(e) => serde_json::json!({
                            "path": path,
                            "error": e
                        }),
                    }
                })
                .collect();

            Response::success(req.id, serde_json::json!({ "results": results }))
        }

        _ => Response::error(req.id, "METHOD_NOT_FOUND", &format!("unknown method: {}", req.method)),
    }
}
