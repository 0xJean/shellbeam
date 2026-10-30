//! Local SSH servers for native route tests and the opt-in Linux Ops bridge.
//! Keys never leave this module's private temporary directory or Endpoint memory.
use super::transport::Endpoint;
use base64::Engine;
use sha2::{Digest, Sha256};
use ssh2::Session;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub(super) struct Server {
    child: Option<Child>,
    pub(super) directory: PathBuf,
    pub(super) endpoint: Endpoint,
    fingerprint: String,
}

impl Server {
    pub(super) fn stop(&mut self) -> Result<(), String> {
        if let Some(child) = &mut self.child {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                if let Err(error) = child.kill() {
                    if child
                        .try_wait()
                        .map_err(|error| error.to_string())?
                        .is_none()
                    {
                        return Err(error.to_string());
                    }
                }
            }
            child.wait().map_err(|error| error.to_string())?;
        }
        self.child = None;
        Ok(())
    }

    pub(super) fn restart(&mut self) -> Result<(), String> {
        self.stop()?;
        self.start()?;
        let observed = self.read_fingerprint()?;
        if observed != self.fingerprint {
            return Err("SSH fixture fingerprint changed on restart".into());
        }
        Ok(())
    }

    fn start(&mut self) -> Result<(), String> {
        let log =
            std::fs::File::create(self.directory.join("log")).map_err(|error| error.to_string())?;
        self.child = Some(
            Command::new("/usr/sbin/sshd")
                .args(["-D", "-e", "-f"])
                .arg(self.directory.join("config"))
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
                .map_err(|error| error.to_string())?,
        );
        Ok(())
    }

    fn read_fingerprint(&mut self) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let tcp = loop {
            if let Some(child) = &mut self.child {
                if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                    return Err(format!(
                        "SSH fixture exited ({status}): {}",
                        std::fs::read_to_string(self.directory.join("log")).unwrap_or_default()
                    ));
                }
            }
            if let Ok(tcp) = TcpStream::connect(("127.0.0.1", self.endpoint.port)) {
                break tcp;
            }
            if Instant::now() >= deadline {
                return Err("SSH fixture did not start within five seconds".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        tcp.set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| error.to_string())?;
        tcp.set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| error.to_string())?;
        let mut session = Session::new().map_err(|error| error.to_string())?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|error| error.to_string())?;
        Ok(fingerprint(&session))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn fingerprint(session: &Session) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(session.host_key().unwrap().0))
}

pub(super) fn server() -> Option<Server> {
    server_with_environment(SessionEnvironment::default())
}

/// Session environment is supplied by the controlled CI fixture, never by a
/// product SSH request. Docker commands themselves remain unchanged.
pub(super) fn server_with_docker_host(docker_host: Option<&str>) -> Option<Server> {
    server_with_environment(SessionEnvironment {
        docker_host,
        ..SessionEnvironment::default()
    })
}

#[derive(Clone, Copy, Default)]
pub(super) struct SessionEnvironment<'a> {
    pub(super) docker_host: Option<&'a str>,
    pub(super) requests_ca_bundle: Option<&'a str>,
    pub(super) certbot_bin: Option<&'a str>,
}

pub(super) fn server_with_environment(environment: SessionEnvironment<'_>) -> Option<Server> {
    if !std::path::Path::new("/usr/sbin/sshd").exists() {
        eprintln!("real SSH tests require /usr/sbin/sshd");
        return None;
    }
    Some(start_server(environment).expect("real SSH fixture setup failed"))
}

fn docker_session_environment(docker_host: Option<&str>) -> Result<String, String> {
    let Some(value) = docker_host else {
        return Ok(String::new());
    };
    if !value.starts_with("unix:///")
        || value.len() > 512
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_/:.-".contains(&byte))
    {
        return Err("SSH fixture Docker socket environment is invalid".into());
    }
    Ok(format!("SetEnv DOCKER_HOST={value}\n"))
}

fn session_environment(environment: SessionEnvironment<'_>) -> Result<String, String> {
    let docker = docker_session_environment(environment.docker_host)?;
    let mut assignments = Vec::new();
    if !docker.is_empty() {
        assignments.push(docker.trim().strip_prefix("SetEnv ").unwrap().to_owned());
    }
    match (environment.requests_ca_bundle, environment.certbot_bin) {
        (None, None) => {}
        (Some(ca), Some(bin)) => {
            for value in [ca, bin] {
                if !value.starts_with('/')
                    || value.len() > 512
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_/.-".contains(&byte))
                {
                    return Err("SSH fixture ACME environment is invalid".into());
                }
            }
            assignments.push(format!(
                "REQUESTS_CA_BUNDLE={ca} NO_PROXY=localhost,127.0.0.1 PATH={bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ));
        }
        _ => return Err("SSH fixture ACME environment is incomplete".into()),
    }
    // sshd keeps the first SetEnv directive, so all assignments share one line.
    Ok(if assignments.is_empty() {
        String::new()
    } else {
        format!("SetEnv {}\n", assignments.join(" "))
    })
}

fn start_server(environment: SessionEnvironment<'_>) -> Result<Server, String> {
    let session_environment = session_environment(environment)?;
    let directory =
        std::env::temp_dir().join(format!("shellbeam-ssh-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    // Own cleanup before generating keys, including failure paths.
    let mut fixture = Server {
        child: None,
        directory,
        endpoint: Endpoint {
            host: "127.0.0.1".into(),
            port: 0,
            username: String::new(),
            auth_type: "privateKey".into(),
            secret: String::new(),
            passphrase: None,
        },
        fingerprint: String::new(),
    };
    for key in ["host", "client"] {
        let output = Command::new("ssh-keygen")
            .args(["-q", "-t", "rsa", "-b", "2048", "-m", "PEM", "-N", "", "-f"])
            .arg(fixture.directory.join(key))
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("fixture key generation failed".into());
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    fixture.endpoint.port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    let username = Command::new("id")
        .arg("-un")
        .output()
        .map_err(|error| error.to_string())?;
    if !username.status.success() {
        return Err("Cannot determine SSH fixture username".into());
    }
    fixture.endpoint.username = String::from_utf8(username.stdout)
        .map_err(|error| error.to_string())?
        .trim()
        .to_owned();
    fixture.endpoint.secret = std::fs::read_to_string(fixture.directory.join("client"))
        .map_err(|error| error.to_string())?;
    let configuration = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {directory}/host\nPidFile {directory}/pid\nAuthorizedKeysFile {directory}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nStrictModes no\nAllowTcpForwarding yes\nPubkeyAcceptedAlgorithms +ssh-rsa\nSubsystem sftp internal-sftp\nLogLevel ERROR\n{session_environment}",
        port = fixture.endpoint.port,
        directory = fixture.directory.display(),
    );
    std::fs::write(fixture.directory.join("config"), configuration)
        .map_err(|error| error.to_string())?;
    fixture.start()?;
    fixture.fingerprint = fixture.read_fingerprint()?;
    Ok(fixture)
}

pub(super) fn trusted<'a>(
    servers: &'a [&Server],
) -> impl FnMut(&Session, &Endpoint) -> Result<(), String> + 'a {
    move |session, endpoint| {
        let expected = servers
            .iter()
            .find(|server| {
                server.endpoint.host == endpoint.host && server.endpoint.port == endpoint.port
            })
            .ok_or("host_key_unknown")?;
        if fingerprint(session) != expected.fingerprint {
            return Err("host_key_mismatch".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::transport::{connect_with_verifier, Route};

    #[test]
    fn peer_docker_environment_cannot_inject_sshd_configuration() {
        assert_eq!(
            docker_session_environment(Some("unix:///tmp/shellbeam-peer.sock")).unwrap(),
            "SetEnv DOCKER_HOST=unix:///tmp/shellbeam-peer.sock\n"
        );
        for value in [
            "tcp://production:2375",
            "unix:///tmp/socket\nPermitRootLogin yes",
            "unix:///tmp/space socket",
            "unix:///tmp/quote\"socket",
        ] {
            assert!(docker_session_environment(Some(value)).is_err());
        }
        let acme = SessionEnvironment {
            requests_ca_bundle: Some("/tmp/ops-acme/transport-ca.pem"),
            certbot_bin: Some("/tmp/ops-acme/venv/bin"),
            ..SessionEnvironment::default()
        };
        let configuration = session_environment(acme).unwrap();
        assert!(configuration.contains("REQUESTS_CA_BUNDLE=/tmp/ops-acme/transport-ca.pem"));
        assert!(configuration.contains("NO_PROXY=localhost,127.0.0.1"));
        assert!(configuration.contains("PATH=/tmp/ops-acme/venv/bin:/usr/local/sbin:"));
        assert!(session_environment(SessionEnvironment {
            certbot_bin: None,
            ..acme
        })
        .is_err());
        for value in [
            "relative/bin",
            "/tmp/acme\nSetEnv EVIL=true",
            "/tmp/bin:/production/bin",
        ] {
            assert!(session_environment(SessionEnvironment {
                certbot_bin: Some(value),
                ..acme
            })
            .is_err());
        }
    }

    #[test]
    fn real_peer_session_environment_and_listener_failure_are_independent_through_one_jump() {
        let Some(primary) = server_with_environment(SessionEnvironment {
            docker_host: Some("unix:///tmp/shellbeam-primary-fixture.sock"),
            requests_ca_bundle: Some("/tmp/ops-acme/transport-ca.pem"),
            certbot_bin: Some("/tmp/ops-acme/venv/bin"),
        }) else {
            return;
        };
        let Some(mut peer) =
            server_with_docker_host(Some("unix:///tmp/shellbeam-peer-fixture.sock"))
        else {
            return;
        };
        let Some(jump) = server() else {
            return;
        };
        assert_ne!(primary.endpoint.port, peer.endpoint.port);
        assert_ne!(primary.fingerprint, peer.fingerprint);
        assert!(primary.endpoint.secret != peer.endpoint.secret);
        let primary_route = Route {
            target: primary.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
            vault_id: None,
        };
        let peer_route = Route {
            target: peer.endpoint.clone(),
            jump: Some(jump.endpoint.clone()),
            vault_id: None,
        };
        let read_environment = |route: &Route, peer: &Server| {
            let connection =
                connect_with_verifier(route, &mut trusted(&[&primary, &jump, peer])).unwrap();
            crate::ssh::commands::execute(
                connection,
                "printf '%s' \"$DOCKER_HOST\"",
                Instant::now(),
                Duration::from_secs(5),
            )
        };
        assert_eq!(
            read_environment(&primary_route, &peer).stdout,
            "unix:///tmp/shellbeam-primary-fixture.sock"
        );
        let connection =
            connect_with_verifier(&primary_route, &mut trusted(&[&primary, &jump, &peer])).unwrap();
        let acme_environment = crate::ssh::commands::execute(
            connection,
            "printf '%s\\n' \"$REQUESTS_CA_BUNDLE\" \"$NO_PROXY\" \"$PATH\"",
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!(acme_environment.exit_code, 0);
        let mut environment_lines = acme_environment.stdout.lines();
        assert_eq!(
            environment_lines.next(),
            Some("/tmp/ops-acme/transport-ca.pem")
        );
        assert_eq!(environment_lines.next(), Some("localhost,127.0.0.1"));
        // The opt-in runner is Linux/root. macOS user's zsh startup files can
        // replace PATH after sshd set it, so only that controlled shell proves
        // the exact executable search order; CA and proxy values stay portable.
        if cfg!(target_os = "linux") {
            assert_eq!(environment_lines.next(), Some("/tmp/ops-acme/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"));
        }
        let result = read_environment(&peer_route, &peer);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "unix:///tmp/shellbeam-peer-fixture.sock");
        assert_eq!(result.verified_host_keys.as_ref().unwrap().len(), 2);
        peer.stop().unwrap();
        assert!(
            connect_with_verifier(&peer_route, &mut trusted(&[&primary, &jump, &peer])).is_err()
        );
        // Target A and the common bastion remain live after stopping target B.
        let result = read_environment(&primary_route, &peer);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "unix:///tmp/shellbeam-primary-fixture.sock");
        peer.restart().unwrap();
        let result = read_environment(&peer_route, &peer);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "unix:///tmp/shellbeam-peer-fixture.sock");
    }

    #[test]
    fn real_listener_stop_and_restart_keep_the_original_trusted_endpoint() {
        let Some(mut target) = server() else {
            return;
        };
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
            vault_id: None,
        };
        let connection = connect_with_verifier(&route, &mut trusted(&[&target])).unwrap();
        let result = crate::ssh::commands::execute(
            connection,
            "printf before-stop",
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!(result.stdout, "before-stop");
        assert_eq!(result.exit_code, 0);
        target.stop().unwrap();
        // This is a real refused TCP connection, not an injected error value.
        assert!(connect_with_verifier(&route, &mut trusted(&[&target])).is_err());
        target.restart().unwrap();
        let connection = connect_with_verifier(&route, &mut trusted(&[&target])).unwrap();
        let result = crate::ssh::commands::execute(
            connection,
            "printf after-restart",
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!(result.stdout, "after-restart");
        assert_eq!(result.exit_code, 0);
    }
}
