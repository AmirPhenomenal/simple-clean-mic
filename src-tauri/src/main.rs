#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod dsp;

use audio::{Devices, Engine};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

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
fn set_enabled(engine: State<Engine>, enabled: bool) {
    engine.shared.enabled.store(enabled, Ordering::Relaxed)
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

fn main() {
    tauri::Builder::default()
        .manage(Engine::new())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(40));
                let meter = handle.state::<Engine>().shared.meter();
                let _ = handle.emit("meter", meter);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_devices, start, stop, set_enabled, set_strength, set_loudness, set_echo, set_eq])
        .run(tauri::generate_context!())
        .expect("error while running Clean Mic");
}
