//! On-device approval before a peer receives decrypted vault secrets.
//!
//! A paired peer's key proves who is asking, not that anyone here wants the vault
//! to leave, and that key has been readable on disk. So every peer-initiated export
//! asks the person at this device. Silence means no: timeouts, a closed window and a
//! frontend that never heard the request all deny.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::storage::now_unix_ms;

pub(crate) const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const VAULT_EXPORT_DENIED: &str =
    "The other device did not approve sending its vault secrets.";
const APPROVAL_EVENT: &str = "sync-vault-export-approval";
const MAX_PENDING: usize = 4;

struct PendingApproval {
    peer_device_id: String,
    answer: Sender<bool>,
}

#[derive(Default)]
struct Broker {
    pending: HashMap<String, PendingApproval>,
    grants: HashMap<(String, String), Instant>,
}

impl Broker {
    /// One open prompt per peer, and few overall, so a peer cannot bury the screen.
    fn begin(&mut self, peer_device_id: &str) -> Option<(String, Receiver<bool>)> {
        if self.pending.len() >= MAX_PENDING
            || self
                .pending
                .values()
                .any(|p| p.peer_device_id == peer_device_id)
        {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (answer, receiver) = channel();
        self.pending.insert(
            id.clone(),
            PendingApproval {
                peer_device_id: peer_device_id.to_string(),
                answer,
            },
        );
        Some((id, receiver))
    }

    fn resolve(&mut self, request_id: &str, approved: bool) -> bool {
        match self.pending.remove(request_id) {
            Some(pending) => pending.answer.send(approved).is_ok(),
            None => false,
        }
    }

    fn take_grant(&mut self, peer_device_id: &str, vault_id: &str, now: Instant) -> bool {
        self.grants.retain(|_, expires| *expires > now);
        self.grants
            .remove(&(peer_device_id.to_string(), vault_id.to_string()))
            .is_some()
    }
}

static BROKER: LazyLock<Mutex<Broker>> = LazyLock::new(Mutex::default);

fn broker() -> std::sync::MutexGuard<'static, Broker> {
    BROKER.lock().unwrap_or_else(|e| e.into_inner())
}

/// A push the person here started makes the peer call back for the data, which
/// needs no second question. Good for one export of this vault to this peer.
pub(crate) fn grant_for_local_push(peer_device_id: &str, vault_id: &str) {
    broker().grants.insert(
        (peer_device_id.to_string(), vault_id.to_string()),
        Instant::now() + APPROVAL_TIMEOUT,
    );
}

pub(crate) fn revoke_local_push(peer_device_id: &str, vault_id: &str) {
    broker()
        .grants
        .remove(&(peer_device_id.to_string(), vault_id.to_string()));
}

fn wait_for_answer(receiver: &Receiver<bool>, timeout: Duration) -> bool {
    receiver.recv_timeout(timeout).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    request_id: String,
    peer_device_id: String,
    peer_name: String,
    vault_id: String,
    vault_name: String,
    expires_at: i64,
}

/// Blocks this connection's thread until the person answers or time runs out.
pub(crate) fn authorize_export(
    app: &tauri::AppHandle,
    peer_device_id: &str,
    vault_id: &str,
) -> bool {
    if broker().take_grant(peer_device_id, vault_id, Instant::now()) {
        return true;
    }
    let Some((request_id, receiver)) = broker().begin(peer_device_id) else {
        return false;
    };
    let peer_name = super::load_sync_state_for_transport(app)
        .ok()
        .and_then(|state| {
            state
                .trusted_peers
                .into_iter()
                .find(|p| p.peer_device_id == peer_device_id)
                .and_then(|p| p.peer_device_name)
        })
        .unwrap_or_else(|| peer_device_id.to_string());
    let vault_name = super::vault_ref::local_vault_ref(app, Some(vault_id))
        .map(|(_, name)| name)
        .unwrap_or_else(|_| vault_id.to_string());
    let request = ApprovalRequest {
        request_id: request_id.clone(),
        peer_device_id: peer_device_id.to_string(),
        peer_name,
        vault_id: vault_id.to_string(),
        vault_name,
        expires_at: now_unix_ms() + APPROVAL_TIMEOUT.as_millis() as i64,
    };
    let approved =
        app.emit(APPROVAL_EVENT, &request).is_ok() && wait_for_answer(&receiver, APPROVAL_TIMEOUT);
    broker().pending.remove(&request_id);
    log::info!(
        "[sync] vault export for peer {peer_device_id}: {}",
        if approved { "approved" } else { "denied" }
    );
    approved
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResolveVaultExportRequest {
    request_id: String,
    approved: bool,
}

#[tauri::command]
pub fn sync_resolve_vault_export(payload: SyncResolveVaultExportRequest) {
    broker().resolve(&payload.request_id, payload.approved);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_denies() {
        let mut broker = Broker::default();
        let (_id, receiver) = broker.begin("peer").unwrap();
        assert!(!wait_for_answer(&receiver, Duration::from_millis(5)));
    }

    #[test]
    fn dropped_request_denies() {
        let mut broker = Broker::default();
        let (id, receiver) = broker.begin("peer").unwrap();
        broker.pending.remove(&id);
        assert!(!wait_for_answer(&receiver, Duration::from_secs(5)));
    }

    #[test]
    fn answers_reach_only_their_own_request() {
        let mut broker = Broker::default();
        let (id, receiver) = broker.begin("peer").unwrap();
        assert!(!broker.resolve("other", true));
        assert!(broker.resolve(&id, true));
        assert!(wait_for_answer(&receiver, Duration::from_secs(5)));
        assert!(!broker.resolve(&id, true), "an answer cannot be replayed");

        let (id, receiver) = broker.begin("peer").unwrap();
        broker.resolve(&id, false);
        assert!(!wait_for_answer(&receiver, Duration::from_secs(5)));
    }

    #[test]
    fn a_peer_cannot_stack_prompts() {
        let mut broker = Broker::default();
        let _first = broker.begin("peer").unwrap();
        assert!(broker.begin("peer").is_none());
        let _others: Vec<_> = (1..MAX_PENDING)
            .map(|i| broker.begin(&format!("peer-{i}")).unwrap())
            .collect();
        assert!(broker.begin("one-more").is_none());
    }

    #[test]
    fn a_push_grant_is_single_use_scoped_and_expires() {
        let mut broker = Broker::default();
        let now = Instant::now();
        let key = |p: &str, v: &str| (p.to_string(), v.to_string());
        broker
            .grants
            .insert(key("peer", "vault"), now + APPROVAL_TIMEOUT);
        assert!(!broker.take_grant("other", "vault", now));
        assert!(!broker.take_grant("peer", "other", now));
        assert!(broker.take_grant("peer", "vault", now));
        assert!(!broker.take_grant("peer", "vault", now));
        broker.grants.insert(key("peer", "vault"), now);
        assert!(!broker.take_grant("peer", "vault", now + Duration::from_secs(1)));
    }
}
