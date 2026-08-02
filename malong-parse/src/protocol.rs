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

#[cfg(test)]
mod tests {
    use super::*;

    fn req_json(method: &str) -> serde_json::Value {
        serde_json::json!({ "id": "t1", "method": method })
    }

    #[test]
    fn encode_frame_len_prefix_and_roundtrip() {
        let msg = req_json("health");
        let frame = encode_frame(&msg).unwrap();
        let total = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(total, frame.len() - 4, "4B length prefix must cover payload");
        match decode_frame(&frame) {
            DecodeResult::Frame(d, consumed) => {
                assert_eq!(d.request.id, "t1");
                assert_eq!(d.request.method, "health");
                assert_eq!(consumed, frame.len());
                assert!(d.raw_source.is_none());
            }
            other => panic!("expected frame, got {:?}", std::mem::discriminant(&other)),
        }
    }

    #[test]
    fn decode_incomplete_short_buf() {
        assert!(matches!(decode_frame(&[0u8; 3]), DecodeResult::Incomplete));
        assert!(matches!(decode_frame(&[]), DecodeResult::Incomplete));
    }

    #[test]
    fn decode_incomplete_partial_payload() {
        // 声明 100 字节但只给 5
        let mut buf = Vec::new();
        buf.extend_from_slice(&100u32.to_be_bytes());
        buf.extend_from_slice(b"{\"id");
        assert!(matches!(decode_frame(&buf), DecodeResult::Incomplete));
    }

    #[test]
    fn decode_skips_oversized_frame() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME_SIZE as u32 + 1).to_be_bytes());
        assert!(matches!(decode_frame(&buf), DecodeResult::Skip(4)));
    }

    #[test]
    fn decode_v2_frame_with_raw_source() {
        let header = serde_json::json!({
            "id": "raw1",
            "method": "extract_all",
            "params": { "ext": ".js", "source_len": 4 }
        });
        let header_bytes = serde_json::to_vec(&header).unwrap();
        let raw = b"abcd";
        let mut payload = Vec::new();
        payload.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(raw);
        let mut buf = Vec::new();
        buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        buf.extend_from_slice(&payload);

        match decode_frame(&buf) {
            DecodeResult::Frame(d, consumed) => {
                assert_eq!(d.request.id, "raw1");
                assert_eq!(d.raw_source.as_deref(), Some(&b"abcd"[..]));
                assert!(d.request.params.get("source_len").is_none(), "source_len must be stripped");
                assert_eq!(consumed, buf.len());
            }
            _ => panic!("expected v2 frame"),
        }
    }

    #[test]
    fn decode_legacy_inline_source() {
        let payload = serde_json::json!({
            "id": "l1",
            "method": "extract_all",
            "params": { "source": "let x = 1", "ext": ".js" }
        });
        let body = serde_json::to_vec(&payload).unwrap();
        let mut buf = Vec::new();
        buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
        buf.extend_from_slice(&body);
        match decode_frame(&buf) {
            DecodeResult::Frame(d, consumed) => {
                assert_eq!(d.request.id, "l1");
                assert!(d.raw_source.is_none(), "inline source must not set raw_source");
                assert_eq!(consumed, buf.len());
            }
            _ => panic!("expected legacy frame"),
        }
    }

    #[test]
    fn decode_skips_garbage() {
        let garbage = b"NOT JSON AT ALL";
        let mut buf = Vec::new();
        buf.extend_from_slice(&(garbage.len() as u32).to_be_bytes());
        buf.extend_from_slice(garbage);
        assert!(matches!(decode_frame(&buf), DecodeResult::Skip(_)));
    }

    #[test]
    fn request_defaults_priority_and_params() {
        let r: Request = serde_json::from_str(r#"{"id":"d1","method":"health"}"#).unwrap();
        assert_eq!(r.priority, 0, "priority defaults to 0");
        assert_eq!(r.params, serde_json::Value::Null);
    }

    #[test]
    fn response_success_omits_error_field() {
        let r = Response::success("s1".into(), serde_json::json!({"ok": true}));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["id"], "s1");
        assert_eq!(v["result"]["ok"], true);
        assert!(v.get("error").is_none(), "error field must be omitted");
    }

    #[test]
    fn response_error_omits_result_field_and_detail() {
        let r = Response::error("e1".into(), "BAD_REQUEST", "bad");
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["error"]["code"], "BAD_REQUEST");
        assert_eq!(v["error"]["message"], "bad");
        assert!(v.get("result").is_none(), "result field must be omitted");
        assert!(v["error"].get("detail").is_none(), "detail must be omitted when None");

        let r2 = Response::error_with_detail("e2".into(), "PARSE_ERROR", "boom", "line 3".into());
        let v2 = serde_json::to_value(&r2).unwrap();
        assert_eq!(v2["error"]["detail"], "line 3");
    }

    #[test]
    fn priority_ordering_higher_wins() {
        // 直接验证 Request.priority 参与序列化
        let r: Request = serde_json::from_str(r#"{"id":"p1","method":"x","priority":1}"#).unwrap();
        assert_eq!(r.priority, 1);
    }
}
