use serde::{Deserialize, Serialize};

pub const MAX_FRAME_SIZE: u32 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub priority: u8,  // 0 = normal, 1 = high (batch)
}

pub struct DecodedRequest {
    pub request: Request,
    pub raw_source: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorResponse>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Response {
    pub fn success(id: String, result: serde_json::Value) -> Self {
        Self { id, result: Some(result), error: None }
    }

    pub fn error(id: String, code: &str, message: &str) -> Self {
        Self {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: code.to_string(),
                message: message.to_string(),
                detail: None,
            }),
        }
    }

    pub fn error_with_detail(id: String, code: &str, message: &str, detail: String) -> Self {
        Self {
            id,
            result: None,
            error: Some(ErrorResponse {
                code: code.to_string(),
                message: message.to_string(),
                detail: Some(detail),
            }),
        }
    }
}

pub fn encode_frame(msg: &impl Serialize) -> Result<Vec<u8>, serde_json::Error> {
    let payload = serde_json::to_vec(msg)?;
    let len = payload.len() as u32;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub enum DecodeResult {
    Incomplete,
    Frame(DecodedRequest, usize),
    Skip(usize),
}

/// Wire format (v2):
///   [4B total_payload_len][4B header_len][header JSON][raw source bytes]
///
/// If header JSON contains params.source_len > 0, the trailing bytes
/// after the header are the raw (non-JSON-escaped) source.
/// If source_len == 0 or absent, there are no trailing bytes and
/// params.source may be used inline (backward compat for small payloads).
pub fn decode_frame(buf: &[u8]) -> DecodeResult {
    if buf.len() < 4 {
        return DecodeResult::Incomplete;
    }
    let total_len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if total_len > MAX_FRAME_SIZE as usize {
        return DecodeResult::Skip(4);
    }
    if buf.len() < 4 + total_len {
        return DecodeResult::Incomplete;
    }

    let payload = &buf[4..4 + total_len];
    let consumed = 4 + total_len;

    if payload.len() >= 4 {
        let header_len = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
        if header_len > 0 && header_len <= payload.len() - 4 && header_len < total_len {
            let header_bytes = &payload[4..4 + header_len];
            let raw_source_bytes = &payload[4 + header_len..];

            match serde_json::from_slice::<Request>(header_bytes) {
                Ok(mut req) => {
                    let source_len = req.params.get("source_len")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;

                    let raw_source = if source_len > 0 && raw_source_bytes.len() >= source_len {
                        let src = raw_source_bytes[..source_len].to_vec();
                        if let Some(obj) = req.params.as_object_mut() {
                            obj.remove("source_len");
                        }
                        Some(src)
                    } else {
                        None
                    };

                    return DecodeResult::Frame(DecodedRequest { request: req, raw_source }, consumed);
                }
                Err(_) => {}
            }
        }
    }

    match serde_json::from_slice(payload) {
        Ok(req) => DecodeResult::Frame(DecodedRequest { request: req, raw_source: None }, consumed),
        Err(_) => DecodeResult::Skip(consumed),
    }
}
