//! Tauri commands exposing aria2 RPC operations to the frontend.
//!
//! These commands serve as the invoke() transport layer. Each command maps
//! to one or more aria2 RPC methods.

use crate::aria2::client::Aria2State;
use crate::aria2::types::{Aria2File, Aria2Task};
use crate::error::AppError;
use tauri::State;

/// Fetch task list by type: "active" returns active+waiting, otherwise stopped.
#[tauri::command]
pub async fn aria2_fetch_task_list(
    state: State<'_, Aria2State>,
    r#type: String,
    limit: Option<i64>,
) -> Result<Vec<Aria2Task>, AppError> {
    if r#type == "active" {
        let (active, waiting) =
            tokio::try_join!(state.0.tell_active(), state.0.tell_waiting(0, 1000),)?;
        let mut result = active;
        result.extend(waiting);
        Ok(result)
    } else {
        state.0.tell_stopped(0, limit.unwrap_or(1000)).await
    }
}

/// Fetch only active tasks (no waiting).
#[tauri::command]
pub async fn aria2_fetch_active_task_list(
    state: State<'_, Aria2State>,
) -> Result<Vec<Aria2Task>, AppError> {
    state.0.tell_active().await
}

/// Fetch a single task's full status by GID.
#[tauri::command]
pub async fn aria2_fetch_task_item(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Aria2Task, AppError> {
    state.0.tell_status(&gid).await
}

/// Fetch task status with peer list (for BT tasks).
#[tauri::command]
pub async fn aria2_fetch_task_item_with_peers(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    let (task, peers) = tokio::try_join!(state.0.tell_status(&gid), state.0.get_peers(&gid),)?;
    let mut result =
        serde_json::to_value(&task).map_err(|e| AppError::Aria2(format!("serialize task: {e}")))?;
    result["peers"] = peers;
    Ok(result)
}

/// Get aria2 engine version and enabled features.
#[tauri::command]
pub async fn aria2_get_version(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_version().await
}

/// Get global aria2 options.
#[tauri::command]
pub async fn aria2_get_global_option(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_global_option().await
}

/// Get global download/upload statistics.
#[tauri::command]
pub async fn aria2_get_global_stat(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    let stat = state.0.get_global_stat().await?;
    serde_json::to_value(&stat).map_err(|e| AppError::Aria2(format!("serialize stat: {e}")))
}

/// Change global aria2 options at runtime.
#[tauri::command]
pub async fn aria2_change_global_option(
    state: State<'_, Aria2State>,
    options: serde_json::Map<String, serde_json::Value>,
) -> Result<String, AppError> {
    state.0.change_global_option(options).await
}

/// Get per-task options.
#[tauri::command]
pub async fn aria2_get_option(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_option(&gid).await
}

/// Change per-task options.
#[tauri::command]
pub async fn aria2_change_option(
    state: State<'_, Aria2State>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    state.0.change_option(&gid, options).await
}

/// Get file list for a task.
#[tauri::command]
pub async fn aria2_get_files(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Vec<Aria2File>, AppError> {
    state.0.get_files(&gid).await
}

// ── `out` option sanitization ────────────────────────────────────────

/// Extracts the bare filename from an `out` option value.
///
/// aria2's `out` option must be a plain filename relative to `dir`.
/// This is a **basename extraction** helper — it strips path components
/// (including Windows drive letters, UNC prefixes, and Unix absolute
/// paths) but does NOT perform full Windows filename sanitization
/// (reserved names, illegal characters).  Those are left to aria2's
/// own validation.
///
/// Returns `None` for values that reduce to empty, `.`, `..`, or
/// contain NUL bytes (which would truncate C strings inside aria2).
fn sanitize_out_option(raw: &str) -> Option<&str> {
    if raw.is_empty() {
        return None;
    }
    // Split on both separators to handle cross-platform paths.
    // rsplit + next always returns Some for non-empty input.
    let basename = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    if basename.is_empty() || basename == "." || basename == ".." {
        return None;
    }
    if basename.contains('\0') {
        return None;
    }
    Some(basename)
}

/// Add URI download(s). Each URI gets its own aria2 task with optional
/// per-URI `out` filename override and file-category directory resolution.
#[tauri::command]
pub async fn aria2_add_uri(
    state: State<'_, Aria2State>,
    uris: Vec<String>,
    mut options: serde_json::Value,
) -> Result<String, AppError> {
    // Enforce out = filename-only invariant before forwarding to aria2.
    // Prevents doubled paths when `out` accidentally contains an absolute
    // path (e.g., from session restore or unvalidated external input). (#261)
    if let Some(opts) = options.as_object_mut() {
        if let Some(out_val) = opts.get("out").and_then(|v| v.as_str()).map(String::from) {
            match sanitize_out_option(&out_val) {
                Some(clean) if clean != out_val => {
                    log::warn!(
                        "aria2:add-uri sanitized out: original_had_path=true clean={clean:?}"
                    );
                    opts.insert(
                        "out".to_string(),
                        serde_json::Value::String(clean.to_string()),
                    );
                }
                None => {
                    log::warn!("aria2:add-uri removed invalid out option");
                    opts.remove("out");
                }
                _ => {} // already a clean filename — no action needed
            }
        }
    }
    log::info!("aria2:add-uri count={}", uris.len());
    state.0.add_uri(uris, options).await
}

/// Add a torrent download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_torrent(
    state: State<'_, Aria2State>,
    torrent: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    log::info!("aria2:add-torrent");
    state.0.add_torrent(&torrent, options).await
}

/// Add a metalink download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_metalink(
    state: State<'_, Aria2State>,
    metalink: String,
    options: serde_json::Value,
) -> Result<Vec<String>, AppError> {
    log::info!("aria2:add-metalink");
    state.0.add_metalink(&metalink, options).await
}

/// Forcefully remove a task by GID.
#[tauri::command]
pub async fn aria2_force_remove(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::info!("aria2:remove gid={gid}");
    state.0.force_remove(&gid).await
}

/// Forcefully pause a task by GID.
#[tauri::command]
pub async fn aria2_force_pause(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:force-pause gid={gid}");
    state.0.force_pause(&gid).await
}

/// Gracefully pause a task.
#[tauri::command]
pub async fn aria2_pause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:pause gid={gid}");
    state.0.pause(&gid).await
}

/// Resume a paused task.
#[tauri::command]
pub async fn aria2_unpause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:resume gid={gid}");
    state.0.unpause(&gid).await
}

/// Pause all active downloads (graceful).
#[tauri::command]
pub async fn aria2_pause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.pause_all().await
}

/// Forcefully pause all active downloads.
#[tauri::command]
pub async fn aria2_force_pause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.force_pause_all().await
}

/// Resume all paused downloads.
#[tauri::command]
pub async fn aria2_unpause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.unpause_all().await
}

/// Save the current aria2 session to disk.
#[tauri::command]
pub async fn aria2_save_session(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.save_session().await
}

/// Remove a completed/errored task record from aria2's download list.
#[tauri::command]
pub async fn aria2_remove_download_result(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    state.0.remove_download_result(&gid).await
}

/// Purge all completed/errored download results.
#[tauri::command]
pub async fn aria2_purge_download_result(state: State<'_, Aria2State>) -> Result<String, AppError> {
    log::info!("aria2:purge-results");
    state.0.purge_download_result().await
}

/// Batch resume multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_unpause(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-resume count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| ("unpause".to_string(), vec![serde_json::Value::String(gid)]))
        .collect();
    state.0.multicall(calls).await
}

/// Batch force-pause multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_force_pause(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-pause count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| {
            (
                "forcePause".to_string(),
                vec![serde_json::Value::String(gid)],
            )
        })
        .collect();
    state.0.multicall(calls).await
}

/// Batch force-remove multiple tasks via multicall.
#[tauri::command]
pub async fn aria2_batch_force_remove(
    state: State<'_, Aria2State>,
    gids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    log::info!("aria2:batch-remove count={}", gids.len());
    let calls = gids
        .into_iter()
        .map(|gid| {
            (
                "forceRemove".to_string(),
                vec![serde_json::Value::String(gid)],
            )
        })
        .collect();
    state.0.multicall(calls).await
}

#[cfg(test)]
mod tests {
    use super::sanitize_out_option;

    #[test]
    fn bare_filename_passes_through() {
        assert_eq!(sanitize_out_option("file.zip"), Some("file.zip"));
    }

    #[test]
    fn windows_backslash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:\\Users\\u\\Downloads\\file.zip"),
            Some("file.zip")
        );
    }

    #[test]
    fn forward_slash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:/Users/u/Downloads/file.zip"),
            Some("file.zip")
        );
    }

    #[test]
    fn unc_path_extracts_basename() {
        assert_eq!(
            sanitize_out_option("\\\\server\\share\\file.zip"),
            Some("file.zip")
        );
    }

    // basename extraction: "../evil.exe" → "evil.exe".
    // This strips the traversal prefix; it is NOT a security path-join
    // guard — aria2 resolves the final path via applyDir(dir, out).
    #[test]
    fn parent_traversal_extracts_basename() {
        assert_eq!(sanitize_out_option("../evil.exe"), Some("evil.exe"));
    }

    #[test]
    fn dotdot_only_rejected() {
        assert_eq!(sanitize_out_option(".."), None);
    }

    #[test]
    fn dot_only_rejected() {
        assert_eq!(sanitize_out_option("."), None);
    }

    #[test]
    fn empty_rejected() {
        assert_eq!(sanitize_out_option(""), None);
    }

    #[test]
    fn nul_byte_rejected() {
        assert_eq!(sanitize_out_option("file\0.zip"), None);
    }

    #[test]
    fn cjk_filename_preserved() {
        assert_eq!(sanitize_out_option("C:/下载/文件.zip"), Some("文件.zip"));
    }

    #[test]
    fn trailing_separator_rejected() {
        assert_eq!(sanitize_out_option("path/to/"), None);
    }

    // Exact regression test for issue #261: category dir = Downloads/Programs,
    // out contained full base dir path → applyDir doubled it.
    #[test]
    fn issue_261_regression() {
        assert_eq!(
            sanitize_out_option("C:/Users/37472/Downloads/sysdiag-all-x64.exe"),
            Some("sysdiag-all-x64.exe")
        );
    }
}
