// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use opendialyzer_core::report::{OpenResult, Report};
use tauri::State;

/// One open report at a time, mirroring the Electron `session` singleton.
#[derive(Default)]
struct Session {
    report: Mutex<Option<Report>>,
}

/// Mirrors the Electron `session:open` handler.
#[tauri::command]
fn open_report(path: String, session: State<Session>) -> Result<OpenResult, String> {
    let p = PathBuf::from(&path);
    let report = Report::load(&p)?;
    let name = p
        .parent()
        .and_then(|d| d.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let result = report.open_result(name);
    *session.report.lock().unwrap() = Some(report);
    Ok(result)
}

/// Mirrors the Electron `targets:list` handler.
#[tauri::command]
fn distinct_targets(session: State<Session>) -> Vec<String> {
    match &*session.report.lock().unwrap() {
        Some(r) => r.distinct_targets(),
        None => Vec::new(),
    }
}

/// The report path given on the command line, if any. The frontend pulls this on
/// boot to auto-load, mirroring the Electron `session:autoload` event.
#[tauri::command]
fn autoload_path() -> Option<String> {
    std::env::args().nth(1)
}

fn main() {
    tauri::Builder::default()
        .manage(Session::default())
        .invoke_handler(tauri::generate_handler![
            open_report,
            distinct_targets,
            autoload_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
