use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpErrorPayload {
    pub code: String,
    pub source: String,
    pub retryable: bool,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardErrorPayload {
    pub code: String,
    pub source: String,
    pub retryable: bool,
    pub message: String,
    pub detail: Option<String>,
}

pub fn sftp_error_payload(
    code: &str,
    source: &str,
    retryable: bool,
    message: &str,
    detail: Option<String>,
) -> String {
    let payload = SftpErrorPayload {
        code: code.to_string(),
        source: source.to_string(),
        retryable,
        message: message.to_string(),
        detail,
    };
    serde_json::to_string(&payload).unwrap_or_else(|_| message.to_string())
}

pub fn standard_error_payload(
    code: &str,
    source: &str,
    retryable: bool,
    message: &str,
    detail: Option<String>,
) -> String {
    let payload = StandardErrorPayload {
        code: code.to_string(),
        source: source.to_string(),
        retryable,
        message: message.to_string(),
        detail,
    };
    serde_json::to_string(&payload).unwrap_or_else(|_| message.to_string())
}

/// Error payload for host key verification failures. Contains fingerprint info for the frontend dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyErrorPayload {
    pub code: String,
    pub source: String,
    pub retryable: bool,
    pub message: String,
    pub detail: Option<String>,
    pub fingerprint: String,
    pub key_type: String,
    pub host: String,
    pub port: u16,
}

pub fn host_key_unknown_payload(
    host: &str,
    port: u16,
    fingerprint: &str,
    key_type: &str,
) -> String {
    let payload = HostKeyErrorPayload {
        code: "host_key_unknown".to_string(),
        source: "ssh".to_string(),
        retryable: true,
        message: format!("Unknown host key for {host}:{port}"),
        detail: Some(format!("SHA256:{fingerprint}")),
        fingerprint: fingerprint.to_string(),
        key_type: key_type.to_string(),
        host: host.to_string(),
        port,
    };
    serde_json::to_string(&payload).unwrap_or_else(|_| "host_key_unknown".to_string())
}

pub fn host_key_mismatch_payload(
    host: &str,
    port: u16,
    fingerprint: &str,
    key_type: &str,
) -> String {
    let payload = HostKeyErrorPayload {
        code: "host_key_mismatch".to_string(),
        source: "ssh".to_string(),
        retryable: false,
        message: format!("Host key CHANGED for {host}:{port}. Possible man-in-the-middle attack!"),
        detail: Some(format!("New fingerprint: SHA256:{fingerprint}")),
        fingerprint: fingerprint.to_string(),
        key_type: key_type.to_string(),
        host: host.to_string(),
        port,
    };
    serde_json::to_string(&payload).unwrap_or_else(|_| "host_key_mismatch".to_string())
}

pub fn standard_error_from_raw(source: &str, operation: &str, detail: impl Into<String>) -> String {
    let detail = detail.into();
    let lowered = detail.to_lowercase();
    let (code, retryable) = if lowered.contains("required") || lowered.contains("unsupported") {
        ("validation_error", false)
    } else if lowered.contains("not initialized") {
        ("not_initialized", false)
    } else if lowered.contains("already initialized") {
        ("already_initialized", false)
    } else if lowered.contains("incorrect") || lowered.contains("auth") {
        ("auth_failed", false)
    } else if lowered.contains("not found") {
        ("not_found", false)
    } else if lowered.contains("lock poisoned") {
        ("state_lock_error", true)
    } else if lowered.contains("spawn") {
        ("process_spawn_failed", true)
    } else if lowered.contains("decode")
        || lowered.contains("encrypt")
        || lowered.contains("decrypt")
        || lowered.contains("utf8")
    {
        ("crypto_error", false)
    } else if lowered.contains("io")
        || lowered.contains("write")
        || lowered.contains("read")
        || lowered.contains("flush")
    {
        ("io_error", true)
    } else {
        ("unknown_error", true)
    };
    standard_error_payload(
        code,
        source,
        retryable,
        &format!("{source} {operation} failed"),
        Some(detail),
    )
}

pub fn sftp_error_from_raw(source: &str, operation: &str, detail: impl Into<String>) -> String {
    let detail = detail.into();
    let lowered = detail.to_lowercase();
    let (code, retryable) = if lowered.contains("auth") {
        ("auth_failed", false)
    } else if lowered.contains("permission denied") || lowered.contains("denied") {
        ("permission_denied", false)
    } else if lowered.contains("no such file") || lowered.contains("not found") {
        ("not_found", false)
    } else if lowered.contains("timed out") || lowered.contains("timeout") {
        ("timeout", true)
    } else if lowered.contains("tcp")
        || lowered.contains("handshake")
        || lowered.contains("connection reset")
        || lowered.contains("broken pipe")
        || lowered.contains("connection refused")
        || lowered.contains("connection")
    {
        ("network_error", true)
    } else {
        ("unknown_error", true)
    };
    sftp_error_payload(
        code,
        source,
        retryable,
        &format!("SFTP {operation} failed"),
        Some(detail),
    )
}
