//! Product admission for new destinations, separate from the retained 1.6 API
//! compatibility contract. Public identity is read before sending credentials.
use reqwest::blocking::Client;
use serde_json::Value;
use std::{io::Read, time::Duration};

pub(super) fn require_shellbeam(value: &Value) -> Result<(), String> {
    let value = value.get("data").unwrap_or(value);
    if value["product"] != "ShellBeam Server"
        || value["product_version"]
            .as_str()
            .is_none_or(|v| v.is_empty() || v.len() > 100)
    {
        return Err("MONITORING_SHELLBEAM_REQUIRED".into());
    }
    let version = value["version"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v');
    let patch = version
        .strip_prefix("1.6.")
        .unwrap_or("")
        .split(['-', '+'])
        .next()
        .unwrap_or("");
    if patch.is_empty() || !patch.bytes().all(|c| c.is_ascii_digit()) {
        return Err("MONITORING_UNSUPPORTED".into());
    }
    Ok(())
}

pub(super) fn verify_endpoint(endpoint: &str) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "MONITORING_IDENTITY_UNAVAILABLE")?;
    let response = client
        .get(format!("{endpoint}/api/version"))
        .header("Accept", "application/json")
        .send()
        .map_err(|_| "MONITORING_IDENTITY_UNAVAILABLE")?;
    // No fallback to install/status: an uninitialized upstream service also
    // answers that route, and must never receive administrator credentials.
    if response.status().as_u16() != 200 {
        return Err("MONITORING_IDENTITY_UNAVAILABLE".into());
    }
    let mut bytes = Vec::new();
    response
        .take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| "MONITORING_IDENTITY_UNAVAILABLE")?;
    if bytes.len() > 16_384 {
        return Err("MONITORING_IDENTITY_UNAVAILABLE".into());
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| "MONITORING_IDENTITY_UNAVAILABLE")?;
    require_shellbeam(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn api_compatibility_never_proves_shellbeam_product_identity() {
        for value in [
            json!({"version":"1.6.0"}),
            json!({"version":"1.6.0","product":"Komari","product_version":"1.6.0"}),
            json!({"version":"1.6.0","product":"ShellBeam Server"}),
        ] {
            assert_eq!(
                require_shellbeam(&value),
                Err("MONITORING_SHELLBEAM_REQUIRED".into())
            );
        }
        let value =
            json!({"version":"1.6.0","product":"ShellBeam Server","product_version":"0.1.0-dev"});
        assert!(require_shellbeam(&value).is_ok());
        assert!(require_shellbeam(&json!({"data": value})).is_ok());
        assert_eq!(
            require_shellbeam(
                &json!({"version":"1.7.0","product":"ShellBeam Server","product_version":"0.2.0"})
            ),
            Err("MONITORING_UNSUPPORTED".into())
        );
    }

    #[test]
    fn public_preflight_sends_no_credentials_and_rejects_redirects() {
        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"data":{"product":"ShellBeam Server","product_version":"0.1.0-dev","version":"1.6.0"}}"#,
                Ok(()),
            ),
            (
                "200 OK",
                r#"{"data":{"version":"1.6.0"}}"#,
                Err("MONITORING_SHELLBEAM_REQUIRED".into()),
            ),
            (
                "302 Found",
                "",
                Err("MONITORING_IDENTITY_UNAVAILABLE".into()),
            ),
            (
                "404 Not Found",
                "",
                Err("MONITORING_IDENTITY_UNAVAILABLE".into()),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = vec![0; 4096];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_lowercase();
                assert!(request.starts_with("get /api/version http/1.1\r\n"));
                assert!(
                    !request.contains("authorization:")
                        && !request.contains("cookie:")
                        && !request.contains("password")
                );
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: /api/install/complete\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            assert_eq!(verify_endpoint(&endpoint), expected);
            server.join().unwrap();
        }
    }
}
