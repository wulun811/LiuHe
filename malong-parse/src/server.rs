use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tracing::{info, warn, error};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};

use crate::parser_pool::ParserPool;
use crate::protocol::{Request, Response, encode_frame, decode_frame};
use crate::extract;
use crate::simplify;
use crate::classify;

pub struct ServerState {
    pub parser_pool: ParserPool,
    pub start_time: Instant,
    pub requests_served: Mutex<u64>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            parser_pool: ParserPool::new(),
            start_time: Instant::now(),
            requests_served: Mutex::new(0),
        }
    }
}

pub async fn handle_connection(stream: UnixStream, state: Arc<ServerState>) {
    let (mut reader, mut writer) = stream.into_split();
    let mut buf = vec![0u8; 65536];
    let mut data = Vec::new();

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

        while let Some((consumed, req)) = decode_frame(&data) {
            data.drain(..consumed);
            let response = handle_request(req, &state).await;

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

async fn handle_request(req: Request, state: &ServerState) -> Response {
    let start = Instant::now();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch(req.clone(), state)
    }));

    let duration = start.elapsed();

    match result {
        Ok(resp) => {
            let mut count = state.requests_served.lock().await;
            *count += 1;
            info!("{} {} -> {}ms", req.method, req.id, duration.as_millis());
            resp
        }
        Err(panic_info) => {
            let msg = panic_info
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic_info.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());

            error!("PANIC in {}: {}", req.method, msg);
            Response::error_with_detail(req.id, "PARSE_PANIC", "tree-sitter panic recovered", msg)
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

fn dispatch(req: Request, state: &ServerState) -> Response {
    let params = req.params;

    match req.method.as_str() {
        "health" => {
            let uptime = state.start_time.elapsed().as_secs();
            let count = state.requests_served.try_lock().map(|c| *c).unwrap_or(0);
            Response::success(req.id, serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "uptime": uptime,
                "parsers_loaded": state.parser_pool.supported_languages(),
                "requests_served": count,
            }))
        }

        "extract_all" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let result = extract::extract_all(&tree, &source, language);
                    Response::success(req.id, serde_json::to_value(result).unwrap())
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_symbols" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let (symbols, imports) = extract::extract_symbols(&tree, &source, language);
                    Response::success(req.id, serde_json::json!({ "symbols": symbols, "imports": imports }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_top_level" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let symbols = extract::extract_top_level(&tree, &source, language);
                    Response::success(req.id, serde_json::json!({ "symbols": symbols }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "extract_references" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
                Ok(v) => v,
                Err(e) => return Response::error(req.id, "BAD_REQUEST", &e),
            };

            let language = match crate::parser_pool::ext_to_language(&ext) {
                Some(l) => l,
                None => return Response::error(req.id, "UNSUPPORTED_EXT", &format!("unsupported extension: {}", ext)),
            };

            match state.parser_pool.parse(&source, language) {
                Ok(tree) => {
                    let refs = extract::extract_references(&tree, &source, language);
                    Response::success(req.id, serde_json::json!({ "refs": refs }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "has_errors" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
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
                    Response::success(req.id, serde_json::json!({ "has_errors": has_errors }))
                }
                Err(e) => Response::error(req.id, "PARSE_ERROR", &e),
            }
        }

        "simplify_ast" => {
            let (source, ext, _file_path) = match resolve_source(&params) {
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
            let (source, ext, _file_path) = match resolve_source(&params) {
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
                    let source = f["source"].as_str().unwrap_or("");

                    if source.len() > 1_000_000 {
                        return serde_json::json!({
                            "path": path,
                            "error": "FILE_TOO_LARGE"
                        });
                    }

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

                    match state.parser_pool.parse(source, language) {
                        Ok(tree) => {
                            let result = extract::extract_all(&tree, source, language);
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
