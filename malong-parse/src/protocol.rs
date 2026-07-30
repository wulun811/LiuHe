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
    Frame(Request, usize),
    Skip(usize),
}

pub fn decode_frame(buf: &[u8]) -> DecodeResult {
    if buf.len() < 4 {
        return DecodeResult::Incomplete;
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME_SIZE as usize {
        return DecodeResult::Skip(4);
    }
    if buf.len() < 4 + len {
        return DecodeResult::Incomplete;
    }
    let payload = &buf[4..4 + len];
    match serde_json::from_slice(payload) {
        Ok(req) => DecodeResult::Frame(req, 4 + len),
        Err(_) => DecodeResult::Skip(4 + len),
    }
}
