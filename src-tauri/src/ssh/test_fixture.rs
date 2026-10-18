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
    if !std::path::Path::new("/usr/sbin/sshd").exists() {
        eprintln!("real SSH tests require /usr/sbin/sshd");
        return None;
    }
    Some(start_server().expect("real SSH fixture setup failed"))
}

fn start_server() -> Result<Server, String> {
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
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {directory}/host\nPidFile {directory}/pid\nAuthorizedKeysFile {directory}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nStrictModes no\nAllowTcpForwarding yes\nPubkeyAcceptedAlgorithms +ssh-rsa\nSubsystem sftp internal-sftp\nLogLevel ERROR\n",
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
    fn real_listener_stop_and_restart_keep_the_original_trusted_endpoint() {
        let Some(mut target) = server() else {
            return;
        };
        let route = Route {
            target: target.endpoint.clone(),
            jump: None,
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
