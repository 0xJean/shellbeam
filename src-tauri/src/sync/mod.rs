pub mod commands;
pub mod peer;
pub(crate) mod transport;
pub(crate) mod transport_mdns;

pub use commands::*;

use serde::{Deserialize, Serialize};

use crate::storage::{data_file_path, read_json_or_default, write_json, SYNC_STATE_FILE};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceIdentity {
    pub(crate) device_id: String,
    pub(crate) device_name: String,
    pub(crate) public_key: String,
    pub(crate) created_at: i64,
    pub(crate) last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChangeRecord {
    pub version: u64,
    pub change_id: String,
    pub(crate) object_type: String,
    pub(crate) object_id: String,
    pub(crate) updated_at: i64,
    pub(crate) updated_by: String,
    pub(crate) checksum: Option<String>,
    pub(crate) deleted: bool,
    pub(crate) summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursorRecord {
    pub peer_device_id: String,
    pub last_pulled_version: u64,
    pub last_pushed_version: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTrustedPeer {
    pub peer_device_id: String,
    pub peer_device_name: Option<String>,
    pub verified_at: i64,
    pub last_seen_at: i64,
    pub source: String,
    #[serde(default)]
    pub peer_endpoint: Option<String>,
    #[serde(default)]
    pub sync_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncPairingSessionRecord {
    pub(crate) session_id: String,
    pub(crate) initiator_device_id: String,
    pub(crate) initiator_device_name: String,
    pub(crate) verification_code: String,
    pub(crate) status: String,
    pub(crate) created_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) verified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStateFile {
    pub schema_version: u32,
    pub local_device: Option<SyncDeviceIdentity>,
    pub changes: Vec<SyncChangeRecord>,
    pub cursors: Vec<SyncCursorRecord>,
    pub trusted_peers: Vec<SyncTrustedPeer>,
    pub pairing_sessions: Vec<SyncPairingSessionRecord>,
    pub last_sync_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncInitDeviceRequest {
    pub(crate) device_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRegisterChangeRequest {
    pub(crate) object_type: String,
    pub(crate) object_id: String,
    pub(crate) updated_by: Option<String>,
    pub(crate) checksum: Option<String>,
    pub(crate) deleted: Option<bool>,
    pub(crate) summary: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncQueryChangesRequest {
    pub(crate) since_version: Option<u64>,
    pub(crate) limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncUpsertCursorRequest {
    pub(crate) peer_device_id: String,
    pub(crate) last_pulled_version: Option<u64>,
    pub(crate) last_pushed_version: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStartPairingRequest {
    pub(crate) peer_device_name_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncConfirmPairingRequest {
    pub(crate) session_id: String,
    pub(crate) verification_code: String,
    pub(crate) peer_device_id: Option<String>,
    pub(crate) peer_device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBootstrapResponse {
    schema_version: u32,
    local_device: Option<SyncDeviceIdentity>,
    latest_version: u64,
    change_count: usize,
    cursor_count: usize,
    trusted_peer_count: usize,
    active_pairing_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPairingSessionResponse {
    pub(crate) session_id: String,
    pub(crate) initiator_device_id: String,
    pub(crate) initiator_device_name: String,
    pub(crate) verification_code: String,
    pub(crate) status: String,
    pub(crate) created_at: i64,
    pub(crate) expires_at: i64,
}

pub fn load_sync_state_for_transport(app: &tauri::AppHandle) -> Result<SyncStateFile, String> {
    load_sync_state(app)
}

pub fn save_sync_state_for_transport(
    app: &tauri::AppHandle,
    state: &SyncStateFile,
) -> Result<(), String> {
    save_sync_state(app, state)
}

pub(crate) fn load_sync_state(app: &tauri::AppHandle) -> Result<SyncStateFile, String> {
    let path = data_file_path(app, SYNC_STATE_FILE)?;
    if !path.exists() {
        return Ok(SyncStateFile {
            schema_version: 1,
            trusted_peers: vec![],
            pairing_sessions: vec![],
            ..SyncStateFile::default()
        });
    }
    let mut state = read_json_or_default::<SyncStateFile>(&path)?;
    if state.schema_version == 0 {
        state.schema_version = 1;
    }
    state
        .trusted_peers
        .retain(|item| !item.peer_device_id.trim().is_empty());
    Ok(state)
}

pub(crate) fn save_sync_state(app: &tauri::AppHandle, state: &SyncStateFile) -> Result<(), String> {
    let path = data_file_path(app, SYNC_STATE_FILE)?;
    write_json(&path, state)
}
