use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tracing::{info, warn, error};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};

use crate::cache::{TreeCache, SourceCache};

use crate::parser_pool::ParserPool;
use crate::protocol::{Response, DecodedRequest, encode_frame, decode_frame, DecodeResult};
use crate::extract;
use crate::simplify;
use crate::classify;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONCURRENCY: usize = 16;
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const FRAME_COMPLETION_TIMEOUT: Duration = Duration::from_secs(60); // r9(F2)：半帧累计时长上限（滴灌客户端防缓冲滞留）
// r8(F1)：hello 握手超时——未认证连接限时完成 __hello，超时即断
// r11(M4)：单请求超时预算动态化——旧固定 5s 包住整个 dispatch（含 batch_extract 50 文件批），
// 大文件多批次必然超时 → indexBatch 静默 continue → 病态仓库永远索引不完。
// 公式：5s 基准 + 批文件数 × 200ms（单文件解析预算），上限 60s 防无限。
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
fn request_timeout_budget(decoded: &DecodedRequest) -> Duration {
    if decoded.request.method == "batch_extract" {
        let n = decoded.request.params["files"].as_array().map(|a| a.len()).unwrap_or(0) as u64;
        let extra = n.saturating_mul(200);
        let secs = (5 + extra / 1000).min(MAX_REQUEST_TIMEOUT.as_secs());
        return Duration::from_secs(secs);
    }
    REQUEST_TIMEOUT
}
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

pub struct ServerState {
    pub parser_pool: ParserPool,
    pub start_time: Instant,
    pub requests_served: tokio::sync::Mutex<u64>,
    pub cache: std::sync::Mutex<TreeCache>,
    pub source_cache: std::sync::Mutex<SourceCache>,
    pub concurrency: Semaphore,
    pub lang_stats: std::sync::Mutex<HashMap<String, u64>>,
    pub sym_count_buckets: std::sync::Mutex<[u64; 5]>, // 0-10, 11-50, 51-200, 201-1000, 1000+
    pub hot_files: std::sync::Mutex<Vec<(String, u64)>>, // (file_path, access_count)
    // r8(F1)：socket 认证 token。None = 不要求认证（测试/无 token 场景），Some = 每连接首帧必须是 __hello 且 token 匹配
    pub auth_token: Option<String>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            parser_pool: ParserPool::new(),
            start_time: Instant::now(),
            requests_served: tokio::sync::Mutex::new(0),
            cache: Mutex::new(TreeCache::new()),
            source_cache: Mutex::new(SourceCache::new()),
            concurrency: Semaphore::new(MAX_CONCURRENCY),
            lang_stats: Mutex::new(HashMap::new()),
            sym_count_buckets: Mutex::new([0; 5]),
            hot_files: Mutex::new(Vec::new()),
            auth_token: None,
        }
    }
}

// Priority queue wrapper for requests
struct PrioritizedRequest {
    decoded: DecodedRequest,
    sequence: u64,
}

impl PartialEq for PrioritizedRequest {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
    }
}
impl Eq for PrioritizedRequest {}

impl Ord for PrioritizedRequest {
    fn cmp(&self, other: &Self) -> Ordering {
        // r34-fix: 之前 `other.priority.cmp(&self.priority)` 反转了优先级——
        // BinaryHeap 是 max-heap，pop() 取最大，batch(priority=1) 反而被排在普通请求之后。
        self.decoded.request.priority.cmp(&other.decoded.request.priority)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

impl PartialOrd for PrioritizedRequest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// r31：泛型化流类型——Unix socket（Unix）与 TCP（Windows）共用同一协议处理
pub async fn handle_connection<S>(stream: S, state: Arc<ServerState>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut buf = vec![0u8; 65536];
    let mut data = Vec::new();
    let mut request_queue: BinaryHeap<PrioritizedRequest> = BinaryHeap::new();
    let mut sequence = 0u64;
    // r8(F1)：连接级认证——首帧必须是 __hello 且 token 匹配，否则断开
    let mut authed = state.auth_token.is_none();
    // r9(F2)：帧完成超时——READ_IDLE_TIMEOUT 只限「字节间间隔」，滴灌客户端（<30s/块）可长期持有
    // 半帧缓冲（16MB×16 连接 ≈ 256MB）。记录当前半帧的首字节时刻，>60s 未完成整帧即断
    let mut frame_start: Option<std::time::Instant> = None;

    loop {
        // r8(F2)：读空闲超时（未认证连接用更短的 HELLO_TIMEOUT 限时完成握手）
        let timeout = if authed { READ_IDLE_TIMEOUT } else { HELLO_TIMEOUT };
        let read_res = tokio::time::timeout(timeout, reader.read(&mut buf)).await;
        let n = match read_res {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                warn!("read error: {}", e);
                break;
            }
            Err(_) => {
                warn!("read idle timeout, closing connection");
                break;
            }
        };
        data.extend_from_slice(&buf[..n]);

        // r9(F2)：帧完成时限——数据缓冲非空即处于半帧状态；首字节距今 >60s 直接断开
        if data.is_empty() {
            frame_start = None;
        } else if frame_start.is_none() {
            frame_start = Some(std::time::Instant::now());
        }
        if let Some(fs) = frame_start {
            if fs.elapsed() > FRAME_COMPLETION_TIMEOUT {
                warn!("frame not completed in {}s, closing drip-fed connection", FRAME_COMPLETION_TIMEOUT.as_secs());
                break;
            }
        }

        // Decode all available requests and add to priority queue
        loop {
            match decode_frame(&data) {
                DecodeResult::Frame(decoded, consumed) => {
                    data.drain(..consumed);
                    if !authed {
                        // r8(F1)：握手帧校验
                        if decoded.request.method == "__hello"
                            && decoded.request.params.get("token").and_then(|t| t.as_str())
                                == state.auth_token.as_deref()
                        {
                            authed = true;
                            let ok = Response::success(decoded.request.id, serde_json::json!({ "status": "ok" }));
                            if let Ok(frame) = encode_frame(&ok) {
                                if let Err(e) = writer.write_all(&frame).await {
                                    warn!("write error during hello: {}", e);
                                    return;
                                }
                            }
                        } else {
                            warn!("auth failed: bad or missing token");
                            let err = Response::error(decoded.request.id, "AUTH_FAILED", "invalid token");
                            if let Ok(frame) = encode_frame(&err) {
                                let _ = writer.write_all(&frame).await;
                            }
                            return;
                        }
                        continue;
                    }
                    request_queue.push(PrioritizedRequest {
                        decoded,
                        sequence,
                    });
                    sequence += 1;
                }
                DecodeResult::Skip(consumed) => {
                    warn!("skipping malformed frame ({} bytes)", consumed);
                    data.drain(..consumed);
                }
                DecodeResult::Incomplete => break,
            }
        }

        // Process requests from priority queue
        while let Some(prioritized) = request_queue.pop() {
            let response = handle_request(prioritized.decoded, &state).await;

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

async fn handle_request(decoded: DecodedRequest, state: &Arc<ServerState>) -> Response {
    // concurrency limit
    let _permit = match tokio::time::timeout(Duration::from_millis(500), state.concurrency.acquire()).await {
        Ok(Ok(permit)) => permit,
        _ => return Response::error(decoded.request.id, "SERVER_BUSY", "too many concurrent requests"),
    };

    let start = Instant::now();
    let state_arc = state.clone();
    let req_id = decoded.request.id.clone();
    let req_method = decoded.request.method.clone();

    let result = tokio::time::timeout(request_timeout_budget(&decoded), async move {
        match tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(decoded, &state_arc)))
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

fn resolve_source(params: &serde_json::Value, raw_source: Option<&[u8]>) -> Result<(String, String, String), String> {
    if let Some(raw) = raw_source {
        let ext = params["ext"].as_str().unwrap_or("");
        if raw.len() > 1_000_000 {
            return Err("source exceeds 1MB limit".to_string());
        }
        let source = String::from_utf8_lossy(raw).into_owned();
        return Ok((source, ext.to_string(), String::new()));
    }
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
        } else {
            // r11(H3)：file_path 模式缺 workspace_root 一律拒绝——旧实现 debug 后直接放行，
            // 任何调用方只要传 file_path 即可让 daemon 读取主机任意受支持扩展名文件（纵深防御缺口，已闭合）
            return Err("file_path mode requires workspace_root for path traversal protection".to_string());
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

fn record_hot_file(state: &ServerState, file_path: &str) {
    if file_path.is_empty() { return; }
    if let Ok(mut hot_files) = state.hot_files.lock() {
        if let Some(entry) = hot_files.iter_mut().find(|(p, _)| p == file_path) {
            entry.1 += 1;
        } else {
            hot_files.push((file_path.to_string(), 1));
            if hot_files.len() > 100 {
                hot_files.sort_by(|a, b| b.1.cmp(&a.1));
                hot_files.truncate(100);
            }
        }
    }
}

fn dispatch(decoded: DecodedRequest, state: &ServerState) -> Response {
    let req = decoded.request;
    let raw_source = decoded.raw_source;
    let params = req.params;

    match req.method.as_str() {
        "health" => {
            let uptime = state.start_time.elapsed().as_secs();
            let count = state.requests_served.try_lock().map(|c| *c).unwrap_or(0);
            let cache_stats = state.cache.lock().unwrap().stats();
            let source_cache_stats = state.source_cache.lock().unwrap().stats();
            let lang_stats = state.lang_stats.lock().unwrap();
            let sym_buckets = state.sym_count_buckets.lock().unwrap();
            let hot_files = state.hot_files.lock().unwrap();
            let mut sorted: Vec<_> = hot_files.clone();
            sorted.sort_by(|a, b| b.1.cmp(&a.1));
            let hot_files_json: Vec<serde_json::Value> = sorted.iter().take(20).map(|(p, c)| {
                serde_json::json!({ "path": p, "count": c })
            }).collect();
            Response::success(req.id, serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "uptime": uptime,
                "parsers_loaded": state.parser_pool.supported_languages(),
                "requests_served": count,
                "cache": cache_stats,
                "source_cache": source_cache_stats,
                "stats": {
                    "by_language": *lang_stats,
                    "symbol_counts": {
                        "0_10": sym_buckets[0],
                        "11_50": sym_buckets[1],
                        "51_200": sym_buckets[2],
                        "201_1000": sym_buckets[3],
                        "1000_plus": sym_buckets[4],
                    },
                    "hot_files": hot_files_json,
                },
            }))
        }

        "__hello" => {
            // r8.1：免认证模式下客户端可能带残留 token 发 hello——应答 ok，不判未知方法错（防客户端 authFailed 拒连）
            Response::success(req.id, serde_json::json!({ "status": "ok" }))
        }

        "extract_all" => {
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            if !file_path.is_empty() {
                record_hot_file(state, &file_path);
                let mut cache_lock = state.cache.lock().unwrap();
                if let Some((t, s, l)) = cache_lock.get(&file_path) {
                    let result = extract::extract_all(t, s, l);
                    record_stats(state, &ext, result.symbols.len());
                    return Response::success(req.id, serde_json::to_value(result).unwrap_or(serde_json::Value::Null));
                }
            } else {
                let mut sc = state.source_cache.lock().unwrap();
                if let Some(cached) = sc.get(&source, &ext) {
                    return Response::success(req.id, cached);
                }
            }

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let result = extract::extract_all(&tree, &source, language);
                    record_stats(state, &ext, result.symbols.len());
                    record_hot_file(state, &file_path);
                    let value = serde_json::to_value(result).unwrap();
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    } else {
                        state.source_cache.lock().unwrap().insert(&source, &ext, value.clone());
                    }
                    Response::success(req.id, value)
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_symbols" => {
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
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
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
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
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
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
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let (has_errors, truncated) = extract::has_error_node(tree.root_node());
                    if !file_path.is_empty() {
                        state.cache.lock().unwrap().insert(&file_path, tree, source, language.to_string());
                    }
                    Response::success(req.id, serde_json::json!({ "has_errors": has_errors, "truncated": truncated }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "simplify_ast" => {
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };
            // r8(A5)：客户端可控 max_depth 无上限钳制——u32::MAX 会移除简化保护导致深递归栈溢出
            let max_depth = params["options"]["max_depth"].as_u64().unwrap_or(30).min(256) as u32;

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
            let (source, ext, file_path) = match resolve_source(&params, raw_source.as_deref()) {
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
            // r11(H3)：batch_extract 的 file_path 模式同样必须受 workspace_root 约束——
            // 旧实现此分支完全无路径校验（不走 resolve_source），可读主机任意文件；
            // 顶层 workspace_root 是唯一合法来源，缺省拒绝
            let batch_root = params["workspace_root"].as_str();

            let results: Vec<serde_json::Value> = files.par_iter()
                .map(|f| {
                    let path = f["path"].as_str().unwrap_or("");
                    let file_path = f["file_path"].as_str().unwrap_or("");

                    // r11(H3)：file_path 模式必须带 workspace_root 且文件须在 root 内
                    if !file_path.is_empty() {
                        let root = match batch_root {
                            Some(r) => r,
                            None => return serde_json::json!({ "path": path, "error": "WORKSPACE_ROOT_REQUIRED" }),
                        };
                        let (ok_canon, ok_root) = match (std::fs::canonicalize(file_path), std::fs::canonicalize(root)) {
                            (Ok(c), Ok(r)) => (c, r),
                            _ => (std::path::PathBuf::new(), std::path::PathBuf::new()),
                        };
                        if !ok_canon.starts_with(&ok_root) {
                            return serde_json::json!({ "path": path, "error": "PATH_OUTSIDE_WORKSPACE" });
                        }
                    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn state() -> ServerState {
        ServerState::new()
    }

    fn call(state: &ServerState, method: &str, params: serde_json::Value) -> Response {
        dispatch(DecodedRequest {
            request: crate::protocol::Request { id: "t".into(), method: method.into(), params, priority: 0 },
            raw_source: None,
        }, state)
    }

    fn result(resp: Response) -> serde_json::Value {
        serde_json::to_value(&resp).unwrap()
    }

    fn tmp_file(name: &str, content: &str) -> String {
        let path = std::env::temp_dir().join(format!("malong-server-test-{}-{name}", std::process::id()));
        fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }

    // ── resolve_source ──

    #[test]
    fn resolve_source_inline() {
        let p = serde_json::json!({ "source": "let a = 1", "ext": ".js" });
        let (src, ext, fp) = resolve_source(&p, None).unwrap();
        assert_eq!(src, "let a = 1");
        assert_eq!(ext, ".js");
        assert_eq!(fp, "");
    }

    #[test]
    fn resolve_source_raw_preferred() {
        let p = serde_json::json!({ "source": "IGNORED", "ext": ".js" });
        let (src, ext, _) = resolve_source(&p, Some(b"raw-body")).unwrap();
        assert_eq!(src, "raw-body");
        assert_eq!(ext, ".js");
    }

    #[test]
    fn resolve_source_oversize_rejected() {
        let big = "x".repeat(1_000_001);
        let p = serde_json::json!({ "source": big });
        assert!(resolve_source(&p, None).is_err(), ">1MB source must be rejected");
        let big_raw = vec![b'x'; 1_000_001];
        assert!(resolve_source(&serde_json::json!({}), Some(&big_raw)).is_err(), ">1MB raw must be rejected");
    }

    #[test]
    fn resolve_source_missing_params() {
        assert!(resolve_source(&serde_json::json!({}), None).is_err());
        assert!(resolve_source(&serde_json::json!({ "ext": ".js" }), None).is_err());
    }

    #[test]
    fn resolve_source_file_path_mode() {
        let dir = std::env::temp_dir().join(format!("malong-ws-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let inner = dir.join("a.py");
        fs::write(&inner, "def f(): pass").unwrap();
        let p = serde_json::json!({
            "file_path": inner.to_string_lossy(),
            "workspace_root": dir.to_string_lossy()
        });
        let (src, ext, fp) = resolve_source(&p, None).unwrap();
        assert_eq!(src, "def f(): pass");
        assert_eq!(ext, ".py");
        assert!(!fp.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_source_path_escape_blocked() {
        let dir = std::env::temp_dir().join(format!("malong-ws2-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join(format!("malong-outside-{}", std::process::id()));
        fs::write(&outside, "x").unwrap();
        let p = serde_json::json!({
            "file_path": outside.to_string_lossy(),
            "workspace_root": dir.to_string_lossy()
        });
        assert!(resolve_source(&p, None).is_err(), "path outside workspace must be rejected");
        fs::remove_dir_all(&dir).ok();
        fs::remove_file(&outside).ok();
    }

    #[test]
    fn resolve_source_file_path_requires_root() {
        // r11(H3)：file_path 模式缺 workspace_root 必须拒绝（此前直接放行 → 任意文件读取洞）
        let dir = std::env::temp_dir().join(format!("malong-ws3-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let inner = dir.join("a.py");
        fs::write(&inner, "def f(): pass").unwrap();
        let p = serde_json::json!({ "file_path": inner.to_string_lossy() });
        assert!(resolve_source(&p, None).is_err(), "file_path without workspace_root must be rejected");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_source_missing_file() {
        let p = serde_json::json!({ "file_path": "/nonexistent/malong-missing-file-xyz.js" });
        assert!(resolve_source(&p, None).is_err());
    }

    // ── record_stats ──

    #[test]
    fn record_stats_language_and_buckets() {
        let s = state();
        record_stats(&s, ".js", 5);
        record_stats(&s, ".js", 60);
        record_stats(&s, ".py", 3000);
        let stats = s.lang_stats.lock().unwrap();
        assert_eq!(stats["javascript"], 2);
        assert_eq!(stats["python"], 1);
        drop(stats);
        let buckets = s.sym_count_buckets.lock().unwrap();
        assert_eq!(buckets[0], 1, "5 -> bucket 0-10");
        assert_eq!(buckets[2], 1, "60 -> bucket 51-200");
        assert_eq!(buckets[4], 1, "3000 -> bucket 1000+");
    }

    #[test]
    fn record_stats_unknown_ext_goes_unknown() {
        let s = state();
        record_stats(&s, ".xyz", 1);
        let stats = s.lang_stats.lock().unwrap();
        assert_eq!(stats["unknown"], 1);
    }

    #[test]
    fn record_hot_file_increments_and_caps() {
        let s = state();
        record_hot_file(&s, "a.js");
        record_hot_file(&s, "a.js");
        record_hot_file(&s, "b.js");
        {
            let hf = s.hot_files.lock().unwrap();
            assert_eq!(hf.len(), 2);
            let a = hf.iter().find(|(p, _)| p == "a.js").unwrap();
            assert_eq!(a.1, 2);
        }
        record_hot_file(&s, "");
        assert_eq!(s.hot_files.lock().unwrap().len(), 2, "empty path must be ignored");
    }

    // ── dispatch ──

    #[test]
    fn dispatch_health_shape() {
        let s = state();
        let r = result(call(&s, "health", serde_json::json!({})));
        assert!(r["result"]["version"].is_string(), "version must be present");
        assert!(r["result"]["requests_served"].is_u64());
        assert!(r["result"]["cache"]["max_entries"].is_u64());
        assert!(r["result"]["stats"]["symbol_counts"]["0_10"].is_u64());
        assert_eq!(r["result"]["stats"]["hot_files"], serde_json::json!([]));
    }

    #[test]
    fn dispatch_extract_all_js() {
        let s = state();
        let r = result(call(&s, "extract_all", serde_json::json!({
            "source": "function foo() {}\nconst bar = 1;",
            "ext": ".js"
        })));
        assert!(r["error"].is_null(), "extract must succeed: {:?}", r);
        let syms = r["result"]["symbols"].as_array().unwrap();
        assert!(syms.len() >= 2, "must find foo and bar, got {}", syms.len());
        let names: Vec<&str> = syms.iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"foo"));
        assert!(names.contains(&"bar"));
        assert!(syms[0]["name"].is_string(), "symbol name must be present");
        assert!(syms[0]["kind"].is_string());
        assert!(syms[0]["start_line"].is_u64());
        assert!(syms[0]["end_line"].is_u64());
        assert!(r["result"]["imports"].is_array());
        assert!(r["result"]["refs"].is_array());
        assert_eq!(r["result"]["has_errors"], false);
    }

    #[test]
    fn dispatch_unsupported_ext() {
        let s = state();
        let r = result(call(&s, "extract_all", serde_json::json!({ "source": "x", "ext": ".xyz" })));
        assert_eq!(r["error"]["code"], "UNSUPPORTED_EXT");
    }

    #[test]
    fn dispatch_missing_source_bad_request() {
        let s = state();
        let r = result(call(&s, "extract_all", serde_json::json!({ "ext": ".js" })));
        assert_eq!(r["error"]["code"], "BAD_REQUEST");
    }

    #[test]
    fn dispatch_unknown_method() {
        let s = state();
        let r = result(call(&s, "no_such_method", serde_json::json!({})));
        assert_eq!(r["error"]["code"], "METHOD_NOT_FOUND");
        assert!(r["error"]["message"].as_str().unwrap().contains("no_such_method"));
    }

    #[test]
    fn dispatch_has_errors() {
        let s = state();
        let good = result(call(&s, "has_errors", serde_json::json!({ "source": "let a = 1;", "ext": ".js" })));
        assert_eq!(good["result"]["has_errors"], false);
        let bad = result(call(&s, "has_errors", serde_json::json!({ "source": "let a = ;;;", "ext": ".js" })));
        assert_eq!(bad["result"]["has_errors"], true);
    }

    #[test]
    fn dispatch_extract_symbols_and_top_level() {
        let s = state();
        let r = result(call(&s, "extract_symbols", serde_json::json!({
            "source": "export class Foo {}\nfunction helper() {}",
            "ext": ".ts"
        })));
        assert!(r["result"]["symbols"].as_array().unwrap().len() >= 2);
        assert!(r["result"]["imports"].is_array());
        let t = result(call(&s, "extract_top_level", serde_json::json!({ "source": "def a(): pass\ndef b(): pass", "ext": ".py" })));
        assert_eq!(t["result"]["symbols"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn dispatch_batch_extract_requires_files() {
        let s = state();
        let r = result(call(&s, "batch_extract", serde_json::json!({})));
        assert_eq!(r["error"]["code"], "INVALID_PARAMS");
    }

    #[test]
    fn dispatch_batch_extract_multi_language() {
        let s = state();
        let r = result(call(&s, "batch_extract", serde_json::json!({
            "files": [
                { "path": "src/a.js", "source": "function one() {}", "file_path": "" },
                { "path": "src/b.py", "source": "def two(): pass", "file_path": "" },
                { "path": "src/c.bad", "source": "x", "file_path": "" }
            ]
        })));
        let results = r["result"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["path"], "src/a.js");
        assert!(results[0]["result"]["symbols"].as_array().unwrap().len() == 1);
        assert!(results[1]["result"]["symbols"].as_array().unwrap().len() == 1);
        assert_eq!(results[2]["error"], "UNSUPPORTED_EXT");
    }

    #[test]
    fn dispatch_source_cache_hit_on_second_call() {
        let s = state();
        let p = serde_json::json!({ "source": "function cachedFn() {}", "ext": ".js" });
        let r1 = result(call(&s, "extract_all", p.clone()));
        assert!(r1["result"]["symbols"].as_array().unwrap().len() >= 1);
        let before = s.source_cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        let r2 = result(call(&s, "extract_all", p));
        assert_eq!(r2["result"]["symbols"], r1["result"]["symbols"], "cached result must be identical");
        let after = s.source_cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        assert_eq!(after, before + 1, "second identical call must hit source cache");
    }

    #[test]
    fn dispatch_classify_message() {
        let s = state();
        let r = result(call(&s, "classify_message", serde_json::json!({ "content": "please fix the bug" })));
        assert!(r["result"].is_object(), "classify must return an object");
        assert!(r["error"].is_null());
    }

    #[test]
    fn dispatch_simplify_ast_and_metrics() {
        let s = state();
        let src = "function outer() { const inner = () => 1; }";
        let r = result(call(&s, "simplify_ast", serde_json::json!({ "source": src, "ext": ".js" })));
        assert!(r["result"].is_array() || r["result"].is_object(), "simplify must return tree-ish value");
        let m = result(call(&s, "compute_metrics", serde_json::json!({ "source": src, "ext": ".js" })));
        assert!(m["result"]["total_lines"].as_u64().is_some() || m["result"].is_object(), "metrics must return object");
    }

    #[test]
    fn dispatch_extract_all_file_path_mode_with_cache() {
        let s = state();
        let path = tmp_file("dispatch-file.js", "function fileFn() {}");
        let p = serde_json::json!({ "file_path": path, "workspace_root": std::env::temp_dir() });
        let r1 = result(call(&s, "extract_all", p.clone()));
        assert!(r1["result"]["symbols"].as_array().unwrap().len() >= 1, "file mode must extract");
        let before = s.cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        let r2 = result(call(&s, "extract_all", p));
        assert_eq!(r2["result"]["symbols"], r1["result"]["symbols"]);
        let after = s.cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        assert_eq!(after, before + 1, "file_path second call must hit TreeCache");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn dispatch_batch_extract_file_path_cache_hit() {
        let s = state();
        let path = tmp_file("batch-file.js", "function batchFn() {}");
        let p = serde_json::json!({
            "workspace_root": std::env::temp_dir(),
            "files": [
                { "path": "src/batch-file.js", "file_path": path }
            ]
        });
        let r1 = result(call(&s, "batch_extract", p.clone()));
        let results = r1["result"]["results"].as_array().unwrap();
        assert_eq!(results[0]["path"], "src/batch-file.js");
        assert!(results[0]["result"]["symbols"].as_array().unwrap().len() >= 1, "batch file_path 模式必须提取");
        let before = s.cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        let _ = result(call(&s, "batch_extract", p));
        let after = s.cache.lock().unwrap().stats()["hits"].as_u64().unwrap();
        assert_eq!(after, before + 1, "batch 二次调用必须命中 TreeCache");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn dispatch_batch_extract_error_codes() {
        let s = state();
        let p = serde_json::json!({
            "workspace_root": std::env::temp_dir(),
            "files": [
                { "path": "a.js", "file_path": "/nonexistent/x.js" },
                { "path": "big.js", "source": "x".repeat(1_000_001) },
                { "path": "c.js" }
            ]
        });
        let r = result(call(&s, "batch_extract", p));
        let results = r["result"]["results"].as_array().unwrap();
        assert_eq!(results[0]["error"], "FILE_NOT_FOUND", "不存在文件报 FILE_NOT_FOUND");
        assert_eq!(results[1]["error"], "FILE_TOO_LARGE", "超限报 FILE_TOO_LARGE");
        assert_eq!(results[2]["error"], "MISSING_SOURCE", "缺 source/file_path 报 MISSING_SOURCE");
    }

    #[test]
    fn request_timeout_budget_dynamic() {
        // r11(M4)：batch_extract 预算 = 5s + 文件数×200ms（50 文件 → 15s），单请求仍 5s，上限 60s
        let single = DecodedRequest {
            request: crate::protocol::Request {
                method: "extract_all".to_string(),
                id: "t1".to_string(),
                params: serde_json::json!({}),
                priority: 0,
            },
            raw_source: None,
        };
        assert_eq!(request_timeout_budget(&single).as_secs(), 5, "非 batch 请求保持 5s");
        let batch50 = DecodedRequest {
            request: crate::protocol::Request {
                method: "batch_extract".to_string(),
                id: "t2".to_string(),
                params: serde_json::json!({ "files": vec![0u8; 50].iter().map(|_| serde_json::json!({ "path": "x" })).collect::<Vec<_>>() }),
                priority: 0,
            },
            raw_source: None,
        };
        assert_eq!(request_timeout_budget(&batch50).as_secs(), 15, "50 文件批 → 15s");
        let batch300 = DecodedRequest {
            request: crate::protocol::Request {
                method: "batch_extract".to_string(),
                id: "t3".to_string(),
                params: serde_json::json!({ "files": vec![0u8; 300].iter().map(|_| serde_json::json!({ "path": "x" })).collect::<Vec<_>>() }),
                priority: 0,
            },
            raw_source: None,
        };
        assert_eq!(request_timeout_budget(&batch300).as_secs(), 60, "300 文件批 cap 60s");
    }

    #[test]
    fn priority_queue_orders_high_first() {
        let mut heap: BinaryHeap<PrioritizedRequest> = BinaryHeap::new();
        let mk = |method: &str, priority: u8, seq: u64| PrioritizedRequest {
            decoded: DecodedRequest {
                request: crate::protocol::Request {
                    id: method.into(), method: method.into(),
                    params: serde_json::json!({}), priority,
                },
                raw_source: None,
            },
            sequence: seq,
        };
        heap.push(mk("low-a", 0, 1));
        heap.push(mk("high-b", 1, 2));
        heap.push(mk("low-c", 0, 3));
        let top = heap.pop().unwrap();
        assert_eq!(top.decoded.request.method, "high-b", "priority 1 must pop first");
        let second = heap.pop().unwrap();
        assert_eq!(second.decoded.request.method, "low-a", "same priority must respect FIFO sequence");
    }

    // ── r8：深嵌套输入栈溢出修复（此前 14KB 输入杀整个 daemon，以下测试在修复前会 abort 测试进程） ──

    #[test]
    fn extract_all_deep_nesting_no_stack_overflow() {
        let s = state();
        let deep = format!("{}1{}", "(".repeat(7000), ")".repeat(7000));
        let r = result(call(&s, "extract_all", serde_json::json!({"source": deep, "ext": ".js"})));
        assert!(r["result"]["symbols"].is_array(), "extract_all must not crash on deep nesting");
    }

    #[test]
    fn extract_references_deep_nesting_no_stack_overflow() {
        let s = state();
        let deep = format!("{}1{}", "(".repeat(10000), ")".repeat(10000));
        let r = result(call(&s, "extract_references", serde_json::json!({"source": deep, "ext": ".js"})));
        assert!(r["result"]["refs"].is_array(), "extract_references must not crash on deep nesting");
    }

    #[test]
    fn has_errors_deep_nesting_no_stack_overflow() {
        let s = state();
        let deep = format!("{}1{}", "(".repeat(50000), ")".repeat(50000));
        let r = result(call(&s, "has_errors", serde_json::json!({"source": deep, "ext": ".js"})));
        assert!(r["result"].is_object(), "has_errors must not crash on deep nesting");
    }

    #[test]
    fn has_errors_deep_nesting_flags_truncated_conservatively() {
        // r9(A1)：>512 深的嵌套无法完整验证——has_errors 保守 true + truncated 标注（宁可报错不可静默失真）；
        // 浅层正常代码不受影响
        let s = state();
        let deep = format!("{}1{}", "(".repeat(2000), ")".repeat(2000));
        let r = result(call(&s, "has_errors", serde_json::json!({"source": deep, "ext": ".js"})));
        assert_eq!(r["result"]["has_errors"], true, "unverifiable deep nesting must be conservative has_errors=true");
        assert_eq!(r["result"]["truncated"], true, "deep nesting must set truncated flag");
        let ok = result(call(&s, "has_errors", serde_json::json!({"source": "let a = 1;", "ext": ".js"})));
        assert_eq!(ok["result"]["has_errors"], false);
        assert_eq!(ok["result"]["truncated"], false);
    }

    #[tokio::test]
    async fn fuzz_garbage_frames_never_kill_server() {
        // r9(B3)：协议层随机畸形帧（固定 seed 确定性伪随机）——服务端必须存活、跳过垃圾、仍能服务合法请求
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut st = ServerState::new();
        let (mut client, server) = tokio::io::duplex(65536);
        let h = tokio::spawn(async move {
            handle_connection(server, Arc::new(st)).await;
        });
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
        // 1) 零长度帧（r9 修复：旧实现 Skip(0) → drain(..0) 无限自旋）
        let _ = client.write_all(&0u32.to_be_bytes()).await;
        // 2) 300 轮自包含畸形帧——每块：4B 头 + 按需 payload，恒可解析（不残留 Incomplete 状态）
        for _ in 0..300 {
            let hdr = rnd();
            let mut len = (hdr >> 32) as u32;
            // len ∈ (64, 16MB] 且无 payload 会残留 Incomplete 吞后续字节——钳成超大帧（直接 Skip）
            if len > 64 { len = u32::MAX }
            let _ = client.write_all(&len.to_be_bytes()).await;
            if len > 0 && len <= 64 {
                let mut buf = Vec::with_capacity(len as usize);
                for _ in 0..len { buf.push((rnd() & 0xFF) as u8) }
                let _ = client.write_all(&buf).await;
            }
        }
        // 3) 超大 frameLen（>16MB → Skip 4）与合法帧混合
        let _ = client.write_all(&u32::MAX.to_be_bytes()).await;
        let frame = encode_frame(&serde_json::json!({"id": "f1", "method": "health"})).unwrap();
        let _ = client.write_all(&frame).await;
        let resp = read_frame(&mut client).await;
        assert!(resp["result"].is_object(), "server must survive garbage frames and still serve health");
        h.await.unwrap();
    }

    #[test]
    fn compute_metrics_deep_nesting_no_stack_overflow() {
        let s = state();
        let deep = format!("{}1{}", "(".repeat(20000), ")".repeat(20000));
        let r = result(call(&s, "compute_metrics", serde_json::json!({"source": deep, "ext": ".js"})));
        assert!(r["result"].is_object(), "compute_metrics must not crash on deep nesting");
    }

    #[test]
    fn simplify_max_depth_clamped_no_stack_overflow() {
        let s = state();
        // 100k 层 if 链 + 客户端传 u32::MAX——钳制后不得崩溃
        let src = format!("{}x", "if(a)".repeat(100000));
        let r = result(call(&s, "simplify_ast", serde_json::json!({
            "source": src, "ext": ".js", "options": {"max_depth": 4294967295u64}
        })));
        assert!(r["result"].is_object(), "simplify_ast must not crash with u32::MAX max_depth");
    }

    // ── r8(F1)：__hello 握手认证 ──

    // 完整读一帧（单次 read 可能只拿到部分字节）
    async fn read_frame(sock: &mut tokio::io::DuplexStream) -> serde_json::Value {
        use tokio::io::AsyncReadExt;
        let mut hdr = [0u8; 4];
        sock.read_exact(&mut hdr).await.unwrap();
        let ln = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; ln];
        sock.read_exact(&mut body).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn hello_handshake_rejects_bad_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut st = ServerState::new();
        st.auth_token = Some("secret-token".into());
        let (mut client, server) = tokio::io::duplex(65536);
        let h = tokio::spawn(async move {
            handle_connection(server, Arc::new(st)).await;
        });
        let frame = encode_frame(&serde_json::json!({"id": "1", "method": "__hello", "params": {"token": "wrong"}})).unwrap();
        client.write_all(&frame).await.unwrap();
        let resp = read_frame(&mut client).await;
        assert_eq!(resp["error"]["code"], "AUTH_FAILED", "bad token must be rejected");
        h.await.unwrap();
    }

    #[tokio::test]
    async fn hello_handshake_accepts_correct_token_then_serves() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut st = ServerState::new();
        st.auth_token = Some("secret-token".into());
        let (mut client, server) = tokio::io::duplex(65536);
        let h = tokio::spawn(async move {
            handle_connection(server, Arc::new(st)).await;
        });
        // 握手
        let frame = encode_frame(&serde_json::json!({"id": "h", "method": "__hello", "params": {"token": "secret-token"}})).unwrap();
        client.write_all(&frame).await.unwrap();
        let resp = read_frame(&mut client).await;
        assert_eq!(resp["result"]["status"], "ok", "hello must be acknowledged");
        // 认证后正常请求
        let frame2 = encode_frame(&serde_json::json!({"id": "h2", "method": "health"})).unwrap();
        client.write_all(&frame2).await.unwrap();
        let resp2 = read_frame(&mut client).await;
        assert!(resp2["result"].is_object(), "post-auth request must be served");
        h.await.unwrap();
    }

    #[tokio::test]
    async fn hello_ignored_in_permissive_mode() {
        // r8.1：免认证模式（auth_token=None）下客户端带残留 token 发 hello——必须应答 ok，
        // 不能返回未知方法错（否则新客户端 _sendHello 超时判 authFailed 拒连）
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut st = ServerState::new();
        st.auth_token = None;
        let (mut client, server) = tokio::io::duplex(65536);
        let h = tokio::spawn(async move {
            handle_connection(server, Arc::new(st)).await;
        });
        let frame = encode_frame(&serde_json::json!({"id": "h", "method": "__hello", "params": {"token": "stale"}})).unwrap();
        client.write_all(&frame).await.unwrap();
        let resp = read_frame(&mut client).await;
        assert_eq!(resp["result"]["status"], "ok", "permissive mode must ack hello");
        // 随后正常请求照常服务
        let frame2 = encode_frame(&serde_json::json!({"id": "h2", "method": "health"})).unwrap();
        client.write_all(&frame2).await.unwrap();
        let resp2 = read_frame(&mut client).await;
        assert!(resp2["result"].is_object(), "requests must be served after stale hello");
        h.await.unwrap();
    }
}
