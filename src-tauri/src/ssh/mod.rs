pub mod auth_prompt;
pub mod commands;
pub mod forward;
pub mod http_proxy;
pub mod interactive;
pub mod transport;

#[cfg(test)]
mod ops_smoke;
#[cfg(test)]
mod test_fixture;

pub(crate) use commands::run_ssh_command_sync;

use base64;
use serde::{Deserialize, Serialize};
use sha2;
use ssh2::Session;
use std::time::Instant;

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRequest {
    pub host_id: Option<String>,
    pub vault_id: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_user: Option<String>,
    pub command: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_identity: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_host_keys: Option<Vec<transport::VerifiedHostKey>>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u128,
    pub error_type: Option<String>,
    pub error_code: Option<String>,
    pub error_source: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub connected: bool,
    pub duration_ms: u128,
    pub error_type: Option<String>,
    pub message: Option<String>,
    pub error_code: Option<String>,
    pub error_source: Option<String>,
    pub retryable: Option<bool>,
}

pub fn failed_result(
    started_at: Instant,
    message: String,
    error_type: &str,
    error_code: &str,
    error_source: &str,
    retryable: bool,
) -> CommandRunResult {
    CommandRunResult {
        host_identity: None,
        verified_host_keys: None,
        stdout: String::new(),
        stderr: message,
        exit_code: -1,
        duration_ms: started_at.elapsed().as_millis(),
        error_type: Some(error_type.to_string()),
        error_code: Some(error_code.to_string()),
        error_source: Some(error_source.to_string()),
        retryable: Some(retryable),
    }
}

/// Checks against the known hosts of `vault_id` only (None means Personal).
pub(crate) fn verify_host_key(
    session: &Session,
    app: &tauri::AppHandle,
    vault_id: Option<&str>,
    host: &str,
    port: u16,
    accept_host_key: bool,
) -> Result<(), String> {
    use crate::error::{host_key_mismatch_payload, host_key_unknown_payload};
    use crate::net::known_hosts::{add_known_host, verify_known_host};

    let (key_bytes, key_type) = session
        .host_key()
        .ok_or_else(|| "Failed to get host key after handshake".to_string())?;
    let key_type_str = format!("{:?}", key_type);

    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(key_bytes);
    let fingerprint = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hash);

    match verify_known_host(app, vault_id, host, port, &fingerprint) {
        Ok(true) => Ok(()),
        Ok(false) => {
            if accept_host_key {
                add_known_host(app, vault_id, host, port, &fingerprint, &key_type_str)?;
                Ok(())
            } else {
                Err(host_key_unknown_payload(
                    host,
                    port,
                    &fingerprint,
                    &key_type_str,
                ))
            }
        }
        Err(_mismatch) => Err(host_key_mismatch_payload(
            host,
            port,
            &fingerprint,
            &key_type_str,
        )),
    }
}

/// Errors `authenticate_session` returns that the connect path reports as their own step.
pub(crate) const AUTH_NEEDS_CODE: &str = "SSH_AUTH_NEEDS_CODE";
pub(crate) const AUTH_CANCELLED: &str = "SSH_AUTH_CANCELLED";
pub(crate) const AGENT_UNAVAILABLE: &str = "SSH_AGENT_UNAVAILABLE";

/// Where an authentication runs, for the prompt the user sees.
pub(crate) struct AuthContext<'a> {
    pub stage: &'a str,
    pub host: &'a str,
    pub port: u16,
}

fn offers(methods: &str, name: &str) -> bool {
    methods.split(',').any(|method| method.trim() == name)
}

/// A prompt that asks for the account password, as opposed to a one-time code.
fn asks_for_password(text: &str) -> bool {
    let text = text.to_lowercase();
    let password = [
        "password",
        "passwort",
        "mot de passe",
        "contraseña",
        "密码",
        "密碼",
        "パスワード",
    ]
    .iter()
    .any(|word| text.contains(word));
    let code = [
        "one-time",
        "one time",
        "otp",
        "verification",
        "token",
        "code",
        "验证码",
        "動態",
        "pin",
    ]
    .iter()
    .any(|word| text.contains(word));
    password && !code
}

/// Answers keyboard-interactive challenges: the saved password once, for a
/// prompt that asks for it, and everything else (one-time codes) from the user.
struct InteractiveAnswers<'a> {
    context: &'a AuthContext<'a>,
    password: Option<&'a str>,
    password_used: bool,
    prompter: Option<std::rc::Rc<dyn auth_prompt::AuthPrompter>>,
    needs_user: bool,
    cancelled: bool,
}

impl ssh2::KeyboardInteractivePrompt for InteractiveAnswers<'_> {
    fn prompt<'b>(
        &mut self,
        username: &str,
        instructions: &str,
        prompts: &[ssh2::Prompt<'b>],
    ) -> Vec<String> {
        let blank = || vec![String::new(); prompts.len()];
        // Some servers send an empty round (Duo push) or a banner; nothing to answer.
        if prompts.is_empty() {
            return Vec::new();
        }
        if self.cancelled {
            return blank();
        }
        if let (false, Some(password), [prompt]) = (self.password_used, self.password, prompts) {
            if !prompt.echo && asks_for_password(&prompt.text) {
                self.password_used = true;
                return vec![password.to_string()];
            }
        }
        let Some(prompter) = self.prompter.clone() else {
            self.needs_user = true;
            return blank();
        };
        let request = auth_prompt::request(
            self.context.stage,
            self.context.host,
            self.context.port,
            username,
            instructions,
            prompts,
        );
        match prompter.ask(request) {
            Some(mut answers) => {
                answers.resize(prompts.len(), String::new());
                answers
            }
            None => {
                self.cancelled = true;
                blank()
            }
        }
    }
}

fn keyboard_interactive(
    session: &Session,
    username: &str,
    context: &AuthContext<'_>,
    password: Option<&str>,
) -> Result<(), String> {
    let mut answers = InteractiveAnswers {
        context,
        password: password.filter(|value| !value.is_empty()),
        password_used: false,
        prompter: auth_prompt::current_prompter(),
        needs_user: false,
        cancelled: false,
    };
    let result = session.userauth_keyboard_interactive(username, &mut answers);
    if session.authenticated() {
        return Ok(());
    }
    if answers.cancelled {
        return Err(AUTH_CANCELLED.into());
    }
    if answers.needs_user {
        return Err(AUTH_NEEDS_CODE.into());
    }
    result.map_err(|err| format!("Keyboard-interactive auth failed: {err}"))
}

fn agent_auth(session: &Session, username: &str) -> Result<(), String> {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        return Err(AGENT_UNAVAILABLE.into());
    }
    let mut agent = session.agent().map_err(|_| AGENT_UNAVAILABLE.to_string())?;
    agent.connect().map_err(|_| AGENT_UNAVAILABLE.to_string())?;
    agent
        .list_identities()
        .map_err(|_| AGENT_UNAVAILABLE.to_string())?;
    let identities = agent
        .identities()
        .map_err(|_| AGENT_UNAVAILABLE.to_string())?;
    if identities.is_empty() {
        let _ = agent.disconnect();
        return Err("The SSH agent holds no keys".into());
    }
    let mut last_error = None;
    for identity in &identities {
        // Ok without being authenticated is partial success: the server wants another method next.
        match agent.userauth(username, identity) {
            Ok(()) => break,
            Err(err) => last_error = Some(err),
        }
    }
    let _ = agent.disconnect();
    if session.authenticated() || last_error.is_none() {
        Ok(())
    } else {
        Err(format!(
            "Agent auth failed: {}",
            last_error.map(|e| e.to_string()).unwrap_or_default()
        ))
    }
}

pub(crate) fn authenticate_session(
    session: &mut Session,
    username: &str,
    auth_type: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
    context: &AuthContext<'_>,
) -> Result<(), String> {
    // Listing the methods sends "none", which some servers accept outright.
    let offered = session
        .auth_methods(username)
        .map(str::to_owned)
        .unwrap_or_default();
    if session.authenticated() {
        return Ok(());
    }
    let mut tried_interactive = false;
    let primary = match auth_type {
        "password" => {
            let password = password.unwrap_or_default();
            if password.is_empty() {
                return Err("password is required for password auth".to_string());
            }
            // PAM-only servers offer keyboard-interactive and not "password".
            if !offers(&offered, "password") && offers(&offered, "keyboard-interactive") {
                tried_interactive = true;
                keyboard_interactive(session, username, context, Some(password))
            } else {
                session
                    .userauth_password(username, password)
                    .map_err(|err| format!("Password auth failed: {err}"))
            }
        }
        "privateKey" => {
            let private_key = private_key.unwrap_or_default();
            if private_key.is_empty() {
                return Err("privateKey is required for private key auth".to_string());
            }
            session
                .userauth_pubkey_memory(username, None, private_key, passphrase)
                .map_err(|err| format!("Private key auth failed: {err}"))
        }
        "agent" => agent_auth(session, username),
        _ => return Err("Unsupported authType. Use password, privateKey or agent.".to_string()),
    };
    if session.authenticated() {
        return Ok(());
    }
    if let Err(error) = &primary {
        if [AUTH_CANCELLED, AUTH_NEEDS_CODE, AGENT_UNAVAILABLE].contains(&error.as_str()) {
            return primary;
        }
    }
    // A second factor: the first method was accepted and the server now asks
    // for keyboard-interactive, which it did not offer before (OpenSSH
    // AuthenticationMethods publickey,keyboard-interactive). A password the
    // server turned down may also be retried through keyboard-interactive.
    let remaining = session
        .auth_methods(username)
        .map(str::to_owned)
        .unwrap_or_default();
    let second_factor = offers(&remaining, "keyboard-interactive")
        && !tried_interactive
        && (!offers(&offered, "keyboard-interactive") || auth_type == "password");
    if second_factor {
        keyboard_interactive(session, username, context, password)?;
    } else {
        primary?;
    }
    if !session.authenticated() {
        return Err("SSH authentication failed".to_string());
    }
    Ok(())
}

#[derive(Default)]
pub struct SshSessionPool;

#[cfg(test)]
mod keyboard_interactive_tests {
    use super::auth_prompt::{with_prompter, AuthPromptRequest, AuthPrompter};
    use super::*;
    use ssh2::KeyboardInteractivePrompt;
    use std::borrow::Cow;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct Scripted {
        answers: RefCell<Vec<Option<Vec<String>>>>,
        asked: RefCell<Vec<AuthPromptRequest>>,
    }
    impl AuthPrompter for Scripted {
        fn ask(&self, request: AuthPromptRequest) -> Option<Vec<String>> {
            self.asked.borrow_mut().push(request);
            self.answers.borrow_mut().remove(0)
        }
    }
    fn scripted(answers: Vec<Option<Vec<String>>>) -> Rc<Scripted> {
        Rc::new(Scripted {
            answers: RefCell::new(answers),
            asked: RefCell::new(Vec::new()),
        })
    }
    fn prompt(text: &str, echo: bool) -> ssh2::Prompt<'static> {
        ssh2::Prompt {
            text: Cow::Owned(text.into()),
            echo,
        }
    }
    const CONTEXT: AuthContext<'static> = AuthContext {
        stage: "target",
        host: "db.internal",
        port: 22,
    };
    fn answers<'a>(
        password: Option<&'a str>,
        prompter: Option<Rc<dyn AuthPrompter>>,
    ) -> InteractiveAnswers<'a> {
        InteractiveAnswers {
            context: &CONTEXT,
            password,
            password_used: false,
            prompter,
            needs_user: false,
            cancelled: false,
        }
    }

    #[test]
    fn tells_a_password_prompt_from_a_one_time_code() {
        for text in ["Password:", "root@db's password: ", "密码：", "Passwort:"] {
            assert!(asks_for_password(text), "{text}");
        }
        for text in [
            "Verification code: ",
            "One-time password (OATH) for `root':",
            "Enter your OTP:",
            "Duo two-factor login: passcode",
            "Token code:",
            "验证码：",
        ] {
            assert!(!asks_for_password(text), "{text}");
        }
        assert!(offers(
            "publickey,keyboard-interactive",
            "keyboard-interactive"
        ));
        assert!(!offers("publickey,password", "keyboard-interactive"));
    }

    #[test]
    fn fills_the_saved_password_once_and_asks_the_user_for_the_code() {
        let user = scripted(vec![Some(vec!["123456".into()])]);
        let mut responder = answers(Some("hunter2"), Some(user.clone()));
        assert_eq!(
            responder.prompt("root", "", &[prompt("Password: ", false)]),
            vec!["hunter2"]
        );
        assert_eq!(
            responder.prompt(
                "root",
                "Use your app",
                &[prompt("Verification code: ", true)]
            ),
            vec!["123456"]
        );
        let asked = user.asked.borrow();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].instruction, "Use your app");
        assert_eq!(asked[0].prompts[0].text, "Verification code:");
        assert!(asked[0].prompts[0].echo);
        // A second password prompt (the first was wrong) goes to the user, not the saved password again.
        drop(asked);
        let retry = scripted(vec![Some(vec!["typed".into()])]);
        responder.prompter = Some(retry.clone());
        assert_eq!(
            responder.prompt("root", "", &[prompt("Password: ", false)]),
            vec!["typed"]
        );
        assert_eq!(retry.asked.borrow().len(), 1);
    }

    #[test]
    fn without_anyone_to_ask_it_reports_that_a_code_is_needed() {
        let mut responder = answers(Some("hunter2"), None);
        assert_eq!(
            responder.prompt("root", "", &[prompt("Verification code: ", false)]),
            vec![""]
        );
        assert!(responder.needs_user);
        assert!(!responder.cancelled);
    }

    #[test]
    fn a_cancelled_prompt_stops_asking_and_answers_every_question() {
        let user = scripted(vec![None]);
        let mut responder = answers(None, Some(user.clone()));
        let two = [prompt("Code: ", false), prompt("PIN: ", false)];
        assert_eq!(responder.prompt("root", "", &two), vec!["", ""]);
        assert!(responder.cancelled);
        assert_eq!(responder.prompt("root", "", &two), vec!["", ""]);
        assert_eq!(user.asked.borrow().len(), 1);
        // Fewer answers than questions are padded so the reply stays well formed.
        let short = scripted(vec![Some(vec!["1".into()])]);
        let mut responder = answers(None, Some(short));
        assert_eq!(responder.prompt("root", "", &two), vec!["1", ""]);
        // An empty round (a push notification) needs no answer and asks no one.
        let mut responder = answers(None, None);
        assert!(responder.prompt("root", "Check your phone", &[]).is_empty());
        assert!(!responder.needs_user);
    }

    #[test]
    fn a_prompter_only_serves_the_connect_it_wraps() {
        assert!(auth_prompt::current_prompter().is_none());
        let user = scripted(vec![]);
        with_prompter(user, || assert!(auth_prompt::current_prompter().is_some()));
        assert!(auth_prompt::current_prompter().is_none());
        let result = std::panic::catch_unwind(|| {
            with_prompter(scripted(vec![]), || panic!("connect failed"))
        });
        assert!(result.is_err());
        assert!(auth_prompt::current_prompter().is_none());
    }

    #[test]
    fn server_text_reaching_the_dialog_is_bounded() {
        let long = "x".repeat(5000);
        let prompts: Vec<_> = (0..20).map(|_| prompt(&long, false)).collect();
        let request = auth_prompt::request("target", "h", 22, "u", &long, &prompts);
        assert_eq!(request.prompts.len(), 8);
        assert_eq!(request.instruction.chars().count(), 512);
        assert_eq!(request.prompts[0].text.chars().count(), 512);
    }
}
