//! End-to-end encrypted framing for persistent Companion Bridge connections.
//!
//! After authenticating over `sync_hello` with the paired device's 32-byte X25519-derived
//! `sync_key`, both sides derive directional AES-256-GCM keys via HKDF-SHA256 bound to the
//! handshake `(challenge, client_nonce)`. Every frame uses a monotonic 64-bit counter nonce
//! with a direction byte, preventing replay, reflection, and nonce reuse.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Write};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

const C2S_LABEL: &[u8] = b"shellbeam-companion-c2s-v1";
const S2C_LABEL: &[u8] = b"shellbeam-companion-s2c-v1";
const DIR_CLIENT_TO_SERVER: u8 = 0x01;
const DIR_SERVER_TO_CLIENT: u8 = 0x02;

pub const MAX_BRIDGE_FRAME_BYTES: u64 = 4 * 1024 * 1024;
pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Client,
    Server,
}

pub struct DirectionalCipher {
    cipher: Aes256Gcm,
    direction: u8,
    next_seq: u64,
}

impl DirectionalCipher {
    fn new(key: &[u8; 32], direction: u8) -> Self {
        let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte AES-256 key");
        Self {
            cipher,
            direction,
            next_seq: 0,
        }
    }

    fn nonce_for(&self, seq: u64) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        nonce[0] = self.direction;
        nonce[4..12].copy_from_slice(&seq.to_be_bytes());
        nonce
    }

    pub fn encrypt_frame(&mut self, frame: &BridgeFrame) -> Result<String, String> {
        let seq = self.next_seq;
        self.next_seq = self
            .next_seq
            .checked_add(1)
            .ok_or_else(|| "Bridge sequence overflow".to_string())?;
        let plaintext = serde_json::to_vec(frame).map_err(|e| format!("encode frame: {e}"))?;
        let nonce_bytes = self.nonce_for(seq);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_slice())
            .map_err(|e| format!("encrypt frame: {e}"))?;
        let mut wire = Vec::with_capacity(8 + ciphertext.len());
        wire.extend_from_slice(&seq.to_be_bytes());
        wire.extend_from_slice(&ciphertext);
        Ok(B64.encode(wire))
    }

    pub fn decrypt_frame(&mut self, encoded: &str) -> Result<BridgeFrame, String> {
        let raw = B64
            .decode(encoded.trim())
            .map_err(|e| format!("decode frame: {e}"))?;
        if raw.len() < 8 + 16 {
            return Err("Frame too short".to_string());
        }
        let seq = u64::from_be_bytes(raw[..8].try_into().unwrap());
        if seq != self.next_seq {
            return Err(format!(
                "Unexpected frame sequence: expected {}, got {}",
                self.next_seq, seq
            ));
        }
        let nonce_bytes = self.nonce_for(seq);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), &raw[8..])
            .map_err(|_| "Frame authentication failed".to_string())?;
        self.next_seq = self
            .next_seq
            .checked_add(1)
            .ok_or_else(|| "Bridge sequence overflow".to_string())?;
        serde_json::from_slice(&plaintext).map_err(|e| format!("parse frame: {e}"))
    }
}

pub struct BridgeCiphers {
    pub tx: DirectionalCipher,
    pub rx: DirectionalCipher,
}

/// Derive directional session ciphers for client and server from a paired `sync_key` and
/// fresh handshake values `(challenge, client_nonce)`.
pub fn derive_session_ciphers(
    sync_key: &[u8; 32],
    challenge: &str,
    client_nonce: &str,
    role: Role,
) -> Result<BridgeCiphers, String> {
    let mut salt_hash = Sha256::new();
    salt_hash.update(b"shellbeam-companion-salt-v1");
    salt_hash.update((challenge.len() as u64).to_be_bytes());
    salt_hash.update(challenge.as_bytes());
    salt_hash.update((client_nonce.len() as u64).to_be_bytes());
    salt_hash.update(client_nonce.as_bytes());
    let salt = salt_hash.finalize();

    let hkdf = Hkdf::<Sha256>::new(Some(&salt), sync_key);
    let mut c2s = [0u8; 32];
    let mut s2c = [0u8; 32];
    hkdf.expand(C2S_LABEL, &mut c2s)
        .map_err(|e| format!("hkdf c2s: {e}"))?;
    hkdf.expand(S2C_LABEL, &mut s2c)
        .map_err(|e| format!("hkdf s2c: {e}"))?;

    match role {
        Role::Client => Ok(BridgeCiphers {
            tx: DirectionalCipher::new(&c2s, DIR_CLIENT_TO_SERVER),
            rx: DirectionalCipher::new(&s2c, DIR_SERVER_TO_CLIENT),
        }),
        Role::Server => Ok(BridgeCiphers {
            tx: DirectionalCipher::new(&s2c, DIR_SERVER_TO_CLIENT),
            rx: DirectionalCipher::new(&c2s, DIR_CLIENT_TO_SERVER),
        }),
    }
}

pub fn write_encrypted_frame<W: Write>(
    writer: &mut W,
    cipher: &mut DirectionalCipher,
    frame: &BridgeFrame,
) -> Result<(), String> {
    let encoded = cipher.encrypt_frame(frame)?;
    writeln!(writer, "{encoded}").map_err(|e| format!("write frame: {e}"))?;
    writer.flush().map_err(|e| format!("flush frame: {e}"))
}

pub fn read_encrypted_frame<R: BufRead>(
    reader: &mut R,
    cipher: &mut DirectionalCipher,
) -> Result<BridgeFrame, String> {
    let mut line = String::new();
    let n = reader
        .by_ref()
        .take(MAX_BRIDGE_FRAME_BYTES)
        .read_line(&mut line)
        .map_err(|e| format!("read frame: {e}"))?;
    if n == 0 {
        return Err("Connection closed".to_string());
    }
    if !line.ends_with('\n') && line.len() as u64 >= MAX_BRIDGE_FRAME_BYTES {
        return Err("Frame exceeds size limit".to_string());
    }
    cipher.decrypt_frame(&line)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBackendInfo {
    pub backend: String,
    pub available: bool,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeFrame {
    Hello {
        protocol_version: u32,
        device_id: String,
        device_name: String,
        os: String,
        app_version: String,
        permissions: crate::sync::PeerBridgePermissions,
        cli_backends: Vec<CliBackendInfo>,
        #[serde(default)]
        endpoints: Vec<crate::sync::PeerRoute>,
    },
    Ping {
        ts: i64,
    },
    Pong {
        ts: i64,
    },
    Req {
        id: String,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    Res {
        id: String,
        ok: bool,
        #[serde(default)]
        data: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
    },
    Event {
        topic: String,
        payload: serde_json::Value,
    },
    Cancel {
        id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [42u8; 32];

    #[test]
    fn directional_ciphers_roundtrip_and_reject_replay_or_reflection() {
        let mut client = derive_session_ciphers(&KEY, "ch-1", "cn-1", Role::Client).unwrap();
        let mut server = derive_session_ciphers(&KEY, "ch-1", "cn-1", Role::Server).unwrap();

        let frame1 = BridgeFrame::Ping { ts: 1234 };
        let frame2 = BridgeFrame::Pong { ts: 5678 };

        let wire_c2s = client.tx.encrypt_frame(&frame1).unwrap();
        // Reflection back to client fails (wrong direction & key).
        assert!(client.rx.decrypt_frame(&wire_c2s).is_err());

        // Server decrypts cleanly.
        let decoded = server.rx.decrypt_frame(&wire_c2s).unwrap();
        assert!(matches!(decoded, BridgeFrame::Ping { ts: 1234 }));

        // Replaying the exact same frame is rejected by monotonic sequence check.
        assert!(server.rx.decrypt_frame(&wire_c2s).is_err());

        // Server -> Client direction works independently.
        let wire_s2c = server.tx.encrypt_frame(&frame2).unwrap();
        let decoded2 = client.rx.decrypt_frame(&wire_s2c).unwrap();
        assert!(matches!(decoded2, BridgeFrame::Pong { ts: 5678 }));
    }

    #[test]
    fn mismatched_handshake_context_cannot_decrypt() {
        let mut client = derive_session_ciphers(&KEY, "ch-1", "cn-1", Role::Client).unwrap();
        let mut wrong_server = derive_session_ciphers(&KEY, "ch-2", "cn-1", Role::Server).unwrap();
        let wire = client
            .tx
            .encrypt_frame(&BridgeFrame::Ping { ts: 1 })
            .unwrap();
        assert!(wrong_server.rx.decrypt_frame(&wire).is_err());
    }
}
