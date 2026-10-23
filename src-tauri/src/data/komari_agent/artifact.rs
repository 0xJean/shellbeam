use crate::storage::{data_file_path, write_json};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default = "custom_source")]
    pub source: String,
    pub enabled: bool,
    pub manifest_url: String,
    pub trusted_public_key: String,
    pub allowed_hosts: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub runtime: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: usize,
    pub signature: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRelease {
    pub manifest: Manifest,
    pub public_key: String,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    Ok(hash(
        &serde_json::to_vec(value).map_err(|_| "KOMARI_AGENT_INVALID_STATE")?,
    ))
}
fn allowed(url: &str, hosts: &[String]) -> bool {
    url::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
            && u.query().is_none()
            && hosts.iter().any(|h| Some(h.as_str()) == u.host_str())
    })
}
pub fn version(value: &str) -> Result<u64, String> {
    value
        .strip_prefix("1.5.")
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| "KOMARI_AGENT_VERSION_UNSUPPORTED".into())
}
pub fn canonical(manifest: &Manifest) -> Vec<u8> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Signed<'a> {
        runtime: &'a str,
        version: &'a str,
        platform: &'a str,
        architecture: &'a str,
        url: &'a str,
        sha256: &'a str,
        size_bytes: usize,
    }
    let value = Signed {
        runtime: &manifest.runtime,
        version: &manifest.version,
        platform: &manifest.platform,
        architecture: &manifest.architecture,
        url: &manifest.url,
        sha256: &manifest.sha256,
        size_bytes: manifest.size_bytes,
    };
    let mut bytes = b"shellbeam/komari-agent/v1\n".to_vec();
    bytes.extend(serde_json::to_vec(&value).expect("serializable manifest"));
    bytes
}
pub fn verify(release: &TrustedRelease) -> Result<(), String> {
    let m = &release.manifest;
    version(&m.version)?;
    if m.runtime != "komari"
        || m.platform != "linux"
        || !matches!(m.architecture.as_str(), "amd64" | "arm64")
        || m.sha256.len() != 64
        || !m
            .sha256
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || m.size_bytes == 0
        || m.size_bytes > 32 * 1024 * 1024
    {
        return Err("KOMARI_AGENT_ARTIFACT_INVALID".into());
    }
    let key: [u8; 32] = STANDARD
        .decode(&release.public_key)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?
        .try_into()
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?;
    let signature = Signature::from_slice(
        &STANDARD
            .decode(&m.signature)
            .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?,
    )
    .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID")?
        .verify_strict(&canonical(m), &signature)
        .map_err(|_| "KOMARI_AGENT_SIGNATURE_INVALID".into())
}
// New deployments are an own-product boundary, separate from the historical
// signature format. Keep generic verify() unchanged for retained rollback.
pub fn require_shellbeam(release: &TrustedRelease) -> Result<(), String> {
    verify(release)?;
    if release.public_key != super::official::trust().public_key {
        return Err("KOMARI_AGENT_SHELLBEAM_REQUIRED".into());
    }
    let pins: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../releases/compatible-probe-pins.json"
    ))
    .map_err(|_| "KOMARI_AGENT_SHELLBEAM_REQUIRED")?;
    let row = &pins["versions"][&release.manifest.version];
    let source = &row["source"];
    if source["repository"] != "0xJean/shellbeam-monitoring-agent"
        || source["commit"]
            .as_str()
            .is_none_or(|v| v.len() != 40 || !v.bytes().all(|c| c.is_ascii_hexdigit()))
        || !matches_pin(&row[&release.manifest.architecture], &release.manifest)
    {
        return Err("KOMARI_AGENT_SHELLBEAM_REQUIRED".into());
    }
    Ok(())
}
fn matches_pin(pin: &serde_json::Value, m: &Manifest) -> bool {
    pin["sha256"].as_str() == Some(m.sha256.as_str())
        && pin["size"].as_u64() == Some(m.size_bytes as u64)
}
// Adoption may preserve the exact already-running reviewed legacy binary to
// establish a reversible migration checkpoint. It is never a fresh install,
// upgrade or transfer exemption, and still requires its original signature.
pub fn require_deployment(
    release: &TrustedRelease,
    adopted: Option<&super::Legacy>,
) -> Result<(), String> {
    verify(release)?;
    if require_shellbeam(release).is_ok() {
        return Ok(());
    }
    let m = &release.manifest;
    if let Some(old) = adopted {
        let pins: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../releases/compatible-probe-pins.json"
        ))
        .map_err(|_| "KOMARI_AGENT_SHELLBEAM_REQUIRED")?;
        if release.public_key == super::official::trust().public_key
            && matches!(m.version.as_str(), "1.5.10" | "1.5.11")
            && old.version == m.version
            && old.sha256 == m.sha256
            && old.size_bytes == m.size_bytes
            && matches_pin(&pins["versions"][&m.version][&m.architecture], m)
        {
            return Ok(());
        }
    }
    Err("KOMARI_AGENT_SHELLBEAM_REQUIRED".into())
}
fn custom_source() -> String {
    "custom".into()
}
impl Default for Policy {
    fn default() -> Self {
        let trust = super::official::trust();
        Self {
            source: "official".into(),
            enabled: true,
            manifest_url: trust.catalog_url,
            trusted_public_key: trust.public_key,
            allowed_hosts: trust.allowed_hosts,
        }
    }
}
fn normalize(value: Policy) -> Result<Policy, String> {
    match value.source.as_str() {
        "official" => Ok(Policy {
            enabled: value.enabled,
            ..Policy::default()
        }),
        "custom" => Ok(value),
        _ => Err("KOMARI_AGENT_POLICY_INVALID".into()),
    }
}
pub(super) fn read_policy(path: &std::path::Path) -> Result<Policy, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            normalize(serde_json::from_slice(&bytes).map_err(|_| "KOMARI_AGENT_POLICY_INVALID")?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Policy::default()),
        Err(_) => Err("KOMARI_AGENT_POLICY_INVALID".into()),
    }
}
pub fn policy(app: &tauri::AppHandle) -> Result<Policy, String> {
    read_policy(&data_file_path(app, "komari_agent_release_policy.json")?)
}
#[tauri::command]
pub fn komari_agent_release_policy(
    app: tauri::AppHandle,
    value: Option<Policy>,
    confirmed: Option<bool>,
) -> Result<Policy, String> {
    if let Some(value) = value {
        if confirmed != Some(true) {
            return Err("KOMARI_AGENT_CONFIRMATION_REQUIRED".into());
        }
        let value = normalize(value)?;
        if value.enabled
            && (!allowed(&value.manifest_url, &value.allowed_hosts)
                || value.allowed_hosts.is_empty()
                || value.allowed_hosts.len() > 16
                || STANDARD
                    .decode(&value.trusted_public_key)
                    .map_or(true, |v| v.len() != 32))
        {
            return Err("KOMARI_AGENT_POLICY_INVALID".into());
        }
        write_json(
            &data_file_path(&app, "komari_agent_release_policy.json")?,
            &value,
        )?;
        return Ok(value);
    }
    policy(&app)
}
pub fn select(
    app: &tauri::AppHandle,
    policy: &Policy,
    arch: &str,
) -> Result<TrustedRelease, String> {
    if !policy.enabled || !allowed(&policy.manifest_url, &policy.allowed_hosts) {
        return Err("KOMARI_AGENT_RELEASE_NOT_CONFIGURED".into());
    }
    let result =
        crate::agent_release::download(&policy.manifest_url, &policy.allowed_hosts, 65536)?;
    let bytes = STANDARD
        .decode(result.bytes_b64)
        .map_err(|_| "KOMARI_AGENT_CATALOG_INVALID")?;
    if policy.source == "official" {
        let catalog = super::official::verify_catalog(
            &bytes,
            &super::official::trust(),
            crate::storage::now_unix_ms(),
        )?;
        super::official::remember(
            &data_file_path(app, "komari_agent_catalog.sqlite3")?,
            &catalog,
        )?;
        return catalog
            .artifacts
            .into_iter()
            .find(|m| m.architecture == arch)
            .map(|manifest| TrustedRelease {
                manifest,
                public_key: policy.trusted_public_key.clone(),
            })
            .ok_or_else(|| "KOMARI_AGENT_ARCHITECTURE_UNSUPPORTED".into());
    }
    #[derive(Deserialize)]
    struct Catalog {
        artifacts: Vec<Manifest>,
    }
    let catalog: Catalog =
        serde_json::from_slice(&bytes).map_err(|_| "KOMARI_AGENT_CATALOG_INVALID")?;
    if catalog.artifacts.len() > 32 {
        return Err("KOMARI_AGENT_CATALOG_INVALID".into());
    }
    let mut candidates = Vec::new();
    for manifest in catalog
        .artifacts
        .into_iter()
        .filter(|m| m.architecture == arch)
    {
        if !allowed(&manifest.url, &policy.allowed_hosts) {
            return Err("KOMARI_AGENT_ARTIFACT_URL".into());
        }
        let release = TrustedRelease {
            manifest,
            public_key: policy.trusted_public_key.clone(),
        };
        verify(&release)?;
        candidates.push(release);
    }
    candidates.sort_by_key(|r| version(&r.manifest.version).unwrap_or(0));
    candidates
        .pop()
        .ok_or_else(|| "KOMARI_AGENT_ARCHITECTURE_UNSUPPORTED".into())
}
pub fn download(release: &TrustedRelease, policy: &Policy) -> Result<String, String> {
    verify(release)?;
    if !allowed(&release.manifest.url, &policy.allowed_hosts)
        || release.public_key != policy.trusted_public_key
    {
        return Err("KOMARI_AGENT_POLICY_CHANGED".into());
    }
    let value = crate::agent_release::download(
        &release.manifest.url,
        &policy.allowed_hosts,
        release.manifest.size_bytes,
    )?;
    let bytes = STANDARD
        .decode(&value.bytes_b64)
        .map_err(|_| "KOMARI_AGENT_ARTIFACT_INVALID")?;
    verify_bytes(release, &bytes)?;
    Ok(value.bytes_b64)
}
pub fn verify_bytes(release: &TrustedRelease, bytes: &[u8]) -> Result<(), String> {
    verify(release)?;
    if bytes.len() != release.manifest.size_bytes || hash(bytes) != release.manifest.sha256 {
        return Err("KOMARI_AGENT_HASH_MISMATCH".into());
    }
    Ok(())
}
