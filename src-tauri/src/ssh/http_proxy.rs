//! Bounded HTTP proxy framing. Read-ahead bytes belong to the SSH channel,
//! including TLS bytes sent together with a CONNECT request.
use std::io::{Read, Write};

pub struct Request {
    pub host: String,
    pub port: u16,
    pub connect: bool,
    pub prefix: Vec<u8>,
}

pub fn read(stream: &mut impl Read) -> Result<Request, &'static str> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        let count = stream.read(&mut chunk).map_err(|_| "HTTP_PROXY_READ")?;
        if count == 0 {
            return Err("HTTP_PROXY_INCOMPLETE");
        }
        buffer.extend_from_slice(&chunk[..count]);
        if let Some(end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            if end > 65_536 {
                return Err("HTTP_PROXY_HEADER_LIMIT");
            }
            break end;
        }
        if buffer.len() > 65_536 {
            return Err("HTTP_PROXY_HEADER_LIMIT");
        }
    };
    let header = std::str::from_utf8(&buffer[..end]).map_err(|_| "HTTP_PROXY_HEADER")?;
    let mut lines = header.split("\r\n");
    let mut parts = lines.next().ok_or("HTTP_PROXY_REQUEST")?.split_whitespace();
    let method = parts.next().ok_or("HTTP_PROXY_METHOD")?;
    let target = parts.next().ok_or("HTTP_PROXY_TARGET")?;
    let version = parts.next().ok_or("HTTP_PROXY_VERSION")?;
    if parts.next().is_some()
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || !method
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'-')
    {
        return Err("HTTP_PROXY_REQUEST");
    }
    let connect = method == "CONNECT";
    let url = if connect {
        url::Url::parse(&format!("http://{target}"))
    } else if target.starts_with("http://") {
        url::Url::parse(target)
    } else if target.starts_with('/') {
        let host = lines
            .clone()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("host").then_some(value.trim())
            })
            .ok_or("HTTP_PROXY_HOST")?;
        url::Url::parse(&format!("http://{host}{target}"))
    } else {
        return Err("HTTP_PROXY_TARGET");
    }
    .map_err(|_| "HTTP_PROXY_TARGET")?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (connect && (url.path() != "/" || url.query().is_some()))
    {
        return Err("HTTP_PROXY_TARGET");
    }
    let host = url
        .host_str()
        .ok_or("HTTP_PROXY_HOST")?
        .trim_matches(['[', ']'])
        .to_owned();
    let port = url.port().unwrap_or(if connect { 443 } else { 80 });
    if port == 0 {
        return Err("HTTP_PROXY_PORT");
    }
    let mut prefix = if connect {
        Vec::new()
    } else {
        let mut path = url.path().to_owned();
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        let mut bytes = format!("{method} {path} {version}\r\n").into_bytes();
        for line in lines {
            let (key, _) = line.split_once(':').ok_or("HTTP_PROXY_HEADER")?;
            // Proxy authentication is local to this proxy; never forward it.
            if key.eq_ignore_ascii_case("proxy-authorization")
                || key.eq_ignore_ascii_case("proxy-connection")
                || key.eq_ignore_ascii_case("connection")
            {
                continue;
            }
            bytes.extend_from_slice(line.as_bytes());
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"Connection: close\r\n\r\n");
        bytes
    };
    prefix.extend_from_slice(&buffer[end + 4..]);
    Ok(Request {
        host,
        port,
        connect,
        prefix,
    })
}

pub fn reject(stream: &mut impl Write) {
    let _ = stream
        .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connect_preserves_tls_read_ahead_and_ipv6() {
        let request =
            read(&mut &b"CONNECT [::1]:8443 HTTP/1.1\r\nHost: [::1]\r\n\r\n\x16\x03payload"[..])
                .unwrap();
        assert_eq!(
            (request.host.as_str(), request.port, request.connect),
            ("::1", 8443, true)
        );
        assert_eq!(request.prefix, b"\x16\x03payload");
    }
    #[test]
    fn forward_preserves_body_and_strips_proxy_credentials() {
        let request = read(&mut &b"POST http://example.com:8080/a?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: secret\r\nContent-Length: 4\r\n\r\nbody"[..]).unwrap();
        assert_eq!(request.port, 8080);
        let payload = String::from_utf8(request.prefix).unwrap();
        assert!(payload.starts_with("POST /a?q=1 HTTP/1.1\r\n"));
        assert!(payload.ends_with("\r\n\r\nbody"));
        assert!(!payload.contains("secret"));
    }
    #[test]
    fn rejects_unbounded_headers_and_ambiguous_targets() {
        assert!(read(&mut &vec![b'a'; 70_000][..]).is_err());
        for request in [
            "CONNECT user:pass@example.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT example.com:0 HTTP/1.1\r\n\r\n",
            "GET https://example.com/ HTTP/1.1\r\n\r\n",
        ] {
            assert!(read(&mut request.as_bytes()).is_err());
        }
    }
}
