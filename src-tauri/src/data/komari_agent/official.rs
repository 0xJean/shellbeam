//! The application, never a downloaded catalog, supplies the production root.
use super::artifact::{self, Manifest, TrustedRelease};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trust {
    pub key_id: String,
    pub public_key: String,
    pub catalog_url: String,
    pub allowed_hosts: Vec<String>,
    pub minimum_sequence: i64,
}
pub fn trust() -> Trust {
    serde_json::from_str(include_str!("official-trust.json"))
        .expect("compiled public release trust")
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub key_id: String,
    pub channel: String,
    pub sequence: i64,
    pub published_at: i64,
    pub expires_at: i64,
    pub artifacts: Vec<Manifest>,
    pub signature: String,
}
pub fn canonical(c: &Catalog) -> Vec<u8> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        schema_version: u32,
        key_id: &'a str,
        channel: &'a str,
        sequence: i64,
        published_at: i64,
        expires_at: i64,
        artifacts: &'a [Manifest],
    }
    let mut bytes = b"shellbeam/komari-agent-catalog/v1\n".to_vec();
    bytes.extend(
        serde_json::to_vec(&Payload {
            schema_version: c.schema_version,
            key_id: &c.key_id,
            channel: &c.channel,
            sequence: c.sequence,
            published_at: c.published_at,
            expires_at: c.expires_at,
            artifacts: &c.artifacts,
        })
        .expect("catalog payload"),
    );
    bytes
}
pub fn verify_catalog(bytes: &[u8], root: &Trust, now: i64) -> Result<Catalog, String> {
    if bytes.len() > 65536 {
        return Err("KOMARI_AGENT_CATALOG_INVALID".into());
    }
    let c: Catalog = serde_json::from_slice(bytes).map_err(|_| "KOMARI_AGENT_CATALOG_INVALID")?;
    if c.schema_version != 1
        || c.key_id != root.key_id
        || c.channel != "stable"
        || c.sequence < root.minimum_sequence
        || c.sequence > 9_007_199_254_740_991
        || c.published_at <= 0
        || c.published_at > now + 300_000
        || c.expires_at <= c.published_at
        || c.expires_at - c.published_at > 180 * 86_400_000
    {
        return Err("KOMARI_AGENT_CATALOG_INVALID".into());
    }
    let key: [u8; 32] = STANDARD
        .decode(&root.public_key)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?
        .try_into()
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?;
    let signature = Signature::from_slice(
        &STANDARD
            .decode(&c.signature)
            .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?,
    )
    .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?
        .verify_strict(&canonical(&c), &signature)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?;
    if c.expires_at <= now {
        return Err("KOMARI_AGENT_CATALOG_EXPIRED".into());
    }
    if c.artifacts.len() != 2
        || c.artifacts[0].architecture != "amd64"
        || c.artifacts[1].architecture != "arm64"
        || c.artifacts[0].version != c.artifacts[1].version
    {
        return Err("KOMARI_AGENT_CATALOG_INVALID".into());
    }
    for m in &c.artifacts {
        artifact::verify(&TrustedRelease {
            manifest: m.clone(),
            public_key: root.public_key.clone(),
        })?;
        // A valid publisher signature cannot silently redirect the built-in
        // source to another repository, a moving tag or an arbitrary service.
        let prefix = format!(
            "https://github.com/0xJean/shellbeam/releases/download/monitoring-probe-v{}-r",
            m.version
        );
        let tail = m
            .url
            .strip_prefix(&prefix)
            .ok_or("KOMARI_AGENT_ARTIFACT_URL")?;
        let (revision, file) = tail.split_once('/').ok_or("KOMARI_AGENT_ARTIFACT_URL")?;
        if revision.is_empty()
            || !revision.bytes().all(|b| b.is_ascii_digit())
            || file != format!("komari-agent-linux-{}", m.architecture)
        {
            return Err("KOMARI_AGENT_ARTIFACT_URL".into());
        }
    }
    Ok(c)
}
pub fn remember(path: &std::path::Path, c: &Catalog) -> Result<(), String> {
    let mut db = Connection::open(path).map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS release_watermark(key_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL)").map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    let saved: Option<(i64, String, u64)> = tx
        .query_row(
            "SELECT sequence,digest,version FROM release_watermark WHERE key_id=?1",
            [&c.key_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    let digest = artifact::hash(&canonical(c));
    let version = artifact::version(&c.artifacts[0].version)?;
    if saved.is_some_and(|(sequence, hash, prior_version)| {
        c.sequence < sequence
            || version < prior_version
            || (c.sequence == sequence && digest != hash)
    }) {
        return Err("KOMARI_AGENT_CATALOG_ROLLBACK".into());
    }
    tx.execute("INSERT INTO release_watermark(key_id,sequence,digest,version) VALUES(?1,?2,?3,?4) ON CONFLICT(key_id) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest,version=excluded.version", params![c.key_id,c.sequence,digest,version]).map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE")?;
    tx.commit()
        .map_err(|_| "KOMARI_AGENT_CATALOG_STORAGE".into())
}
