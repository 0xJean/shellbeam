#![allow(unexpected_cfgs)]

mod biometric_store;
mod browser;
mod data;
mod error;
mod keys;
mod mcp;
mod net;
mod ssh;
mod storage;
mod sync;
mod vault;

// Re-exports for cross-module crate:: paths
pub(crate) use data::history;
pub(crate) use data::hosts;
pub(crate) use data::snippets;
pub(crate) use vault::meta as vaults_meta;

use ssh::interactive::InteractiveSessionState;
use ssh::SshSessionPool;
use vault::secrets::VaultState;

pub fn run_mcp_stdio(endpoint_path: &str, client_id: &str) -> Result<(), String> {
    mcp::bridge::run_stdio(endpoint_path, client_id)
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon() {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    let icon_bytes = include_bytes!("../icons/icon.png");
    unsafe {
        let nsdata_cls = Class::get("NSData").unwrap();
        let data: *mut Object = msg_send![
            nsdata_cls,
            dataWithBytes:icon_bytes.as_ptr()
            length:icon_bytes.len()
        ];

        let nsimage_cls = Class::get("NSImage").unwrap();
        let image: *mut Object = msg_send![nsimage_cls, alloc];
        let image: *mut Object = msg_send![image, initWithData:data];

        let nsapp_cls = Class::get("NSApplication").unwrap();
        let app: *mut Object = msg_send![nsapp_cls, sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage:image];
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = {
        #[cfg(not(mobile))]
        let b = tauri::Builder::default().plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filename(".shellbeam-window-state.json")
                .skip_initial_state("main")
                .build(),
        );
        #[cfg(mobile)]
        let b = tauri::Builder::default();
        b
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_biometry::init())
        .manage(InteractiveSessionState::default())
        .manage(VaultState::default())
        .manage(SshSessionPool::default())
        .manage(mcp::McpState::default())
        .invoke_handler(tauri::generate_handler![
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_create_client,
            mcp::mcp_revoke_client,
            mcp::mcp_test_connection,
            vault::meta::list_vaults,
            vault::meta::create_vault,
            vault::meta::update_vault,
            vault::meta::delete_vault,
            data::discovery::mdns_discover_devices,
            data::discovery::mdns_start_discover,
            data::discovery::mdns_stop_discover,
            net::known_hosts::list_known_hosts,
            net::known_hosts::fetch_and_add_known_host,
            net::known_hosts::remove_known_host,
            data::hosts::list_hosts,
            data::hosts::create_host,
            data::hosts::update_host,
            data::hosts::delete_host,
            data::workspace_inventory::list_workspace_inventory_snapshots,
            data::workspace_inventory::upsert_workspace_inventory_snapshot,
            data::workspace_inventory::delete_workspace_inventory_snapshot,
            data::workspace_inventory::clear_workspace_inventory_snapshots,
            data::workspace_inventory::list_public_ip_locations,
            data::workspace_inventory::upsert_public_ip_location,
            data::workspace_inventory::clear_public_ip_locations,
            data::workspace_inventory::list_workspace_inventory_host_states,
            data::workspace_inventory::upsert_workspace_inventory_host_state,
            data::workspace_inventory::clear_workspace_inventory_host_states,
            data::workspace_inventory::list_workspace_tool_statuses,
            data::workspace_inventory::upsert_workspace_tool_status,
            data::workspace_inventory::clear_workspace_tool_statuses,
            data::server_monitor::list_server_monitor_latest,
            data::server_monitor::list_server_monitor_history,
            data::server_monitor::save_server_monitor_result,
            data::server_monitor::delete_server_monitor_data,
            data::server_monitor::clear_server_monitor_data,
            ssh::commands::test_ssh_connection,
            ssh::commands::run_ssh_command,
            net::sftp::sftp_home_dir,
            net::sftp::sftp_list_dir,
            net::sftp::sftp_download_file,
            net::sftp::sftp_upload_file,
            net::sftp::sftp_delete_path,
            net::sftp::sftp_rename_path,
            net::sftp::sftp_create_dir,
            net::sftp::sftp_create_file,
            net::sftp::sftp_write_file,
            net::sftp::sftp_chmod,
            net::sftp::local_list_dir,
            net::sftp::local_home_dir,
            net::sftp::local_read_file_b64,
            net::sftp::local_write_file_b64,
            data::history::list_command_history,
            data::activity_log::append_activity,
            data::activity_log::list_activity_log,
            data::ssh_config::parse_ssh_config,
            sync::commands::get_system_hostname,
            sync::commands::sync_get_bootstrap,
            sync::commands::sync_init_local_device,
            sync::commands::sync_register_change,
            sync::commands::sync_query_changes,
            sync::commands::sync_upsert_cursor,
            sync::commands::sync_list_cursors,
            sync::commands::sync_start_pairing,
            sync::commands::sync_confirm_pairing,
            sync::commands::sync_list_trusted_peers,
            sync::peer_pairing::sync_list_pairing_sessions,
            sync::peer::sync_update_peer_endpoint,
            sync::peer::sync_remove_trusted_peer,
            sync::peer::sync_start_server,
            sync::peer::sync_server_status,
            sync::peer::mdns_diagnose,
            sync::peer_pairing::sync_send_pair_request,
            sync::peer_pairing::sync_accept_pair,
            sync::peer::sync_pull_from_peer,
            sync::peer::sync_push_to_peer,
            sync::peer::sync_claim_pending_from_peer,
            data::snippets::list_snippets,
            data::snippets::create_snippet,
            data::snippets::update_snippet,
            data::snippets::delete_snippet,
            data::snippets::run_snippet_command,
            vault::secrets::vault_status,
            vault::secrets::vault_initialize,
            vault::secrets::vault_unlock,
            vault::secrets::vault_lock,
            vault::secrets::vault_set_secret,
            vault::secrets::vault_get_secret,
            vault::secrets::vault_delete_secret,
            vault::secrets::vault_list_secret_keys,
            keys::generate_ssh_key,
            keys::import_private_key_from_file,
            ssh::interactive::create_interactive_session,
            ssh::interactive::send_interactive_input,
            ssh::interactive::poll_interactive_output,
            ssh::interactive::list_interactive_sessions,
            ssh::interactive::close_interactive_session,
            ssh::interactive::resize_interactive_terminal,
            ssh::interactive::create_local_terminal,
            data::backup::backup_create,
            data::backup::backup_restore,
            net::port_forward::list_port_forward_rules,
            net::port_forward::add_port_forward_rule,
            net::port_forward::delete_port_forward_rule,
            net::port_forward::start_port_forward_tunnel,
            net::port_forward::stop_port_forward_tunnel,
            net::port_forward::port_forward_tunnel_status,
            storage::clear_app_data,
            biometric_store::biometric_store_password,
            biometric_store::biometric_retrieve_password,
            biometric_store::biometric_has_password,
            biometric_store::biometric_remove_password,
            browser::open_browser_window,
            browser::open_embedded_browser,
            browser::close_browser_window,
            browser::update_browser_bounds,
            browser::show_browser_webview,
            browser::hide_browser_webview,
            browser::load_browser_source,
            browser::reload_browser_window,
            browser::go_back_browser_window,
            browser::go_forward_browser_window,
            browser::start_browser_port_forward,
            browser::stop_browser_port_forward,
            browser::start_browser_http_proxy,
            browser::stop_browser_http_proxy,
            browser::start_browser_socks_proxy,
            browser::stop_browser_socks_proxy,
        ])
        .setup(|app| {
            if let Err(error) = mcp::initialize(app.handle()) {
                log::error!("MCP initialization failed: {error}");
            }
            #[cfg(target_os = "macos")]
            set_macos_dock_icon();

            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let main_window = app.get_webview_window("main");
                if let Some(window) = main_window {
                    let _ = window.with_webview(move |webview| {
                        #[cfg(target_os = "ios")]
                        unsafe {
                            use objc::runtime::Object;
                            use objc::{msg_send, sel, sel_impl};
                            let wk_webview: *mut Object = webview.inner() as *mut Object;
                            let scroll_view: *mut Object = msg_send![wk_webview, scrollView];
                            let _: () =
                                msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2_isize];
                        }
                    });
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
