//! Questions a server asks during keyboard-interactive authentication (a
//! one-time code, a second password) are put to the user who opened the
//! connection, and only to them.
//!
//! A connection the user is waiting on installs a prompter for the duration of
//! its connect call with [`with_prompter`]. Background connections (monitoring,
//! scheduled operations, MCP) never install one, so a server that wants a code
//! fails them with `auth_needs_code` instead of popping up a dialog nobody
//! asked for.
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub const AUTH_PROMPT_EVENT: &str = "ssh-auth-prompt";
pub const AUTH_PROMPT_CLOSED_EVENT: &str = "ssh-auth-prompt-closed";
/// Long enough to find a phone; servers usually allow two minutes (LoginGraceTime).
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
/// A server controls this text; keep what reaches the UI bounded.
const MAX_PROMPTS: usize = 8;
const MAX_TEXT: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub text: String,
    /// False for secrets: the answer is typed hidden.
    pub echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptRequest {
    /// `target` or `jump`.
    pub stage: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub instruction: String,
    pub prompts: Vec<PromptField>,
}

pub trait AuthPrompter {
    /// The answers, one per prompt, or None when the user cancelled or did not answer in time.
    fn ask(&self, request: AuthPromptRequest) -> Option<Vec<String>>;
}

thread_local! {
    static PROMPTER: RefCell<Option<Rc<dyn AuthPrompter>>> = const { RefCell::new(None) };
}

/// Runs `connect` with `prompter` answering the servers it authenticates to.
pub fn with_prompter<T>(prompter: Rc<dyn AuthPrompter>, connect: impl FnOnce() -> T) -> T {
    struct Restore(Option<Rc<dyn AuthPrompter>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            PROMPTER.with(|slot| *slot.borrow_mut() = previous);
        }
    }
    let previous = PROMPTER.with(|slot| slot.borrow_mut().replace(prompter));
    let _restore = Restore(previous);
    connect()
}

pub(crate) fn current_prompter() -> Option<Rc<dyn AuthPrompter>> {
    PROMPTER.with(|slot| slot.borrow().clone())
}

fn bounded(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

pub(crate) fn request(
    stage: &str,
    host: &str,
    port: u16,
    username: &str,
    instruction: &str,
    prompts: &[ssh2::Prompt<'_>],
) -> AuthPromptRequest {
    AuthPromptRequest {
        stage: stage.into(),
        host: bounded(host),
        port,
        username: bounded(username),
        instruction: bounded(instruction.trim()),
        prompts: prompts
            .iter()
            .take(MAX_PROMPTS)
            .map(|prompt| PromptField {
                text: bounded(prompt.text.trim()),
                echo: prompt.echo,
            })
            .collect(),
    }
}

#[derive(Default)]
pub struct AuthPromptState {
    pending: Mutex<HashMap<String, mpsc::Sender<Option<Vec<String>>>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthPromptEvent<'a> {
    id: &'a str,
    session_id: &'a str,
    #[serde(flatten)]
    request: &'a AuthPromptRequest,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthPromptClosedEvent<'a> {
    id: &'a str,
}

/// Asks through the app window and waits for the answer.
pub struct UiPrompter {
    pub app: tauri::AppHandle,
    /// The terminal tab the connection is for, so the dialog can name it.
    pub session_id: String,
}

impl AuthPrompter for UiPrompter {
    fn ask(&self, request: AuthPromptRequest) -> Option<Vec<String>> {
        let state = self.app.state::<AuthPromptState>();
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        state.pending.lock().ok()?.insert(id.clone(), sender);
        let event = AuthPromptEvent {
            id: &id,
            session_id: &self.session_id,
            request: &request,
        };
        if self.app.emit(AUTH_PROMPT_EVENT, event).is_err() {
            state.pending.lock().ok()?.remove(&id);
            return None;
        }
        let answer = receiver.recv_timeout(PROMPT_TIMEOUT);
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        if answer.is_err() {
            let _ = self
                .app
                .emit(AUTH_PROMPT_CLOSED_EVENT, AuthPromptClosedEvent { id: &id });
        }
        answer.ok().flatten()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptResponse {
    id: String,
    /// None cancels the sign-in.
    answers: Option<Vec<String>>,
}

#[tauri::command]
pub fn ssh_auth_prompt_respond(
    state: tauri::State<'_, AuthPromptState>,
    payload: AuthPromptResponse,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|_| "Auth prompt state lock poisoned".to_string())?
        .remove(&payload.id);
    // An answer to a prompt that already timed out is dropped.
    if let Some(sender) = sender {
        let _ = sender.send(payload.answers);
    }
    Ok(())
}
