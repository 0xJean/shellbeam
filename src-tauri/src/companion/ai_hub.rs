//! Desktop AI conversation mirror hub.
//! Desktop's `AICommandBar` publishes redacted snapshots of active conversations here;
//! connected mobile companion clients subscribe to snapshots and dispatch remote actions
//! (`run_pending`, `cancel`, `send_prompt`) back to the desktop UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub executed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAiSessionSnapshot {
    pub session_id: String,
    pub host_label: String,
    pub mode: String,
    pub model_label: String,
    pub is_streaming: bool,
    pub streaming_text: String,
    pub step_label: String,
    pub pending_command: Option<String>,
    pub pending_risk: Option<String>,
    pub pending_message_id: Option<String>,
    pub messages: Vec<RemoteAiMessage>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAiActionEvent {
    pub session_id: String,
    pub action: String, // "run_pending" | "cancel" | "send_prompt" | "set_mode"
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    pub peer_device_id: String,
}

struct AiSubscriber {
    id: u64,
    tx: mpsc::Sender<DesktopAiSessionSnapshot>,
}

#[derive(Default)]
pub struct CompanionAiHub {
    snapshots: Mutex<HashMap<String, DesktopAiSessionSnapshot>>,
    subscribers: Mutex<Vec<AiSubscriber>>,
    next_sub_id: AtomicU64,
}

impl CompanionAiHub {
    pub fn publish(&self, snapshot: DesktopAiSessionSnapshot) {
        if let Ok(mut map) = self.snapshots.lock() {
            map.insert(snapshot.session_id.clone(), snapshot.clone());
        }
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|sub| sub.tx.send(snapshot.clone()).is_ok());
        }
    }

    pub fn remove_session(&self, session_id: &str) {
        if let Ok(mut map) = self.snapshots.lock() {
            map.remove(session_id);
        }
    }

    pub fn list(&self) -> Vec<DesktopAiSessionSnapshot> {
        self.snapshots
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get(&self, session_id: &str) -> Option<DesktopAiSessionSnapshot> {
        self.snapshots
            .lock()
            .ok()
            .and_then(|map| map.get(session_id).cloned())
    }

    pub fn subscribe(&self) -> (u64, mpsc::Receiver<DesktopAiSessionSnapshot>) {
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.push(AiSubscriber { id, tx });
        }
        (id, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|sub| sub.id != id);
        }
    }

    pub fn dispatch_action(
        &self,
        app: &tauri::AppHandle,
        event: CompanionAiActionEvent,
    ) -> Result<(), String> {
        app.emit("companion:ai-action", event)
            .map_err(|e| format!("emit ai action: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_and_fans_out_snapshots_to_subscribers() {
        let hub = CompanionAiHub::default();
        let (sub_id, rx) = hub.subscribe();
        let snap = DesktopAiSessionSnapshot {
            session_id: "sess-1".into(),
            host_label: "prod-web-1".into(),
            mode: "confirm".into(),
            model_label: "Claude Code".into(),
            is_streaming: false,
            streaming_text: String::new(),
            step_label: String::new(),
            pending_command: Some("systemctl status nginx".into()),
            pending_risk: Some("safe".into()),
            pending_message_id: Some("m-1".into()),
            messages: vec![],
            updated_at: 1000,
        };
        hub.publish(snap.clone());
        let received = rx.try_recv().unwrap();
        assert_eq!(received.session_id, "sess-1");
        assert_eq!(
            received.pending_command.as_deref(),
            Some("systemctl status nginx")
        );
        assert_eq!(hub.list().len(), 1);
        hub.unsubscribe(sub_id);
        hub.remove_session("sess-1");
        assert!(hub.list().is_empty());
    }
}
