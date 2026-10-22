//! App-bundled extension only. No arbitrary URL, filesystem path, plugin name,
//! or permission declaration can be supplied over IPC.
use super::monitoring_service::Remote;
use serde_json::{json, Value};
use std::io::Read;

const SHORT: &str = "shellbeam-alerts";
const PACKAGE: &[u8] = include_bytes!("../../resources/monitoring-extension.zip");
const FILES: &[(&str, &[u8])] = &[
    (
        "komari-plugin.json",
        include_bytes!("../../../monitoring-extension/komari-plugin.json"),
    ),
    (
        "policy.cjs",
        include_bytes!("../../../monitoring-extension/policy.cjs"),
    ),
    (
        "server.cjs",
        include_bytes!("../../../monitoring-extension/server.cjs"),
    ),
];
impl Remote<'_> {
    fn extension_version(&self, token: &str) -> Result<(), String> {
        let version = self.call("/api/version", None, Some(token), None)?;
        if version["version"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches('v')
            != "1.6.0"
        {
            return Err("MONITORING_UNSUPPORTED".into());
        }
        Ok(())
    }
    pub(super) fn require_extension(&self, token: &str) -> Result<(), String> {
        if self.extension_status(token)?["enabled"] != true {
            return Err("MONITORING_EXTENSION_REQUIRED".into());
        }
        Ok(())
    }

    fn extension_exists(&self, token: &str) -> Result<Option<Value>, String> {
        let list = self.call("/api/admin/plugin/list", None, Some(token), None)?;
        Ok(list
            .as_array()
            .ok_or("MONITORING_INVALID_RESPONSE")?
            .iter()
            .find(|v| v["short"] == SHORT)
            .cloned())
    }
    fn verify_extension(&self, token: &str) -> Result<(), String> {
        for (name, expected) in FILES {
            super::monitoring_service::check(self.app, self.scope)?;
            let response = self
                .client
                .get(format!("{}/api/admin/plugin/{SHORT}/{name}", self.endpoint))
                .bearer_auth(token)
                .send()
                .map_err(|_| "MONITORING_NETWORK")?;
            if response.status().as_u16() != 200 {
                return Err("MONITORING_EXTENSION_MISMATCH".into());
            }
            let mut bytes = Vec::new();
            response
                .take(expected.len() as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "MONITORING_NETWORK")?;
            super::monitoring_service::check(self.app, self.scope)?;
            if bytes != *expected {
                return Err("MONITORING_EXTENSION_MISMATCH".into());
            }
        }
        Ok(())
    }
    pub(super) fn extension_status(&self, token: &str) -> Result<Value, String> {
        self.extension_version(token)?;
        if let Some(info) = self.extension_exists(token)? {
            self.verify_extension(token)?;
            Ok(
                json!({"installed":true,"enabled":info["enabled"] == true && info["running"] == true}),
            )
        } else {
            Ok(json!({"installed":false,"enabled":false}))
        }
    }
    pub(super) fn enable_extension(&self, token: &str) -> Result<(), String> {
        self.extension_version(token)?;
        if self.extension_exists(token)?.is_none() {
            let upload = self.call("/api/admin/upload/init", Some(&json!({"purpose":"plugin","filename":"shellbeam-alerts.zip","size":PACKAGE.len()})), Some(token), None)?;
            let upload_id = upload["upload_id"]
                .as_str()
                .filter(|v| {
                    v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
                .ok_or("MONITORING_INVALID_RESPONSE")?;
            let result = (|| {
                let boundary = "shellbeam-monitoring-extension-archive";
                let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"upload_id\"\r\n\r\n{upload_id}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"chunk_index\"\r\n\r\n0\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"chunk_data\"; filename=\"shellbeam-alerts.zip\"\r\nContent-Type: application/zip\r\n\r\n").into_bytes();
                body.extend_from_slice(PACKAGE);
                body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
                super::monitoring_service::check(self.app, self.scope)?;
                let response = self
                    .client
                    .post(format!("{}/api/admin/upload/chunk", self.endpoint))
                    .bearer_auth(token)
                    .header(
                        "Content-Type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(body)
                    .send()
                    .map_err(|_| "MONITORING_NETWORK")?;
                if response.status().as_u16() != 200 {
                    return Err("MONITORING_REQUEST_FAILED".to_string());
                }
                // Refuse a concurrent installation before merging. Never upgrade or
                // replace an existing extension, even one with the same short name.
                if self.extension_exists(token)?.is_some() {
                    return Err("MONITORING_CONFLICT".into());
                }
                self.call(
                    "/api/admin/upload/merge",
                    Some(&json!({"upload_id":upload_id})),
                    Some(token),
                    None,
                )?;
                Ok(())
            })();
            if result.is_err() {
                let _ = self.call(
                    "/api/admin/upload/cancel",
                    Some(&json!({"upload_id":upload_id})),
                    Some(token),
                    None,
                );
            }
            result?;
        }
        self.verify_extension(token)?;
        self.call(
            "/api/admin/plugin/enabled",
            Some(&json!({"short":SHORT,"enabled":true,"approved":true})),
            Some(token),
            None,
        )?;
        Ok(())
    }
}
