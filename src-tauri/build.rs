fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Keep the existing 10.13 minimum: UserNotifications is a 10.14+ optional
        // backend, guarded by a runtime Objective-C class check before use.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,UserNotifications");
    }
    tauri_build::build()
}
