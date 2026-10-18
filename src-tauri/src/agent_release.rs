//! Narrow HTTPS downloader for public, signed agent catalogs and artifacts.
//! No cookies/authentication, no automatic redirects, bounded time and bytes.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    io::Read,
    time::{Duration, Instant},
};
use url::Url;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

fn remaining_budget(deadline: Instant, now: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(now)
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "artifact_download_timeout".to_string())
}

fn read_bounded_body(
    reader: &mut impl Read,
    max_bytes: usize,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        remaining_budget(deadline, Instant::now())?;
        // Read one byte beyond the cap to distinguish an exact-size body from
        // an oversized stream, without accumulating an unbounded response.
        let allowed = buffer.len().min(max_bytes.saturating_sub(bytes.len()) + 1);
        let read = reader.read(&mut buffer[..allowed]).map_err(|_| {
            remaining_budget(deadline, Instant::now())
                .err()
                .unwrap_or_else(|| "artifact_download_failed".into())
        })?;
        // A blocking read may finish at the deadline; never accept that body
        // as successful even if it delivered its last byte.
        remaining_budget(deadline, Instant::now())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > max_bytes {
            return Err("artifact_size_exceeded".into());
        }
    }
    if bytes.is_empty() {
        return Err("artifact_size_exceeded".into());
    }
    Ok(bytes)
}

fn allowed_url(value: &str, allowed_hosts: &[String]) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "artifact_url_not_allowed".to_string())?;
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_lowercase();
    let allowed = allowed_hosts.iter().take(32).any(|entry| {
        let entry = entry.trim().trim_end_matches('.').to_lowercase();
        if let Some(suffix) = entry.strip_prefix("*.") {
            !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{suffix}")))
        } else {
            !entry.is_empty() && host == entry
        }
    });
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !allowed
    {
        return Err("artifact_url_not_allowed".into());
    }
    Ok(url)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDownload {
    bytes_b64: String,
}
fn download(
    url: &str,
    allowed_hosts: &[String],
    max_bytes: usize,
) -> Result<AgentDownload, String> {
    if max_bytes == 0 || max_bytes > MAX_BYTES {
        return Err("artifact_size_invalid".into());
    }
    // All redirect hops and the final body share one wall-clock budget.
    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .user_agent("ShellBeam-Agent-Release/1")
        .build()
        .map_err(|_| "artifact_download_unavailable".to_string())?;
    let mut current = allowed_url(url, allowed_hosts)?;
    for _ in 0..=5 {
        // Validate every hop before making a request, including redirects from an allowed mirror.
        current = allowed_url(current.as_str(), allowed_hosts)?;
        let mut response = client
            .get(current.clone())
            // Reqwest carries this request deadline through body streaming.
            // Recomputing the remainder prevents each redirect resetting it.
            .timeout(remaining_budget(deadline, Instant::now())?)
            .send()
            .map_err(|error| {
                if error.is_timeout() || Instant::now() >= deadline {
                    "artifact_download_timeout".to_string()
                } else {
                    "artifact_download_failed".to_string()
                }
            })?;
        remaining_budget(deadline, Instant::now())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "artifact_redirect_invalid".to_string())?;
            current = current
                .join(location)
                .map_err(|_| "artifact_redirect_invalid".to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "artifact_download_http_{}",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err("artifact_size_exceeded".into());
        }
        let bytes = read_bounded_body(&mut response, max_bytes, deadline)?;
        return Ok(AgentDownload {
            bytes_b64: STANDARD.encode(bytes),
        });
    }
    Err("artifact_redirect_limit".into())
}
#[tauri::command]
pub async fn download_shellbeam_agent_release(
    url: String,
    allowed_hosts: Vec<String>,
    max_bytes: usize,
) -> Result<AgentDownload, String> {
    tauri::async_runtime::spawn_blocking(move || download(&url, &allowed_hosts, max_bytes))
        .await
        .map_err(|_| "artifact_download_failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_every_redirect_host_boundary_and_https() {
        let hosts = vec!["github.com".into(), "*.githubusercontent.com".into()];
        assert!(allowed_url("https://github.com/org/repo/releases/a", &hosts).is_ok());
        assert!(allowed_url("https://release-assets.githubusercontent.com/a", &hosts).is_ok());
        for url in [
            "http://github.com/a",
            "https://github.com.evil.test/a",
            "https://evilgithubusercontent.com/a",
            "https://user:secret@github.com/a",
            "https://github.com/a#fragment",
            "https://127.0.0.1/a",
        ] {
            assert!(allowed_url(url, &hosts).is_err(), "accepted {url}");
        }
    }
    #[test]
    fn rejects_unbounded_downloads_before_network() {
        assert!(download("https://example.com", &[], 0).is_err());
        assert!(download("https://example.com", &[], MAX_BYTES + 1).is_err());
    }
    #[test]
    fn redirects_share_one_deadline_instead_of_resetting_the_timeout() {
        let start = Instant::now();
        let deadline = start + DOWNLOAD_TIMEOUT;
        assert_eq!(remaining_budget(deadline, start).unwrap(), DOWNLOAD_TIMEOUT);
        assert_eq!(
            remaining_budget(deadline, start + Duration::from_secs(20)).unwrap(),
            Duration::from_secs(10)
        );
        assert_eq!(
            remaining_budget(deadline, deadline).unwrap_err(),
            "artifact_download_timeout"
        );
        assert!(remaining_budget(deadline, deadline + Duration::from_millis(1)).is_err());
    }
    #[test]
    fn body_obeys_the_same_deadline_and_size_cap() {
        let mut body = std::io::Cursor::new(b"abcd");
        assert_eq!(
            read_bounded_body(&mut body, 4, Instant::now()).unwrap_err(),
            "artifact_download_timeout"
        );
        assert_eq!(
            body.position(),
            0,
            "expired budgets must not consume the body"
        );
        assert_eq!(
            read_bounded_body(&mut body, 3, Instant::now() + DOWNLOAD_TIMEOUT).unwrap_err(),
            "artifact_size_exceeded"
        );
        let mut body = std::io::Cursor::new(b"abcd");
        assert_eq!(
            read_bounded_body(&mut body, 4, Instant::now() + DOWNLOAD_TIMEOUT).unwrap(),
            b"abcd"
        );
    }
}
