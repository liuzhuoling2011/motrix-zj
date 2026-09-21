use crate::error::AppError;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;
use tauri::Manager;

/// Returns `true` when the current process was launched by the OS
/// autostart mechanism (the Tauri autostart plugin appends `--autostart`)
/// **and** the app is still in the initial cold-start phase.
///
/// Once the user first dismisses the window (triggering
/// `handle_minimize_to_tray`), the lifecycle transitions to runtime
/// and this function always returns `false`.  This prevents lightweight
/// mode window recreations from incorrectly re-applying autostart-hide
/// logic — the recreated frontend calls this again, but the argv
/// `--autostart` flag is a process-level constant that never changes.
/// See issue #206.
///
/// Checks for both exact `--autostart` and prefix `--autostart=` variants
/// to tolerate edge cases from the auto-launch crate's Windows registry
/// entry handling (nicehash/auto-launch#771).
///
/// Logging strategy (privacy-safe):
/// - `info!`: argument count and boolean result only
/// - `debug!`: structured diagnostics (match type counts) — no raw argv,
///   because diagnostic exports can include debug logs when users enable them
///   for issue reproduction
#[tauri::command]
pub fn is_autostart_launch(lifecycle: tauri::State<'_, crate::AppLifecycleState>) -> bool {
    // After the cold-start phase ends (user dismissed the window at least
    // once), always return false.  Window recreations in lightweight mode
    // are user-initiated — they must NOT trigger autostart-hide.  #206.
    if !lifecycle.is_cold_start() {
        log::info!("is_autostart_launch: post-cold-start phase → false");
        return false;
    }

    // Cold start: check argv as before.
    let args: Vec<String> = std::env::args().collect();
    let matched_exact = args.iter().any(|a| a == "--autostart");
    let matched_prefixed = args.iter().any(|a| a.starts_with("--autostart="));
    let result = matched_exact || matched_prefixed;
    // Subtract 1 for argv[0] (binary name), then subtract matched args
    let other_arg_count =
        args.len().saturating_sub(1) - (matched_exact as usize) - (matched_prefixed as usize);
    log::info!("is_autostart_launch: argc={} result={}", args.len(), result);
    log::debug!(
        "is_autostart_launch: matched_exact={} matched_prefixed={} other_arg_count={}",
        matched_exact,
        matched_prefixed,
        other_arg_count
    );
    result
}

fn clear_managed_log_files_in_dir(log_dir: &Path) -> Result<(), AppError> {
    if !log_dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(log_dir)
        .map_err(|e| AppError::Io(format!("Failed to read log dir: {e}")))?
        .flatten()
    {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !path.is_file() {
            continue;
        }
        if crate::log_policy::is_managed_active_log_file(name) {
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .map_err(|e| AppError::Io(format!("Failed to clear active log: {e}")))?;
        } else if crate::log_policy::managed_log_source(name).is_some() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::Io(format!("Failed to remove rotated log: {e}")))?;
        }
    }
    Ok(())
}

/// Clears managed logs in the app log directory.
#[tauri::command]
pub fn clear_log_file(app: AppHandle) -> Result<(), AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    clear_managed_log_files_in_dir(&log_dir)
}

/// Exports a redacted runtime snapshot and the complete application and engine logs.
#[tauri::command]
pub async fn export_diagnostic_logs(app: AppHandle, save_path: String) -> Result<String, AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    if !log_dir.exists() {
        return Err(AppError::NotFound("Log directory does not exist".into()));
    }

    let zip_path = std::path::PathBuf::from(&save_path);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let config_path = data_dir.join("config.json");
    let raw_config = if config_path.exists() {
        match std::fs::read(&config_path) {
            Ok(content) => match serde_json::from_slice::<Value>(&content) {
                Ok(value) => Some(value),
                Err(e) => {
                    log::warn!("diagnostic export: config parse failed, omitting raw config: {e}");
                    None
                }
            },
            Err(e) => {
                log::warn!("diagnostic export: config read failed: {e}");
                None
            }
        }
    } else {
        None
    };
    log::logger().flush();
    if let (Some(state), Some(level)) = (
        app.try_state::<crate::aria2::client::Aria2State>(),
        raw_config
            .as_ref()
            .and_then(|value| value.get("preferences"))
            .and_then(|value| value.get("aria2LogLevel"))
            .and_then(Value::as_str),
    ) {
        let mut log_option = serde_json::Map::new();
        log_option.insert("log-level".to_string(), Value::String(level.to_string()));
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.0.change_global_option(log_option),
        )
        .await;
    }

    let logs = crate::diagnostics::collect_logs(&log_dir)?;
    let diagnostics = crate::diagnostics::runtime_snapshot(&app, raw_config.as_ref()).await;
    crate::diagnostics::write_archive(&zip_path, &logs, &diagnostics)?;

    log::info!(target: "diagnostics", event = "diagnostics_exported", path:% = zip_path.display(); "diagnostics_exported");
    Ok(crate::engine::path_to_safe_string(&zip_path))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn clear_managed_log_files_truncates_active_logs_and_removes_rotations() {
        let dir = tempfile::tempdir().expect("tempdir");
        let motrix = dir.path().join("motrix-next.log");
        let aria2 = dir.path().join("aria2-next.log");
        let rotated = dir.path().join("aria2-next.1.log");
        let motrix_rotated = dir.path().join("motrix-next_2026-08-27_12-00-00.log");
        let other = dir.path().join("other.log");

        std::fs::write(&motrix, "motrix log").expect("motrix log");
        std::fs::write(&aria2, "aria2 log").expect("aria2 log");
        std::fs::write(&rotated, "rotated log").expect("rotated log");
        std::fs::write(&motrix_rotated, "rotated log").expect("motrix rotated log");
        std::fs::write(&other, "other log").expect("other log");

        clear_managed_log_files_in_dir(dir.path()).expect("clear logs");

        assert_eq!(
            std::fs::metadata(&motrix).expect("motrix metadata").len(),
            0
        );
        assert_eq!(std::fs::metadata(&aria2).expect("aria2 metadata").len(), 0);
        assert!(!rotated.exists());
        assert!(!motrix_rotated.exists());
        assert_eq!(
            std::fs::read_to_string(&other).expect("other content"),
            "other log"
        );
    }
}

/// Checks whether a file or directory exists at the given path.
///
/// This command bypasses Tauri's frontend FS scope restrictions, which
/// fail to match Windows drive-root paths like `Z:\` due to glob pattern
/// limitations (see <https://github.com/tauri-apps/tauri/issues/11119>).
///
/// For a download manager that must verify user-chosen download targets on
/// any mounted volume, scope-free existence checks are essential.
#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    let result = std::path::Path::new(&path).exists();
    log::debug!("check_path_exists: path={path:?} result={result}");
    result
}

/// Returns `true` when the given path exists **and** is a directory.
///
/// Counterpart to [`check_path_exists`] — used by the frontend to decide
/// whether to call `openPath` (for a directory) or `revealItemInDir` (for
/// a file). Same scope-bypass rationale applies.
#[tauri::command]
pub fn check_path_is_dir(path: String) -> bool {
    let result = std::path::Path::new(&path).is_dir();
    log::debug!("check_path_is_dir: path={path:?} result={result}");
    result
}

/// Reads a local file selected or referenced by the user.
///
/// This command keeps arbitrary user-path reads behind Rust IPC instead of
/// granting the frontend plugin a wildcard filesystem scope.
#[tauri::command]
pub fn read_local_file(path: String) -> Result<Vec<u8>, AppError> {
    std::fs::read(&path).map_err(|e| AppError::Io(format!("Failed to read file: {e}")))
}

/// Lists regular file names in a directory.
///
/// Used for aria2 metadata cleanup without exposing a wildcard frontend FS
/// scope. Directory traversal stays in Rust, and only file names are returned.
#[tauri::command]
pub fn list_dir_files(path: String) -> Result<Vec<String>, AppError> {
    let entries =
        std::fs::read_dir(&path).map_err(|e| AppError::Io(format!("Failed to read dir: {e}")))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }
    Ok(files)
}

/// Normalizes a file-system path for safe use with OS shell APIs.
///
/// Handles three classes of path issues that cause "file not found" errors:
/// 1. **Mixed separators** — aria2 on Windows may return `Z:\\` while JS
///    joins with `/`, producing `Z:\\/file.exe`. `Path::new()` normalizes
///    this to the platform's native separator.
/// 2. **`\\?\\` prefix** — `std::fs::canonicalize()` on Windows may return
///    extended-length paths (`\\?\\C:\\...`). `dunce::simplified()` strips
///    this prefix when safe, since Win32 Shell APIs like `ILCreateFromPathW`
///    do not support it.
/// 3. **Trailing separators** — Ensures paths ending in `\\` or `/` do not
///    confuse shell APIs.
pub(crate) fn normalize_path(raw: &str) -> String {
    use std::path::PathBuf;
    // Step 1: Decompose into components and reassemble with native separators.
    // On Windows, `Path::new("Z:/file")` understands `/` but `to_string_lossy()`
    // returns the ORIGINAL string unchanged. `.components().collect::<PathBuf>()`
    // reconstructs with `\` on Windows, `/` on Unix.
    let reassembled: PathBuf = Path::new(raw).components().collect();
    // Step 2: Strip `\\?\` prefix if present (safe for Win32 Shell APIs).
    let normalized = dunce::simplified(&reassembled);
    log::debug!("normalize_path: raw={raw:?} normalized={normalized:?}");
    normalized.to_string_lossy().to_string()
}

/// Reveals a file or directory in the system file explorer.
///
/// ## Windows
///
/// Bypasses `tauri_plugin_opener::reveal_item_in_dir` because that plugin
/// calls `dunce::canonicalize()` internally (L13 of `reveal_item_in_dir.rs`),
/// which converts mapped-drive paths (e.g. `Z:\file`) to UNC format
/// (`\\?\UNC\server\share\file`). `ILCreateFromPathW` cannot handle the
/// `\\?\UNC\` prefix → returns NULL → os error 2.
/// See: <https://github.com/tauri-apps/plugins-workspace/issues/3304>
///
/// Instead, we call the Windows Shell APIs directly:
/// 1. Normalize separators via `components().collect()`
/// 2. Canonicalize via `dunce::canonicalize()` (strips `\\?\` for local drives)
/// 3. Strip residual `\\?\UNC\` prefix → `\\server\share\...` (for mapped drives)
/// 4. Call `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`
/// 5. Fallback: `ShellExecuteExW` on `ERROR_FILE_NOT_FOUND` (Electron pattern)
///
/// ## macOS / Linux
///
/// Delegates to `tauri_plugin_opener::reveal_item_in_dir` (no UNC bug on these
/// platforms — macOS uses `NSWorkspace`, Linux uses D-Bus FileManager1).
#[tauri::command]
pub fn show_item_in_dir(path: String) -> Result<(), AppError> {
    let normalized = normalize_path(&path);
    log::debug!("show_item_in_dir: original={path:?} normalized={normalized:?}");
    reveal_in_explorer(&normalized)
}

/// Platform-dispatched implementation for revealing files in the explorer.
#[cfg(not(windows))]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|e| AppError::Io(format!("Failed to reveal: {e}")))
}

/// Windows implementation: direct Shell API calls with UNC prefix stripping.
///
/// Mirrors the approach used by:
/// - Electron: `shell/common/platform_util_win.cc` L282-310
/// - tauri-plugin-opener: `reveal_item_in_dir.rs` L99-160 (but with UNC fix)
#[cfg(windows)]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    use std::path::PathBuf;
    use windows_sys::Win32::{
        Foundation::ERROR_FILE_NOT_FOUND,
        System::Com::CoInitializeEx,
        UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems},
    };

    // Step 1: Best-effort canonicalization.
    // `dunce::canonicalize` resolves symlinks and strips `\\?\` for local drives.
    // However, some virtual file system drivers (RAM disks like ImDisk, Ruanmei Mofang)
    // do not support `GetFinalPathNameByHandleW` — the API that `canonicalize()`
    // relies on — and return ERROR_FILE_NOT_FOUND even though the file exists.
    // See: https://github.com/rust-lang/rust/issues/99608
    // Fallback: use the already-normalized path from `normalize_path()`.
    let canonical = dunce::canonicalize(path).unwrap_or_else(|e| {
        log::debug!("canonicalize failed (virtual FS?), using normalized path: {e}");
        PathBuf::from(path)
    });

    // Step 2: Strip `\\?\UNC\` prefix for mapped drives.
    // `\\?\UNC\server\share\file` → `\\server\share\file`
    // This is the fix for GitHub issue #3304.
    let path_str = canonical.to_string_lossy();
    let fixed: PathBuf = if path_str.starts_with(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", &path_str[r"\\?\UNC\".len()..]))
    } else if path_str.starts_with(r"\\?\") {
        // Shouldn't happen (dunce handles this), but defensive
        PathBuf::from(&path_str[r"\\?\".len()..])
    } else {
        canonical.clone()
    };

    log::debug!("reveal_in_explorer: canonical={canonical:?} fixed={fixed:?}");

    // Step 3: Get the parent directory for SHOpenFolderAndSelectItems.
    let parent = fixed
        .parent()
        .ok_or_else(|| AppError::Io(format!("No parent directory for {path:?}")))?;

    // Step 4: Convert paths to wide strings (null-terminated UTF-16).
    let parent_wide = to_wide(parent.to_string_lossy().as_ref());
    let file_wide = to_wide(fixed.to_string_lossy().as_ref());

    unsafe {
        // Initialize COM (required for Shell APIs, idempotent).
        let _ = CoInitializeEx(std::ptr::null(), 0);

        // Convert parent directory to ITEMIDLIST.
        let parent_pidl = ILCreateFromPathW(parent_wide.as_ptr());
        if parent_pidl.is_null() {
            // Fallback: open the parent directory directly.
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Convert target file to ITEMIDLIST.
        let file_pidl = ILCreateFromPathW(file_wide.as_ptr());
        if file_pidl.is_null() {
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Open folder and select the file.
        let items: [*const _; 1] = [file_pidl as *const _];
        let result = SHOpenFolderAndSelectItems(parent_pidl, 1, items.as_ptr(), 0);

        // Electron-style fallback: on ERROR_FILE_NOT_FOUND, use ShellExecuteW.
        // "On some systems, the above call mysteriously fails with 'file not found'
        //  even though the file is there." — Electron source
        if result != 0 && (result as u32) == ERROR_FILE_NOT_FOUND {
            ILFree(file_pidl);
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        ILFree(file_pidl);
        ILFree(parent_pidl);

        if result != 0 {
            return Err(AppError::Io(format!(
                "SHOpenFolderAndSelectItems failed: HRESULT 0x{result:08X}"
            )));
        }
    }

    Ok(())
}

/// Fallback: open a directory with `ShellExecuteW("explore")`.
#[cfg(windows)]
fn shell_execute_open(dir: &str) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let dir_wide = to_wide(dir);
    let verb_wide = to_wide("explore");

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(), // hwnd
            verb_wide.as_ptr(),   // lpOperation: "explore"
            dir_wide.as_ptr(),    // lpFile: directory path
            std::ptr::null(),     // lpParameters
            std::ptr::null(),     // lpDirectory
            SW_SHOWNORMAL,        // nShowCmd
        )
    };
    // ShellExecuteW returns HINSTANCE > 32 on success.
    if (result as isize) <= 32 {
        Err(AppError::Io(format!("ShellExecuteW failed for {dir:?}")))
    } else {
        Ok(())
    }
}

/// Convert a &str to a null-terminated Vec<u16> for Win32 wide-string APIs.
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Opens a file or directory with the system's default application.
///
/// Normalizes the path before calling the opener to handle mixed separators.
/// Counterpart to [`show_item_in_dir`] — used when the target is a directory
/// (opens in file manager) or a file (opens with default app).
#[tauri::command]
pub fn open_path_normalized(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    log::debug!("file:open path={path:?}");
    let normalized = normalize_path(&path);
    app.opener()
        .open_path(&normalized, None::<&str>)
        .map_err(|e| AppError::Io(format!("Failed to open {}: {}", path, e)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileDeletionMode {
    Trash,
    Permanent,
}

#[tauri::command]
pub fn delete_path(path: String, mode: FileDeletionMode) -> Result<bool, AppError> {
    if path.trim().is_empty() {
        return Ok(false);
    }

    let target = Path::new(&path);
    let metadata = match std::fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::Io(error.to_string())),
    };

    log::info!("file:delete mode={mode:?} path={path:?}");
    match mode {
        FileDeletionMode::Trash => {
            trash::delete(target).map_err(|error| AppError::Io(error.to_string()))?
        }
        FileDeletionMode::Permanent if metadata.file_type().is_dir() => {
            std::fs::remove_dir_all(target).map_err(|error| AppError::Io(error.to_string()))?;
        }
        FileDeletionMode::Permanent => {
            std::fs::remove_file(target).map_err(|error| AppError::Io(error.to_string()))?;
        }
    }

    Ok(true)
}

/// Moves a file to a target directory, creating the directory if needed.
///
/// Uses `std::fs::rename` for same-filesystem moves (zero-copy, atomic).
/// Falls back to copy+delete for cross-filesystem moves (e.g. NAS, external drives).
/// Returns the absolute path of the moved file.
///
/// Used by the auto-archive feature to relocate completed downloads into
/// category directories based on file extension classification.
#[tauri::command]
pub fn move_file(source: String, target_dir: String) -> Result<String, AppError> {
    let src = Path::new(&source);
    if !src.is_file() {
        return Err(AppError::Io(format!("Source is not a file: {source:?}")));
    }

    let target = Path::new(&target_dir);
    if !target.exists() {
        std::fs::create_dir_all(target)
            .map_err(|e| AppError::Io(format!("Failed to create directory {target_dir:?}: {e}")))?;
    }

    let file_name = src
        .file_name()
        .ok_or_else(|| AppError::Io(format!("Cannot extract filename from {source:?}")))?;
    let dest = target.join(file_name);

    // Avoid overwriting existing files — append (1), (2), etc.
    let dest = if dest.exists() {
        let stem = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = dest.extension().map(|e| e.to_string_lossy().to_string());
        let mut counter = 1u32;
        loop {
            let new_name = match &ext {
                Some(e) => format!("{stem} ({counter}).{e}"),
                None => format!("{stem} ({counter})"),
            };
            let candidate = target.join(&new_name);
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
            if counter > 999 {
                return Err(AppError::Io(format!(
                    "Too many name collisions for {file_name:?} in {target_dir:?}"
                )));
            }
        }
    } else {
        dest
    };

    log::info!("file:move {source:?} → {dest:?}");

    // Try rename first (same filesystem = atomic, zero-copy)
    match std::fs::rename(src, &dest) {
        Ok(()) => {}
        Err(e)
            if e.raw_os_error() == Some(18 /* EXDEV */)
                || e.kind() == std::io::ErrorKind::Other =>
        {
            // Cross-filesystem: copy + delete
            std::fs::copy(src, &dest)
                .map_err(|e| AppError::Io(format!("Failed to copy {source:?} to {dest:?}: {e}")))?;
            std::fs::remove_file(src).map_err(|e| {
                AppError::Io(format!(
                    "File copied to {dest:?} but failed to remove source {source:?}: {e}"
                ))
            })?;
        }
        Err(e) => {
            return Err(AppError::Io(format!(
                "Failed to move {source:?} to {dest:?}: {e}"
            )));
        }
    }

    // Normalize to forward slashes — aria2 and the frontend canonicalize
    // all paths with `/`.  On Windows, PathBuf::join() produces `\`.
    Ok(crate::engine::path_to_safe_string(&dest).replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs_source() -> String {
        include_str!("fs.rs").replace("\r\n", "\n")
    }

    fn expected_native_path(raw: &str) -> String {
        if cfg!(windows) {
            raw.replace('/', "\\")
        } else {
            raw.to_string()
        }
    }

    // ── check_path_exists ──────────────────────────────────────────────

    #[test]
    fn check_path_exists_returns_true_for_existing_file() {
        // Cargo.toml always exists at the workspace root when tests run
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_true_for_existing_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_false_for_nonexistent_path() {
        assert!(!check_path_exists(
            "/definitely/does/not/exist/anywhere/file.txt".to_string()
        ));
    }

    #[test]
    fn check_path_exists_returns_false_for_empty_string() {
        assert!(!check_path_exists(String::new()));
    }

    #[test]
    fn check_path_exists_handles_path_with_spaces() {
        // Create a temp file with spaces in the path
        let dir = std::env::temp_dir().join("motrix test spaces");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("test file.txt");
        let _ = std::fs::write(&file, "test");
        assert!(check_path_exists(file.to_string_lossy().to_string()));
        // Cleanup
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    // ── check_path_is_dir ──────────────────────────────────────────────

    #[test]
    fn check_path_is_dir_returns_true_for_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_file() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(!check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_nonexistent() {
        assert!(!check_path_is_dir("/does/not/exist/whatsoever".to_string()));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_empty_string() {
        assert!(!check_path_is_dir(String::new()));
    }

    // ── normalize_path ─────────────────────────────────────────────────

    #[test]
    fn normalize_path_preserves_simple_unix_path() {
        let raw = "/home/user/downloads/file.txt";
        let result = normalize_path(raw);
        assert_eq!(result, expected_native_path(raw));
    }

    #[test]
    fn normalize_path_preserves_path_with_spaces() {
        let raw = "/home/user/my downloads/file name.txt";
        let result = normalize_path(raw);
        assert_eq!(result, expected_native_path(raw));
    }

    #[test]
    fn normalize_path_handles_empty_string() {
        let result = normalize_path("");
        assert_eq!(result, "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_mixed_separators_windows() {
        // aria2 returns `Z:\\` + JS joins with `/` → `Z:\\/file.exe`
        let result = normalize_path("Z:\\/MotrixNext_setup.exe");
        assert_eq!(result, "Z:\\MotrixNext_setup.exe");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_double_backslash_forward_slash() {
        let result = normalize_path("D:\\/downloads/subfolder/file.zip");
        assert_eq!(result, "D:\\downloads\\subfolder\\file.zip");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        // std::fs::canonicalize adds \\?\\
        let result = normalize_path("\\\\?\\C:\\Users\\test\\file.txt");
        assert_eq!(result, "C:\\Users\\test\\file.txt");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_handles_windows_unc_path() {
        let result = normalize_path("\\\\server\\share\\file.txt");
        assert_eq!(result, "\\\\server\\share\\file.txt");
    }

    #[test]
    fn normalize_path_handles_forward_slash_only() {
        // Pure forward-slash paths (cross-platform compatible)
        let raw = "/var/log/app.log";
        let result = normalize_path(raw);
        assert_eq!(result, expected_native_path(raw));
    }

    // ── show_item_in_dir structural tests ──────────────────────────────

    /// Verifies show_item_in_dir calls normalize_path then reveal_in_explorer.
    #[test]
    fn show_item_in_dir_calls_normalize_then_reveal() {
        let source = fs_source();
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path")
            .expect("show_item_in_dir must call normalize_path");
        let reveal_pos = fn_body
            .find("reveal_in_explorer")
            .expect("show_item_in_dir must call reveal_in_explorer");
        assert!(
            norm_pos < reveal_pos,
            "normalize_path must appear before reveal_in_explorer"
        );
    }

    /// Verifies Windows cfg-gate exists and bypasses tauri_plugin_opener.
    #[test]
    fn reveal_in_explorer_has_windows_cfg_gate() {
        let source = fs_source();
        // Must have #[cfg(windows)] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(windows)]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(windows)] variant"
        );
        // Must have #[cfg(not(windows))] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(not(windows))]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(not(windows))] fallback"
        );
    }

    /// Verifies the Windows implementation uses ILCreateFromPathW (not plugin).
    #[test]
    fn windows_reveal_uses_shell_api() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("ILCreateFromPathW"),
            "Windows reveal must use ILCreateFromPathW"
        );
        assert!(
            fn_body.contains("SHOpenFolderAndSelectItems"),
            "Windows reveal must use SHOpenFolderAndSelectItems"
        );
    }

    /// Verifies the Windows implementation strips \\?\UNC\ prefix (issue #3304 fix).
    #[test]
    fn windows_reveal_strips_unc_prefix() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains(r#"starts_with(r"\\?\UNC\")"#),
            "Windows reveal must check for \\\\?\\UNC\\ prefix"
        );
    }

    /// Verifies the Windows implementation has an Electron-style ShellExecuteExW fallback.
    #[test]
    fn windows_reveal_has_shell_execute_fallback() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("shell_execute_open"),
            "Windows reveal must have ShellExecuteExW fallback"
        );
        assert!(
            fn_body.contains("ERROR_FILE_NOT_FOUND"),
            "Windows reveal must handle ERROR_FILE_NOT_FOUND"
        );
    }

    /// Verifies non-Windows fallback uses tauri_plugin_opener.
    #[test]
    fn non_windows_reveal_uses_plugin_opener() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(not(windows))]\nfn reveal_in_explorer")
            .expect("non-Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 300];
        assert!(
            fn_body.contains("tauri_plugin_opener::reveal_item_in_dir"),
            "non-Windows fallback must use tauri_plugin_opener"
        );
    }

    // ── canonicalize best-effort tests (RAM disk / virtual FS) ────────

    /// Verifies canonicalize uses unwrap_or_else (best-effort, never hard-fails).
    /// Critical for RAM disks (ImDisk, Ruanmei Mofang) where GetFinalPathNameByHandleW
    /// is unsupported. See: https://github.com/rust-lang/rust/issues/99608
    #[test]
    fn windows_reveal_canonicalize_is_best_effort() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // Must use unwrap_or_else (graceful fallback), NOT map_err/? (hard error)
        assert!(
            fn_body.contains("dunce::canonicalize(path).unwrap_or_else"),
            "canonicalize must use unwrap_or_else for best-effort (not map_err/?)"
        );
        // Must NOT have map_err on canonicalize (regression guard)
        let canonicalize_pos = fn_body
            .find("dunce::canonicalize")
            .expect("must call dunce::canonicalize");
        let after_canonicalize = &fn_body[canonicalize_pos..canonicalize_pos + 200];
        assert!(
            !after_canonicalize.contains("map_err"),
            "canonicalize must NOT use map_err (would hard-fail on RAM disks)"
        );
        assert!(
            !after_canonicalize.contains(")?"),
            "canonicalize must NOT use ? operator (would hard-fail on RAM disks)"
        );
    }

    /// Verifies canonicalize fallback logs a debug message for diagnostics.
    #[test]
    fn windows_reveal_canonicalize_fallback_logs_debug() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // The unwrap_or_else closure must log the error
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("log::debug!"),
            "canonicalize fallback must log debug message with the error"
        );
    }

    /// Verifies canonicalize fallback creates PathBuf from the input path.
    #[test]
    fn windows_reveal_canonicalize_fallback_uses_input_path() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("PathBuf::from(path)"),
            "canonicalize fallback must use the already-normalized input path"
        );
    }

    /// Verifies shell_execute_open uses ShellExecuteW (not ShellExecuteExW).
    /// ShellExecuteExW requires Win32_System_Registry feature; ShellExecuteW does not.
    #[test]
    fn shell_execute_open_uses_shell_execute_w() {
        let source = fs_source();
        // Verify the import line exists in the actual function (not test code).
        // The function imports "Shell::ShellExecuteW;" (note the semicolon — not Ex variant).
        assert!(
            source.contains("Shell::ShellExecuteW;"),
            "shell_execute_open must import ShellExecuteW"
        );
    }

    /// Verifies the to_wide helper function exists with cfg(windows).
    #[test]
    fn to_wide_helper_exists() {
        let source = fs_source();
        // Check the cfg gate + function signature + utf16 encoding all exist
        assert!(
            source.contains("#[cfg(windows)]\nfn to_wide("),
            "to_wide helper must exist with #[cfg(windows)]"
        );
        assert!(
            source.contains("encode_utf16"),
            "to_wide must use encode_utf16 for wide string conversion"
        );
    }

    /// Verifies show_item_in_dir includes debug logging for traceability.
    #[test]
    fn show_item_in_dir_has_debug_logging() {
        let source = fs_source();
        // Search within the function body (between pub fn and next fn/doc comment)
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(fn_start + 500);
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "show_item_in_dir must include debug logging"
        );
    }

    /// Verifies Windows reveal_in_explorer initializes COM before Shell API calls.
    #[test]
    fn windows_reveal_initializes_com() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let com_pos = fn_body
            .find("CoInitializeEx")
            .expect("Windows reveal must initialize COM");
        let shell_pos = fn_body
            .find("ILCreateFromPathW")
            .expect("must call ILCreateFromPathW");
        assert!(
            com_pos < shell_pos,
            "COM init must happen before Shell API calls"
        );
    }

    /// Verifies open_path_normalized calls normalize_path before open_path.
    #[test]
    fn open_path_normalized_calls_normalize_path() {
        let source = fs_source();
        let fn_start = source
            .find("pub fn open_path_normalized")
            .expect("open_path_normalized function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path(")
            .expect("open_path_normalized must call normalize_path()");
        let open_pos = fn_body
            .find("open_path(")
            .expect("open_path_normalized must call open_path()");
        assert!(
            norm_pos < open_pos,
            "normalize_path must be called before open_path"
        );
    }

    // ── normalize_path tests ──────────────────────────────────────────

    /// Verifies normalize_path uses components().collect() for separator normalization.
    #[test]
    fn normalize_path_uses_components_collect() {
        let source = include_str!("fs.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("components().collect"),
            "normalize_path must use components().collect() for separator normalization"
        );
    }

    /// Verifies normalize_path uses dunce::simplified for prefix stripping.
    #[test]
    fn normalize_path_uses_dunce() {
        let source = include_str!("fs.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("dunce::simplified"),
            "normalize_path must use dunce::simplified for \\\\?\\ prefix stripping"
        );
    }

    /// Verifies normalize_path includes debug logging.
    #[test]
    fn normalize_path_has_debug_logging() {
        let source = include_str!("fs.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "normalize_path must include debug logging"
        );
    }

    // ── remove_file ─────────────────────────────────────────────────
    // ── delete_path ─────────────────────────────────────────────────

    #[test]
    fn delete_path_permanently_deletes_existing_file() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let file = dir.path().join("test.bin");
        std::fs::write(&file, "data").expect("write test file");

        let result = delete_path(
            file.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete file"));
        assert!(!file.exists(), "file must be permanently deleted");
    }

    #[test]
    fn delete_path_permanently_deletes_directory_tree() {
        let root = tempfile::tempdir().expect("create temp dir");
        let directory = root.path().join("download");
        std::fs::create_dir_all(directory.join("nested")).expect("create directory tree");
        std::fs::write(directory.join("nested/file.bin"), "data").expect("write file");

        let result = delete_path(
            directory.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete directory"));
        assert!(
            !directory.exists(),
            "directory tree must be permanently deleted"
        );
    }

    #[test]
    fn delete_path_returns_false_for_nonexistent_path() {
        let result = delete_path(
            "/definitely/does/not/exist/file.bin".to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(!result.expect("missing path is a no-op"));
    }

    #[test]
    fn delete_path_returns_false_for_empty_path() {
        let result = delete_path(String::new(), FileDeletionMode::Permanent);
        assert!(!result.expect("empty path is a no-op"));
    }

    #[cfg(unix)]
    #[test]
    fn delete_path_removes_symlink_without_following_target() {
        let root = tempfile::tempdir().expect("create temp dir");
        let target = root.path().join("target");
        let link = root.path().join("link");
        std::fs::create_dir_all(&target).expect("create target");
        std::fs::write(target.join("file.bin"), "data").expect("write target file");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");

        let result = delete_path(
            link.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete symlink"));
        assert!(!link.exists(), "symlink must be deleted");
        assert!(
            target.join("file.bin").exists(),
            "symlink target must remain"
        );
    }
}
