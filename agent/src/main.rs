use shellbeam_agent as agent;
use std::{path::PathBuf, time::Duration};
fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{}",
            serde_json::json!({"status":"failed","health":"unknown","errorCode":"agent_command_failed","errorSummary":error.to_string()})
        );
        std::process::exit(1);
    }
}
fn run() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.first().map(String::as_str).unwrap_or("help");
    let option = |name: &str| {
        args.iter()
            .position(|value| value == name)
            .and_then(|index| args.get(index + 1))
    };
    let directory = option("--state-dir")
        .map(PathBuf::from)
        .unwrap_or_else(agent::state_dir);
    let executable = option("--path")
        .map(PathBuf::from)
        .unwrap_or_else(|| agent::home_dir().join(".local/bin/shellbeam-agent"));
    let value = match action {
        "daemon" => {
            let interval = option("--interval-seconds")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(1, 86400);
            let limit = option("--history-limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(agent::HISTORY_LIMIT)
                .clamp(1, agent::HISTORY_LIMIT);
            agent::daemon(&directory, Duration::from_secs(interval), limit)?;
            return Ok(());
        }
        "collect" => agent::collect(),
        "probe" => match agent::probe(&directory) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                serde_json::json!({"status":"not-installed","health":"unknown","capabilities":[]})
            }
            Err(error) => return Err(error),
        },
        "history" => agent::history(
            &directory,
            option("--limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(100),
        )?,
        "install" | "upgrade" => agent::install(&executable, &directory)?,
        "uninstall" => agent::uninstall(
            &executable,
            &directory,
            args.iter().any(|arg| arg == "--purge"),
        )?,
        "service" => {
            agent::service(args.get(1).map(String::as_str).unwrap_or("status"))?;
            agent::probe(&directory)?
        }
        "version" | "--version" => {
            serde_json::json!({"version":agent::VERSION,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH})
        }
        _ => {
            println!("ShellBeam Agent {}\nCommands: daemon, collect --json, probe --json, history --json, install --json, upgrade --json, uninstall --json [--purge], service start|stop|restart|status.\nState: ~/.local/share/shellbeam-agent (0600); service: systemd --user or launchd; no listening ports or outbound traffic.\nLinux requires an active user systemd manager; persistent post-logout collection requires the administrator to enable linger for that account explicitly.",agent::VERSION);
            return Ok(());
        }
    };
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}
