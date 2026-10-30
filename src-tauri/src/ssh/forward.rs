//! Bounded native local/remote/SOCKS forwarding over a verified SSH connection.
use super::transport::{bridge_counted, Connection, TrafficCounters};
use ssh2::Session;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub struct ForwardLease {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    pub port: u16,
}
impl ForwardLease {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed) && !self.stop.load(Ordering::Relaxed)
    }
}
struct RunningGuard {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}
impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        self.stop.store(true, Ordering::Relaxed);
    }
}
impl Drop for ForwardLease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub enum ForwardKind {
    Local { host: String, port: u16 },
    Remote { host: String, port: u16 },
    Socks,
    Http,
}

/// A slow client cannot extend its handshake by drip-feeding bytes. Cancellation
/// wakes within the socket read timeout even when the client never finishes.
struct HandshakeStream {
    socket: TcpStream,
    stop: Arc<AtomicBool>,
    deadline: std::time::Instant,
}
impl HandshakeStream {
    fn new(socket: TcpStream, stop: Arc<AtomicBool>) -> std::io::Result<Self> {
        socket.set_nonblocking(false)?;
        socket.set_read_timeout(Some(Duration::from_millis(200)))?;
        socket.set_write_timeout(Some(Duration::from_millis(200)))?;
        Ok(Self {
            socket,
            stop,
            deadline: std::time::Instant::now() + Duration::from_secs(5),
        })
    }
    fn check(&self) -> std::io::Result<()> {
        if self.stop.load(Ordering::Relaxed) || std::time::Instant::now() >= self.deadline {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Proxy handshake stopped",
            ))
        } else {
            Ok(())
        }
    }
}
impl Read for HandshakeStream {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        loop {
            self.check()?;
            match self.socket.read(bytes) {
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
}
impl Write for HandshakeStream {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.check()?;
        self.socket.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.socket.flush()
    }
}

fn socks_target(stream: &mut (impl Read + Write)) -> Result<(String, u16), String> {
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|_| "SOCKS_HANDSHAKE")?;
    if header[0] != 5 || header[1] == 0 {
        return Err("SOCKS_VERSION".into());
    }
    let mut methods = vec![0u8; header[1] as usize];
    stream
        .read_exact(&mut methods)
        .map_err(|_| "SOCKS_HANDSHAKE")?;
    if !methods.contains(&0) {
        let _ = stream.write_all(&[5, 255]);
        return Err("SOCKS_AUTH_UNSUPPORTED".into());
    }
    stream.write_all(&[5, 0]).map_err(|_| "SOCKS_HANDSHAKE")?;
    let mut request = [0u8; 4];
    stream
        .read_exact(&mut request)
        .map_err(|_| "SOCKS_HANDSHAKE")?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        return Err("SOCKS_COMMAND_UNSUPPORTED".into());
    }
    let host = match request[3] {
        1 => {
            let mut bytes = [0u8; 4];
            stream.read_exact(&mut bytes).map_err(|_| "SOCKS_ADDRESS")?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0u8; 16];
            stream.read_exact(&mut bytes).map_err(|_| "SOCKS_ADDRESS")?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let mut size = [0u8; 1];
            stream.read_exact(&mut size).map_err(|_| "SOCKS_ADDRESS")?;
            if size[0] == 0 {
                return Err("SOCKS_ADDRESS".into());
            }
            let mut bytes = vec![0u8; size[0] as usize];
            stream.read_exact(&mut bytes).map_err(|_| "SOCKS_ADDRESS")?;
            String::from_utf8(bytes).map_err(|_| "SOCKS_ADDRESS")?
        }
        _ => return Err("SOCKS_ADDRESS".into()),
    };
    let mut bytes = [0u8; 2];
    stream.read_exact(&mut bytes).map_err(|_| "SOCKS_PORT")?;
    let port = u16::from_be_bytes(bytes);
    if port == 0 || host.chars().any(char::is_control) {
        return Err("SOCKS_TARGET".into());
    }
    Ok((host, port))
}

/// Binding and SSH listener requests finish before success is returned.
/// Active sockets are bounded and all workers stop when this lease is dropped.
pub fn start(
    connection: Connection,
    bind_host: &str,
    bind_port: u16,
    kind: ForwardKind,
) -> Result<ForwardLease, String> {
    start_counted(connection, bind_host, bind_port, kind, None)
}

/// `start` that adds every bridged connection's traffic to `counters`.
pub fn start_counted(
    connection: Connection,
    bind_host: &str,
    bind_port: u16,
    kind: ForwardKind,
    counters: Option<Arc<TrafficCounters>>,
) -> Result<ForwardLease, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let worker_running = running.clone();
    if let ForwardKind::Remote { host, port } = kind {
        let (mut listener, bound_port) = connection
            .session
            .channel_forward_listen(bind_port, Some(bind_host), Some(16))
            .map_err(|_| "REMOTE_FORWARD_REJECTED")?;
        connection.session.set_blocking(false);
        thread::spawn(move || {
            let _running = RunningGuard {
                running: worker_running,
                stop: worker_stop.clone(),
            };
            let _tunnel = connection.tunnel;
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok(channel) => {
                        if active.load(Ordering::Relaxed) >= 16 {
                            drop(channel);
                            continue;
                        }
                        let socket = match (host.as_str(), port)
                            .to_socket_addrs()
                            .ok()
                            .and_then(|mut addresses| addresses.next())
                            .and_then(|address| {
                                TcpStream::connect_timeout(&address, Duration::from_secs(5)).ok()
                            }) {
                            Some(socket) => socket,
                            None => continue,
                        };
                        spawn_bridge(
                            connection.session.clone(),
                            channel,
                            socket,
                            worker_stop.clone(),
                            active.clone(),
                            Vec::new(),
                            counters.clone(),
                        );
                    }
                    Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        return Ok(ForwardLease {
            stop,
            running,
            port: bound_port,
        });
    }
    let listener =
        TcpListener::bind((bind_host, bind_port)).map_err(|_| "LOCAL_FORWARD_BIND_FAILED")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "LOCAL_FORWARD_BIND_FAILED")?;
    let port = listener
        .local_addr()
        .map_err(|_| "LOCAL_FORWARD_BIND_FAILED")?
        .port();
    // Opening direct-tcpip is bounded by the session timeout. Each connection
    // receives a clone of the authenticated session and retained jump lease.
    connection.session.set_timeout(5_000);
    connection.session.set_keepalive(true, 5);
    thread::spawn(move || {
        let _running = RunningGuard {
            running: worker_running,
            stop: worker_stop.clone(),
        };
        let _tunnel = connection.tunnel;
        let mut last_keepalive = std::time::Instant::now();
        while !worker_stop.load(Ordering::Relaxed) {
            if last_keepalive.elapsed() >= Duration::from_secs(5) {
                if let Err(error) = connection.session.keepalive_send() {
                    if error.code() != ssh2::ErrorCode::Session(-37) {
                        break;
                    }
                }
                last_keepalive = std::time::Instant::now();
            }
            match listener.accept() {
                Ok((socket, _)) => {
                    if active.load(Ordering::Relaxed) >= 16 {
                        continue;
                    }
                    let mut handshake = match HandshakeStream::new(socket, worker_stop.clone()) {
                        Ok(handshake) => handshake,
                        Err(_) => continue,
                    };
                    let mut prefix = Vec::new();
                    let mut http_connect = false;
                    let target = match &kind {
                        ForwardKind::Local { host, port } => Ok((host.clone(), *port)),
                        ForwardKind::Socks => socks_target(&mut handshake),
                        ForwardKind::Http => super::http_proxy::read(&mut handshake)
                            .map(|request| {
                                prefix = request.prefix;
                                http_connect = request.connect;
                                (request.host, request.port)
                            })
                            .map_err(str::to_owned),
                        _ => unreachable!(),
                    };
                    let (host, port) = match target {
                        Ok(target) => target,
                        Err(_) => {
                            if matches!(kind, ForwardKind::Http) {
                                super::http_proxy::reject(&mut handshake);
                            }
                            continue;
                        }
                    };
                    let mut socket = handshake.socket;
                    // libssh2 sessions shared with existing channel workers are
                    // nonblocking. Retry only EAGAIN until the setup deadline.
                    let deadline = std::time::Instant::now() + Duration::from_secs(5);
                    let channel = loop {
                        match connection.session.channel_direct_tcpip(&host, port, None) {
                            Ok(channel) => break Some(channel),
                            Err(error)
                                if error.code() == ssh2::ErrorCode::Session(-37)
                                    && std::time::Instant::now() < deadline
                                    && !worker_stop.load(Ordering::Relaxed) =>
                            {
                                thread::sleep(Duration::from_millis(2))
                            }
                            Err(_) => break None,
                        }
                    };
                    if let Some(channel) = channel {
                        if matches!(kind, ForwardKind::Socks) {
                            let _ = socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
                        }
                        if http_connect
                            && socket
                                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                                .is_err()
                        {
                            continue;
                        }
                        spawn_bridge(
                            connection.session.clone(),
                            channel,
                            socket,
                            worker_stop.clone(),
                            active.clone(),
                            prefix,
                            counters.clone(),
                        );
                    } else if matches!(kind, ForwardKind::Socks) {
                        let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
                    } else if matches!(kind, ForwardKind::Http) {
                        super::http_proxy::reject(&mut socket);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    Ok(ForwardLease {
        stop,
        running,
        port,
    })
}

use std::net::ToSocketAddrs;
fn spawn_bridge(
    session: Session,
    channel: ssh2::Channel,
    socket: TcpStream,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    prefix: Vec<u8>,
    counters: Option<Arc<TrafficCounters>>,
) {
    active.fetch_add(1, Ordering::Relaxed);
    thread::spawn(move || {
        bridge_counted(session, channel, socket, stop, prefix, counters);
        active.fetch_sub(1, Ordering::Relaxed);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drip_fed_proxy_handshake_has_an_absolute_deadline_and_stops() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (socket, _) = listener.accept().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut stream = HandshakeStream::new(socket, stop.clone()).unwrap();
        stream.deadline = std::time::Instant::now() + Duration::from_millis(80);
        let writer = thread::spawn(move || {
            for _ in 0..20 {
                if client.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let start = std::time::Instant::now();
        assert!(super::super::http_proxy::read(&mut stream).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        stop.store(true, Ordering::Relaxed);
        assert!(stream.read(&mut [0u8; 1]).is_err());
        drop(stream);
        writer.join().unwrap();
    }
}
