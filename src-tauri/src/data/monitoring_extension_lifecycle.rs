//! Persistence/authorization adapter for the fixed-package lifecycle engine.
use super::*;
use crate::data::monitoring_extension as ext;

pub(super) fn validate(edit: &Edit) -> Result<(), String> {
    let cp = edit.extension.as_ref().ok_or("MONITORING_INVALID_EDIT")?;
    if !matches!(cp.operation.as_str(), "upgrade" | "uninstall" | "restore")
        || cp.baseline != edit.baseline
    {
        return Err("MONITORING_INVALID_EDIT".into());
    }
    if let Some(b) = &cp.backup {
        ext::validate_state(&b.state)?;
    }
    Ok(())
}
pub(super) fn prepare_request(
    app: &tauri::AppHandle,
    input: &Request,
    remote: &Remote,
    token: &str,
) -> Result<Value, String> {
    let scope = &input.scope;
    let cp = if input.action == "extension-restore" {
        let mut row = load(&db(app)?, &input.id, scope)?;
        if input.revision != Some(row.revision)
            || row.scope.config_version != scope.config_version
            || row.scope.configuration_identity != scope.configuration_identity
        {
            return Err("MONITORING_STALE_EDIT".into());
        }
        let edit = decode(app, &row)?;
        let cp = ext::restore(
            edit.extension
                .as_ref()
                .ok_or("MONITORING_BACKUP_REQUIRED")?,
        )?;
        if !matches!(row.status.as_str(), "verified" | "cancelled") {
            finish(app, scope, &mut row, &edit, "cancelled", None)?;
        }
        cp
    } else {
        ext::prepare(&ext::Connection { remote, token }, &input.target)?
    };
    new_intent(app, scope, cp)
}
fn new_intent(app: &tauri::AppHandle, scope: &Scope, cp: ext::Checkpoint) -> Result<Value, String> {
    prepare(
        app,
        scope,
        "extension-lifecycle",
        Edit {
            baseline: cp.baseline.clone(),
            desired: json!({"operation":cp.operation}),
            observed: cp.baseline.clone(),
            extension: Some(cp),
        },
    )
}
fn checkpoint(
    app: &tauri::AppHandle,
    scope: &Scope,
    row: &mut Intent,
    edit: &mut Edit,
    cp: &ext::Checkpoint,
) -> Result<(), String> {
    edit.extension = Some(cp.clone());
    let sealed = seal(app, scope, edit)?;
    transaction(app, scope, |conn| {
        let latest = load(conn, &row.id, scope)?;
        if latest.revision != row.revision {
            return Err("MONITORING_STALE_EDIT".into());
        }
        row.status = "applying".into();
        row.revision += 1;
        row.updated_at = now_unix_ms();
        row.sealed = sealed;
        job_status(
            conn,
            &row.job_id,
            "running",
            match cp.stage.as_str() {
                "backed-up" => {
                    "Stopped extension state encrypted and durably retained before mutation"
                }
                "delete-dispatched" => {
                    "Authorized extension removal dispatched; encrypted recovery backup retained"
                }
                "replace-dispatched" => {
                    "Fixed reviewed package replacement dispatched; original backup retained"
                }
                "configuration-dispatched" => "Restoring preserved extension configuration",
                _ => "Authorized extension lifecycle step dispatched; readback required",
            },
        )?;
        store(conn, row)
    })
}
pub(super) fn act(
    app: &tauri::AppHandle,
    input: &Request,
    remote: &Remote,
    token: &str,
    mut row: Intent,
    mut edit: Edit,
) -> Result<Value, String> {
    let scope = &input.scope;
    let io = ext::Connection { remote, token };
    let mut cp = edit.extension.clone().ok_or("MONITORING_INVALID_EDIT")?;
    let observed = ext::inspect(&io);
    if let Ok(value) = observed {
        edit.observed = value;
        row.observed_at = now_unix_ms();
    }
    if ext::verified(&io, &cp).unwrap_or(false) {
        finish(app, scope, &mut row, &edit, "verified", None)?;
        return Ok(view(&row, &edit));
    }
    if input.action == "retry" {
        // A separate confirmed job is created; neither reads nor application
        // restart can resume this state machine. Preserve the original backup.
        finish(app, scope, &mut row, &edit, "cancelled", None)?;
        return new_intent(app, scope, cp);
    }
    if input.action != "apply" || row.status != "prepared" {
        let status = if ext::inspect(&io).is_ok() {
            "retry"
        } else {
            "uncertain"
        };
        finish(
            app,
            scope,
            &mut row,
            &edit,
            status,
            Some("MONITORING_READBACK_REQUIRED"),
        )?;
        return Ok(view(&row, &edit));
    }
    let result = ext::apply(&io, &mut cp, |next| {
        checkpoint(app, scope, &mut row, &mut edit, next)
    });
    // The in-memory backup may only be used after its encrypted checkpoint was
    // committed. Reload the durable edit if any checkpoint/write failed.
    let saved = load(&db(app)?, &row.id, scope)?;
    edit = decode(app, &saved)?;
    row = saved;
    let durable = edit.extension.as_ref().ok_or("MONITORING_INVALID_EDIT")?;
    let verified = ext::verified(&io, durable).unwrap_or(false);
    if let Ok(value) = ext::inspect(&io) {
        edit.observed = value;
        row.observed_at = now_unix_ms();
    }
    finish(
        app,
        scope,
        &mut row,
        &edit,
        if verified { "verified" } else { "uncertain" },
        if verified {
            None
        } else {
            Some(
                result
                    .as_ref()
                    .err()
                    .map(String::as_str)
                    .unwrap_or("MONITORING_READBACK_REQUIRED"),
            )
        },
    )?;
    Ok(view(&row, &edit))
}
