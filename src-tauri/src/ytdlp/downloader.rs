//! yt-dlp HLS/DASH fallback downloader.
//!
//! aria2 cannot download HLS (`m3u8`) or DASH (`http_dash_segments`) manifests
//! directly — each segment must be fetched and concatenated.  For those formats
//! we delegate to a long-lived `yt-dlp` sidecar process, parse its `--newline
//! --progress --progress-template` stdout, and emit typed progress events to
//! the frontend.
//!
//! ## Lifecycle
//!
//! 1. `start_download` spawns a sidecar, records its PID in [`YtdlpState`], and
//!    returns a generated `ytdlp-N` task id immediately.
//! 2. A background async task streams [`CommandEvent`] variants and emits
//!    `ytdlp-progress` events as lines are parsed.
//! 3. On termination, a final progress event with [`YtdlpTaskStatus::Complete`]
//!    (exit 0) or [`YtdlpTaskStatus::Error`] (non-zero) is emitted, and the PID
//!    is removed from the map.
//! 4. `cancel_download` looks up the PID, removes the entry, and sends a
//!    platform-appropriate kill signal.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use super::client::YtdlpHeaders;
use super::types::{YtdlpLog, YtdlpProgress, YtdlpTaskStatus};
use crate::history::HistoryDbState;
use crate::error::AppError;

/// Progress template passed to yt-dlp via `--progress-template`.
///
/// Produces whitespace-separated fields:
///   `<percent>%  <downloaded_bytes>  <total_bytes>  <speed>  <eta>`
///
/// `downloaded_bytes` and `total_bytes` are raw integers (no `_str` suffix) so
/// they can be parsed directly into `u64` without stripping unit suffixes like
/// `MiB`.
const PROGRESS_TEMPLATE: &str = "%(progress._percent_str)s %(progress.downloaded_bytes)d %(progress.total_bytes)d %(progress._speed_str)s %(progress._eta_str)s";

/// Managed Tauri state tracking active yt-dlp download processes.
///
/// Maps `task_id → PID`.  A counter provides monotonically increasing task ids
/// in the form `ytdlp-{boot_ts}-{N}` — the boot timestamp prefix prevents the
/// counter from colliding with yt-dlp history records written by earlier app
/// sessions, which would otherwise reuse the same gid and get
/// `INSERT OR CONFLICT` merged (preserving the stale `added_at`).
pub struct YtdlpState {
    /// PIDs of currently-running yt-dlp child processes, keyed by task id.
    processes: Arc<Mutex<HashMap<String, u32>>>,
    /// Counter used by [`generate_task_id`](Self::generate_task_id).
    next_id: Arc<AtomicU64>,
    /// Unix millisecond timestamp captured at state creation; prefixes every
    /// generated task id so gids never collide across app launches.
    boot_ts: u64,
}

impl Default for YtdlpState {
    fn default() -> Self {
        Self::new()
    }
}

impl YtdlpState {
    /// Creates a fresh state with an empty process map and the counter at 1.
    pub fn new() -> Self {
        let boot_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            boot_ts,
        }
    }

    /// Returns the next task id in the form `ytdlp-{boot_ts}-{N}`, incrementing
    /// the counter. The boot timestamp prevents cross-session gid collisions.
    pub fn generate_task_id(&self) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("ytdlp-{}-{}", self.boot_ts, id)
    }
}

/// Spawns `motrixnext-ytdlp` to download `url` at `format_id` into `output_path`.
///
/// Returns the generated task id immediately.  A background task monitors the
/// sidecar and emits `ytdlp-progress` events until the process terminates.
pub async fn start_download(
    app: tauri::AppHandle,
    state: &YtdlpState,
    url: String,
    format_id: String,
    output_path: String,
    headers: YtdlpHeaders,
) -> Result<String, AppError> {
    let task_id = state.generate_task_id();

    let mut args: Vec<String> = headers.resolve_args(&app, &url).await?;
    args.extend([
        "-f".to_string(),
        format_id,
        "--newline".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        PROGRESS_TEMPLATE.to_string(),
        "-o".to_string(),
        output_path,
        url,
    ]);

    log::info!("yt-dlp spawn args: {:?}", args);

    let sidecar = app
        .shell()
        .sidecar("motrixnext-ytdlp")
        .map_err(|e| AppError::YtdlpDownload(format!("failed to create sidecar: {e}")))?
        // Force UTF-8 stdout on Windows so progress logs and filename lines
        // with Chinese characters don't arrive as GBK garbage.
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .args(&args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| AppError::YtdlpDownload(format!("failed to spawn yt-dlp: {e}")))?;

    let pid = child.pid();
    log::info!("yt-dlp download started: task_id={task_id} pid={pid}");

    {
        let mut map = state.processes.lock().await;
        map.insert(task_id.clone(), pid);
    }

    let processes = Arc::clone(&state.processes);
    let task_id_for_monitor = task_id.clone();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        // Tracks the most recent filename yt-dlp announced via "[Merger]
        // Merging formats into ..." or "[download] Destination: ...".
        // Used on Terminated to align history.name with what's on disk.
        let mut last_filename: Option<String> = None;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    if let Some(name) = extract_destination(trimmed) {
                        last_filename = Some(name);
                    }

                    if let Some(progress) = parse_progress_line(trimmed, &task_id_for_monitor) {
                        if let Err(e) = app_handle.emit("ytdlp-progress", &progress) {
                            log::warn!("failed to emit ytdlp-progress: {e}");
                        }
                    } else {
                        // Non-progress lines (status messages, warnings) — surface
                        // them to the UI so the user knows what's happening when
                        // the progress bar is still at 0%.
                        let log_event = YtdlpLog {
                            task_id: task_id_for_monitor.clone(),
                            stream: "stdout".to_string(),
                            line: trimmed.to_string(),
                        };
                        let _ = app_handle.emit("ytdlp-log", &log_event);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    log::warn!("yt-dlp stderr [{task_id_for_monitor}]: {trimmed}");
                    let log_event = YtdlpLog {
                        task_id: task_id_for_monitor.clone(),
                        stream: "stderr".to_string(),
                        line: trimmed.to_string(),
                    };
                    let _ = app_handle.emit("ytdlp-log", &log_event);
                }
                CommandEvent::Terminated(payload) => {
                    let exit_code = payload.code.unwrap_or(-1);
                    log::info!(
                        "yt-dlp download terminated: task_id={task_id_for_monitor} exit={exit_code}"
                    );

                    let status = if exit_code == 0 {
                        YtdlpTaskStatus::Complete
                    } else {
                        YtdlpTaskStatus::Error
                    };

                    let final_progress = YtdlpProgress {
                        task_id: task_id_for_monitor.clone(),
                        status,
                        percent: if exit_code == 0 { 100.0 } else { 0.0 },
                        downloaded_bytes: None,
                        total_bytes: None,
                        speed: None,
                        eta: None,
                    };

                    if let Err(e) = app_handle.emit("ytdlp-progress", &final_progress) {
                        log::warn!("failed to emit final ytdlp-progress: {e}");
                    }

                    // Update the corresponding history record (no-op if
                    // ytdlp_download_direct didn't create one yet).
                    if let Some(history_state) = app_handle.try_state::<HistoryDbState>() {
                        let status_str = if exit_code == 0 { "complete" } else { "error" };
                        let completed_at = chrono::Utc::now().to_rfc3339();
                        if let Err(e) = history_state
                            .0
                            .update_status(&task_id_for_monitor, status_str, Some(&completed_at))
                            .await
                        {
                            log::warn!("failed to update ytdlp history status: {e}");
                        }

                        // Sync stored filename with what yt-dlp wrote so the UI's
                        // file-exists check resolves correctly. yt-dlp's own
                        // sanitization may differ from our pre-computed name.
                        if let Some(path) = last_filename.as_ref() {
                            if let Some(basename) = std::path::Path::new(path)
                                .file_name()
                                .and_then(|s| s.to_str())
                            {
                                if let Err(e) = history_state
                                    .0
                                    .update_name(&task_id_for_monitor, basename)
                                    .await
                                {
                                    log::warn!("failed to sync ytdlp filename: {e}");
                                }
                            }
                        }
                    }

                    let mut map = processes.lock().await;
                    map.remove(&task_id_for_monitor);
                    break;
                }
                _ => {}
            }
        }

        // Fallback cleanup: if the event channel was dropped (e.g. sidecar
        // killed abnormally) without us seeing a `Terminated` event, the
        // `while let` loop exits and the entry would otherwise leak forever.
        // `remove` on an absent key is a no-op, so this is safe even when the
        // `Terminated` branch already ran.
        {
            let mut map = processes.lock().await;
            if map.remove(&task_id_for_monitor).is_some() {
                log::warn!(
                    "yt-dlp monitor loop exited without Terminated event: task_id={task_id_for_monitor}"
                );
            }
        }
    });

    Ok(task_id)
}

/// Cancels an active yt-dlp download identified by `task_id`.
///
/// Looks up the PID in [`YtdlpState::processes`], sends a kill signal through
/// [`kill_pid`], and only removes the map entry on success.  Returns
/// [`AppError::NotFound`] if the task id is unknown, or
/// [`AppError::YtdlpDownload`] if the kill itself fails — in the failure case
/// the entry is preserved so the caller can retry.
pub async fn cancel_download(state: &YtdlpState, task_id: &str) -> Result<(), AppError> {
    let pid = {
        let map = state.processes.lock().await;
        map.get(task_id).copied()
    };

    match pid {
        Some(pid) => {
            kill_pid(pid)?;
            let mut map = state.processes.lock().await;
            map.remove(task_id);
            log::info!("yt-dlp download cancelled: task_id={task_id} pid={pid}");
            Ok(())
        }
        None => Err(AppError::NotFound(format!(
            "yt-dlp task not found: {task_id}"
        ))),
    }
}

/// Cross-platform process kill.
///
/// - Windows: `taskkill /PID {pid} /T /F` with `CREATE_NO_WINDOW` to suppress
///   the console flash.
/// - Unix: `kill -TERM {pid}` — yt-dlp handles `SIGTERM` by cleaning up
///   partial segments before exiting.
fn kill_pid(pid: u32) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| {
                AppError::YtdlpDownload(format!("failed to execute taskkill for PID {pid}: {e}"))
            })?;
        if status.success() {
            return Ok(());
        }
        Err(AppError::YtdlpDownload(format!(
            "taskkill failed for PID {pid}: {status}"
        )))
    }

    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| {
                AppError::YtdlpDownload(format!("failed to execute kill for PID {pid}: {e}"))
            })?;
        if status.success() {
            return Ok(());
        }
        Err(AppError::YtdlpDownload(format!(
            "kill failed for PID {pid}: {status}"
        )))
    }
}

/// Parses a single `yt-dlp --progress` stdout line into a [`YtdlpProgress`].
///
/// Template layout (fields split on whitespace):
///   `<percent>%  <downloaded_bytes>  <total_bytes>  <speed>  <eta>`
///
/// `downloaded_bytes` and `total_bytes` are raw `u64` integers coming from the
/// `%(progress.downloaded_bytes)d` / `%(progress.total_bytes)d` template
/// Extracts the on-disk destination path that yt-dlp announces in lines like:
///   `[download] Destination: /path/to/file.mp4`
///   `[Merger] Merging formats into "/path/to/file.mp4"`
///
/// Returns the path as written by yt-dlp (with whatever sanitization yt-dlp
/// applied to the title), or `None` if the line doesn't match either form.
fn extract_destination(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("[download] Destination:") {
        let s = rest.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    if let Some(rest) = trimmed.strip_prefix("[Merger] Merging formats into") {
        let s = rest.trim().trim_matches('"').trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    None
}

/// Parses a yt-dlp progress line emitted by `--progress-template`. Splits on
/// whitespace and reads percent / downloaded / total / speed / eta from fixed
/// fields.
///
/// Returns:
/// - `Some(YtdlpProgress { status: Merging, percent: 100.0, … })` for the
///   `[Merger]` / `"Merging"` line emitted when yt-dlp muxes video+audio.
/// - `None` for non-progress metadata lines (starting with `[`, or lacking
///   a `%` sign).
/// - `Some(YtdlpProgress { status: Downloading, … })` for normal progress
///   lines with a parseable percent.
fn parse_progress_line(line: &str, task_id: &str) -> Option<YtdlpProgress> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Merger line — yt-dlp is muxing downloaded streams.
    if trimmed.starts_with("[Merger]") || trimmed.contains("Merging") {
        return Some(YtdlpProgress {
            task_id: task_id.to_string(),
            status: YtdlpTaskStatus::Merging,
            percent: 100.0,
            downloaded_bytes: None,
            total_bytes: None,
            speed: None,
            eta: None,
        });
    }

    // Skip other yt-dlp log prefixes ("[download] …", "[youtube] …", etc.)
    // and any line without a percent marker.
    if trimmed.starts_with('[') || !trimmed.contains('%') {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    let percent = parts[0].trim_end_matches('%').parse::<f64>().ok()?;
    let downloaded_bytes = parts.get(1).and_then(|s| s.parse::<u64>().ok());
    let total_bytes = parts.get(2).and_then(|s| s.parse::<u64>().ok());
    let speed = parts.get(3).map(|s| (*s).to_string());
    let eta = parts.get(4).map(|s| (*s).to_string());

    Some(YtdlpProgress {
        task_id: task_id.to_string(),
        status: YtdlpTaskStatus::Downloading,
        percent,
        downloaded_bytes,
        total_bytes,
        speed,
        eta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percentage_line() {
        // Format: percent, downloaded_bytes (int), total_bytes (int), speed, eta
        let line = "45.2% 129394278 288164250 2.5MiB/s 00:32";
        let progress = parse_progress_line(line, "ytdlp-1")
            .expect("percentage progress line must parse");
        assert_eq!(progress.task_id, "ytdlp-1");
        assert_eq!(progress.status, YtdlpTaskStatus::Downloading);
        assert!(
            (progress.percent - 45.2).abs() < f64::EPSILON,
            "expected 45.2, got {}",
            progress.percent
        );
        assert_eq!(progress.downloaded_bytes, Some(129_394_278));
        assert_eq!(progress.total_bytes, Some(288_164_250));
        assert_eq!(progress.speed.as_deref(), Some("2.5MiB/s"));
        assert_eq!(progress.eta.as_deref(), Some("00:32"));
    }

    #[test]
    fn parse_merger_line() {
        let line = "[Merger] Merging formats into output.mkv";
        let progress =
            parse_progress_line(line, "ytdlp-2").expect("merger line must produce progress");
        assert_eq!(progress.status, YtdlpTaskStatus::Merging);
        assert!(
            (progress.percent - 100.0).abs() < f64::EPSILON,
            "merger should report 100%, got {}",
            progress.percent
        );
    }

    #[test]
    fn skip_download_prefix_line() {
        let line = "[download] Downloading video 1 of 5";
        assert!(
            parse_progress_line(line, "ytdlp-3").is_none(),
            "plain [download] metadata lines must not emit progress"
        );
    }

    #[test]
    fn skip_empty_line() {
        assert!(
            parse_progress_line("", "ytdlp-4").is_none(),
            "empty line must return None"
        );
    }

    #[test]
    fn parse_100_percent() {
        let line = "100.0% 524288000 524288000 10.0MiB/s 00:00";
        let progress = parse_progress_line(line, "ytdlp-5")
            .expect("100% line must parse as downloading progress");
        assert!(
            (progress.percent - 100.0).abs() < f64::EPSILON,
            "expected 100.0, got {}",
            progress.percent
        );
        assert_eq!(progress.status, YtdlpTaskStatus::Downloading);
        assert_eq!(progress.downloaded_bytes, Some(524_288_000));
        assert_eq!(progress.total_bytes, Some(524_288_000));
        assert_eq!(progress.speed.as_deref(), Some("10.0MiB/s"));
        assert_eq!(progress.eta.as_deref(), Some("00:00"));
    }

    #[test]
    fn state_generates_sequential_ids() {
        let state = YtdlpState::new();
        let id1 = state.generate_task_id();
        let id2 = state.generate_task_id();
        let id3 = state.generate_task_id();

        // Each id has the boot-ts prefix followed by a sequential counter.
        assert!(id1.starts_with("ytdlp-"), "unexpected format: {id1}");
        assert!(id2.starts_with("ytdlp-"), "unexpected format: {id2}");
        assert!(id3.starts_with("ytdlp-"), "unexpected format: {id3}");
        assert!(id1.ends_with("-1"), "expected counter=1 suffix: {id1}");
        assert!(id2.ends_with("-2"), "expected counter=2 suffix: {id2}");
        assert!(id3.ends_with("-3"), "expected counter=3 suffix: {id3}");

        // All ids share the same boot-ts prefix (same state instance).
        let prefix1 = id1.rsplit_once('-').unwrap().0;
        let prefix2 = id2.rsplit_once('-').unwrap().0;
        assert_eq!(prefix1, prefix2);
    }

    #[test]
    fn state_task_ids_differ_across_instances() {
        // Each state captures its own boot-ts so cross-session collisions
        // (previous app run reused counter 1) can't happen.
        let state_a = YtdlpState::new();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let state_b = YtdlpState::new();
        let id_a = state_a.generate_task_id();
        let id_b = state_b.generate_task_id();
        assert_ne!(id_a, id_b);
    }
}
