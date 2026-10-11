// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--mcp-stdio") {
        if args.len() != 4 {
            eprintln!("Usage: shellbeam --mcp-stdio <endpoint-file> <client-id>");
            std::process::exit(2);
        }
        if let Err(error) = app_lib::run_mcp_stdio(&args[2], &args[3]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    app_lib::run();
}
