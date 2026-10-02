#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod dsp;

use audio::{Devices, Engine};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Passed by the "start with Windows" entry so the app starts quietly in the tray.
const MINIMIZED_ARG: &str = "--minimized";

/// The tray's "Clean voice" checkbox, kept so the UI's power button can update it.
struct Tray {
    toggle: CheckMenuItem<Wry>,
}

/// An update found by `check_update`, waiting for the user to click "Update now".
struct PendingUpdate(Mutex<Option<Update>>);

#[tauri::command]
fn list_devices() -> Devices {
    audio::list_devices()
}

#[tauri::command]
fn start(engine: State<Engine>, input: String, output: String, monitor: Option<String>) -> Result<(), String> {
    engine.start(input, output, monitor)
}

#[tauri::command]
fn stop(engine: State<Engine>) {
    engine.stop()
}

#[tauri::command]
fn set_enabled(app: AppHandle, engine: State<Engine>, enabled: bool) {
    engine.shared.enabled.store(enabled, Ordering::Relaxed);
    sync_tray(&app, enabled);
}

#[tauri::command]
fn set_strength(engine: State<Engine>, strength: f32) {
    engine.shared.set_strength(strength)
}

#[tauri::command]
fn set_loudness(engine: State<Engine>, loudness: f32) {
    engine.shared.set_loudness(loudness)
}

#[tauri::command]
fn set_echo(engine: State<Engine>, enabled: bool) {
    engine.shared.echo.store(enabled, Ordering::Relaxed)
}

#[tauri::command]
fn set_eq(engine: State<Engine>, bands: [dsp::Band; dsp::EQ_BANDS]) {
    engine.shared.set_eq(bands)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// Returns the new version if one is available.
#[tauri::command]
async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<String>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let version = update.as_ref().map(|u| u.version.clone());
    *pending.0.lock().unwrap() = update;
    Ok(version)
}

/// Downloads and runs the new installer, then restarts into the new version.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update available")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}

/// Runs the bundled VB-CABLE setup (asks Windows for admin rights) and waits for it.
#[tauri::command]
async fn install_cable(app: AppHandle) -> Result<(), String> {
    let exe = app
        .path()
        .resolve("vbcable/VBCABLE_Setup_x64.exe", BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList '-i','-h' -Verb RunAs -Wait",
        exe.display().to_string().replace('\'', "''")
    );
    let status = tauri::async_runtime::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("VB-CABLE was not installed.".into())
    }
}

/// "Start with Windows" is on by default: turn it on the first time the installed app runs.
/// (Not in dev builds, which would register the debug exe.)
fn autostart_first_run(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(marker, "");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn sync_tray(app: &AppHandle, enabled: bool) {
    if let Some(tray) = app.try_state::<Tray>() {
        let _ = tray.toggle.set_checked(enabled);
    }
    if let Some(icon) = app.tray_by_id("main") {
        let _ = icon.set_tooltip(Some(if enabled { "Clean Mic: on" } else { "Clean Mic: off" }));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Clean Mic", true, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(app, "toggle", "Clean my voice", true, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Clean Mic: on")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "toggle" => {
                // the menu flips its own check mark; the UI owns the saved setting
                let on = app.state::<Tray>().toggle.is_checked().unwrap_or(true);
                app.state::<Engine>().shared.enabled.store(on, Ordering::Relaxed);
                sync_tray(app, on);
                let _ = app.emit("enabled", on);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(Tray { toggle });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // a second launch just brings the running app to the front
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Engine::new())
        .manage(PendingUpdate(Mutex::new(None)))
        .setup(|app| {
            build_tray(app.handle())?;
            autostart_first_run(app.handle());
            // the window starts hidden; only stay in the tray when Windows started us
            if !std::env::args().any(|a| a == MINIMIZED_ARG) {
                show_main(app.handle());
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut tick = 0u32;
                loop {
                    std::thread::sleep(Duration::from_millis(40));
                    tick = tick.wrapping_add(1);
                    // In the tray nobody sees the meters; the UI still needs the running/error
                    // state to auto-restart, so keep sending it, just ~2x a second.
                    let seen = handle
                        .get_webview_window("main")
                        .is_some_and(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false));
                    if !seen && tick % 12 != 0 {
                        continue;
                    }
                    let meter = handle.state::<Engine>().shared.meter();
                    let _ = handle.emit("meter", meter);
                }
            });
            Ok(())
        })
        // closing the window keeps the mic running in the tray; quit from the tray menu
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            start,
            stop,
            set_enabled,
            set_strength,
            set_loudness,
            set_echo,
            set_eq,
            get_autostart,
            set_autostart,
            check_update,
            install_update,
            install_cable
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clean Mic");
}
