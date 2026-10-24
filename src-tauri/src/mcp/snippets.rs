use super::policy::{self, Client, SnippetGrant};
use crate::data::snippets::{load_snippets, SnippetEntry};
use serde_json::{json, Value};

pub fn revision(snippet: &SnippetEntry) -> String {
    policy::digest(snippet.command.as_bytes())
}

pub fn validate_grants(rows: &[SnippetEntry], grants: &[SnippetGrant]) -> Result<(), String> {
    if grants.len() > 100 {
        return Err("SNIPPET_GRANT_LIMIT".into());
    }
    let mut ids = std::collections::HashSet::new();
    for grant in grants {
        if !ids.insert(&grant.id) {
            return Err("DUPLICATE_SNIPPET_GRANT".into());
        }
        checked(rows, grants, &grant.id, &grant.revision)?;
    }
    Ok(())
}

fn checked<'a>(
    rows: &'a [SnippetEntry],
    grants: &[SnippetGrant],
    id: &str,
    expected: &str,
) -> Result<&'a SnippetEntry, String> {
    let grant = grants
        .iter()
        .find(|g| g.id == id)
        .ok_or("SNIPPET_NOT_AUTHORIZED")?;
    let row = rows
        .iter()
        .find(|r| r.id == id)
        .ok_or("SNIPPET_NOT_FOUND")?;
    if grant.revision != expected || revision(row) != expected {
        return Err("SNIPPET_CHANGED: review and re-authorize its content in ShellBeam".into());
    }
    if row.command.trim().is_empty() || row.command.len() > 32768 || row.command.contains('\0') {
        return Err("SNIPPET_COMMAND_INVALID".into());
    }
    Ok(row)
}

pub fn command(app: &tauri::AppHandle, client: &Client, args: &Value) -> Result<String, String> {
    let rows = load_snippets(app, Some(&client.vault_id))?;
    Ok(checked(
        &rows,
        &client.snippets,
        args["snippetId"].as_str().ok_or("SNIPPET_ID_REQUIRED")?,
        args["revision"]
            .as_str()
            .ok_or("SNIPPET_REVISION_REQUIRED")?,
    )?
    .command
    .clone())
}

pub fn query(
    app: &tauri::AppHandle,
    client: &Client,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    let rows = load_snippets(app, Some(&client.vault_id))?;
    if tool == "get_snippet" {
        let id = args["snippetId"].as_str().ok_or("SNIPPET_ID_REQUIRED")?;
        let grant = client
            .snippets
            .iter()
            .find(|g| g.id == id)
            .ok_or("SNIPPET_NOT_AUTHORIZED")?;
        let row = checked(&rows, &client.snippets, id, &grant.revision)?;
        return Ok(
            json!({"snippetId":row.id,"name":row.name,"command":row.command,"tags":row.tags,"revision":revision(row),"untrustedContent":true}),
        );
    }
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let tag = args["tag"].as_str();
    let entries: Vec<_> = rows.iter().filter_map(|row| {
        let grant = client.snippets.iter().find(|g| g.id == row.id)?;
        if (!row.name.to_lowercase().contains(&query) && !row.tags.iter().any(|t| t.to_lowercase().contains(&query)))
            || tag.is_some_and(|tag| !row.tags.iter().any(|t| t == tag)) { return None; }
        Some(json!({"snippetId":row.id,"name":row.name,"tags":row.tags,"revision":grant.revision,"contentUnchanged":revision(row)==grant.revision,"updatedAt":row.updated_at}))
    }).collect();
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
    Ok(
        json!({"snippets":entries.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":entries.len(),"nextOffset":(offset+limit<entries.len()).then_some(offset+limit),"untrustedContent":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_pin_content_not_usage_timestamps_and_do_not_expand() {
        let mut row = SnippetEntry {
            id: "s".into(),
            name: "Inspect".into(),
            command: "uptime".into(),
            tags: vec![],
            created_at: 1,
            updated_at: 1,
            last_used_at: None,
        };
        let grants = vec![SnippetGrant {
            id: row.id.clone(),
            revision: revision(&row),
        }];
        assert!(validate_grants(&[row.clone()], &grants).is_ok());
        row.updated_at = 3;
        row.last_used_at = Some(3);
        assert!(checked(&[row.clone()], &grants, "s", &grants[0].revision).is_ok());
        assert!(checked(&[row.clone()], &grants, "other", &grants[0].revision).is_err());
        row.command = "rm -rf /tmp/example".into();
        assert!(validate_grants(&[row.clone()], &grants).is_err());
        assert!(checked(&[row.clone()], &grants, "s", &revision(&row)).is_err());
        assert!(validate_grants(&[], &grants).is_err());
    }
}
