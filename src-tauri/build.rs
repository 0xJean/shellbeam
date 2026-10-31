use std::{collections::BTreeSet, fs};

/// Command names registered in `generate_handler!`, in the form the ACL expects.
fn handler_commands() -> Vec<String> {
    let source = fs::read_to_string("src/lib.rs").expect("read src/lib.rs");
    let start = source
        .find("generate_handler![")
        .expect("generate_handler! not found in src/lib.rs");
    let body = &source[start + "generate_handler![".len()..];
    let body = &body[..body.find("])").expect("unterminated generate_handler!")];
    body.lines()
        .map(|line| line.split("//").next().unwrap_or_default())
        .flat_map(|line| line.split(','))
        .filter_map(|path| path.trim().rsplit("::").next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// Commands granted by the permission set in `permissions/app-commands.toml`.
fn permitted_commands() -> BTreeSet<String> {
    fs::read_to_string("permissions/app-commands.toml")
        .expect("read permissions/app-commands.toml")
        .lines()
        .filter_map(|line| line.trim().strip_prefix("\"allow-"))
        .filter_map(|line| line.split('"').next())
        .map(|name| name.replace('-', "_"))
        .collect()
}

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=permissions/app-commands.toml");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Keep the existing 10.13 minimum: UserNotifications is a 10.14+ optional
        // backend, guarded by a runtime Objective-C class check before use.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,UserNotifications");
    }

    // Declaring the manifest is what makes Tauri enforce the ACL on app commands.
    // Without it, any page in any webview can invoke them.
    let commands = handler_commands();
    let registered: BTreeSet<String> = commands.iter().cloned().collect();
    let permitted = permitted_commands();
    if registered != permitted {
        panic!(
            "permissions/app-commands.toml is out of sync with generate_handler!\n  \
             missing from the file: {:?}\n  not registered: {:?}",
            registered.difference(&permitted).collect::<Vec<_>>(),
            permitted.difference(&registered).collect::<Vec<_>>(),
        );
    }
    let commands: &'static [&'static str] = Box::leak(
        commands
            .into_iter()
            .map(|name| &*Box::leak(name.into_boxed_str()))
            .collect::<Vec<&'static str>>()
            .into_boxed_slice(),
    );

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
