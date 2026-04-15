# yt-dlp Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate yt-dlp into Motrix Next so users can paste video URLs and automatically get video metadata, format selection, and playlist support — with aria2 handling direct downloads and yt-dlp handling HLS/DASH streams.

**Architecture:** yt-dlp runs as a Tauri sidecar (like aria2c). A new `ytdlp/` Rust module handles CLI invocation, JSON parsing, and long-lived download process management. The frontend auto-detects video URLs in the Add Task dialog and shows video-specific UI (format presets, playlist selection). Downloads go through aria2 when possible, with automatic fallback to yt-dlp for HLS/DASH content.

**Tech Stack:** Rust (Tauri v2, tokio, serde), TypeScript (Vue 3, Pinia, Naive UI), yt-dlp (sidecar binary)

---

## File Structure

### Rust Backend (new files)

| File | Responsibility |
|------|---------------|
| `src-tauri/src/ytdlp/mod.rs` | Module entry, re-exports |
| `src-tauri/src/ytdlp/types.rs` | Data structs: `VideoInfo`, `VideoFormat`, `ParseResult`, `PlaylistInfo`, `PlaylistItem`, `YtdlpProgress`, `YtdlpTaskStatus` |
| `src-tauri/src/ytdlp/client.rs` | yt-dlp CLI invocation: `parse_url()`, `parse_playlist_item()` with timeout |
| `src-tauri/src/ytdlp/downloader.rs` | HLS/DASH fallback download: process management, stdout progress parsing, `YtdlpState` |
| `src-tauri/src/commands/ytdlp.rs` | Tauri commands: `ytdlp_parse_url`, `ytdlp_download_via_aria2`, `ytdlp_download_direct`, `ytdlp_cancel_download` |

### Rust Backend (modified files)

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Add `mod ytdlp`, manage `YtdlpState`, register ytdlp commands |
| `src-tauri/src/error.rs` | Add `YtdlpParse`, `YtdlpDownload`, `YtdlpTimeout` variants |
| `src-tauri/src/commands/mod.rs` | Add `pub mod ytdlp` + `pub use ytdlp::*` |
| `src-tauri/tauri.conf.json` | Add `"binaries/motrixnext-ytdlp"` to `externalBin` |

### Frontend (new files)

| File | Responsibility |
|------|---------------|
| `src/api/ytdlp.ts` | Tauri invoke wrappers for all ytdlp commands |
| `src/composables/useVideoFlow.ts` | Video parsing orchestration, format preset generation, download submission |
| `src/components/task/VideoInfoPanel.vue` | Video metadata + format selection UI |
| `src/components/task/PlaylistPanel.vue` | Playlist item selection + batch download UI |

### Frontend (modified files)

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `VideoInfo`, `VideoFormat`, `ParseResult`, `PlaylistInfo`, `PlaylistItem`, `FormatPreset`, `YtdlpProgress` types |
| `src/components/task/AddTask.vue` | Integrate video detection on URL paste, show `VideoInfoPanel`/`PlaylistPanel` |
| `src/components/task/TaskItem.vue` | Show video metadata tags (extractor, resolution) for `task_type === 'video'` |

---

## Task 1: Rust — yt-dlp Data Types

**Files:**
- Create: `src-tauri/src/ytdlp/types.rs`
- Create: `src-tauri/src/ytdlp/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/ytdlp/types.rs`**

```rust
use serde::{Deserialize, Serialize};

/// yt-dlp `--dump-json` output — only the fields we consume.
/// Uses `#[serde(default)]` so missing keys get zero-values instead of errors.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    /// Original page URL (yt-dlp calls this `webpage_url`).
    #[serde(alias = "webpage_url")]
    pub url: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    /// Site identifier, e.g. "youtube", "BiliBili".
    #[serde(default)]
    pub extractor: String,
    #[serde(default)]
    pub formats: Vec<VideoFormat>,
    pub is_live: Option<bool>,
    pub playlist_index: Option<u32>,
}

/// A single available format from yt-dlp.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFormat {
    pub format_id: String,
    #[serde(default)]
    pub ext: String,
    pub resolution: Option<String>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    /// Total bitrate in kbps.
    pub tbr: Option<f64>,
    /// Direct download URL (may be absent for manifest-based formats).
    pub url: Option<String>,
    /// "https", "m3u8", "m3u8_native", "http_dash_segments", etc.
    #[serde(default)]
    pub protocol: String,
}

/// Result of parsing a URL with yt-dlp.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ParseResult {
    Video(VideoInfo),
    Playlist(PlaylistInfo),
    NotMedia,
}

/// Playlist metadata from `--flat-playlist`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub entries: Vec<PlaylistItem>,
}

/// Single entry within a playlist (from `--flat-playlist`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// yt-dlp uses `url` or `webpage_url` depending on extractor.
    #[serde(alias = "webpage_url")]
    pub url: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

/// Download progress parsed from yt-dlp stdout (`--newline --progress`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpProgress {
    pub task_id: String,
    pub status: YtdlpTaskStatus,
    pub percent: f64,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum YtdlpTaskStatus {
    Downloading,
    Merging,
    Complete,
    Error,
}

impl VideoFormat {
    /// Returns true when this format uses a streaming protocol that aria2
    /// cannot download directly (HLS, DASH, etc.).
    pub fn is_streaming(&self) -> bool {
        matches!(
            self.protocol.as_str(),
            "m3u8" | "m3u8_native" | "http_dash_segments" | "dash"
        )
    }
}
```

- [ ] **Step 2: Create `src-tauri/src/ytdlp/mod.rs`**

```rust
pub mod types;

pub use types::*;
```

- [ ] **Step 3: Wire up the module in `src-tauri/src/lib.rs`**

Add `mod ytdlp;` to the module declarations at the top of `src-tauri/src/lib.rs` (after line 6, alongside the other `mod` statements):

```rust
mod ytdlp;
```

- [ ] **Step 4: Run `cargo check` to verify compilation**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors (warnings about unused code are fine at this stage)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ytdlp/types.rs src-tauri/src/ytdlp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(ytdlp): add yt-dlp data types and module scaffold"
```

---

## Task 2: Rust — AppError Variants

**Files:**
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1: Write failing test for new error variants**

Add to the bottom of the `#[cfg(test)] mod tests` block in `src-tauri/src/error.rs`:

```rust
    #[test]
    fn display_ytdlp_parse_error() {
        let e = AppError::YtdlpParse("unsupported URL".into());
        assert_eq!(e.to_string(), "yt-dlp parse error: unsupported URL");
    }

    #[test]
    fn display_ytdlp_download_error() {
        let e = AppError::YtdlpDownload("connection reset".into());
        assert_eq!(e.to_string(), "yt-dlp download error: connection reset");
    }

    #[test]
    fn display_ytdlp_timeout_error() {
        let e = AppError::YtdlpTimeout;
        assert_eq!(e.to_string(), "yt-dlp parse timed out");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib error::tests`
Expected: FAIL — variants do not exist yet

- [ ] **Step 3: Add the new variants to AppError**

In `src-tauri/src/error.rs`, add three new variants to the `AppError` enum (after the `Database` variant, before the closing `}`):

```rust
    /// yt-dlp URL parse / metadata extraction failure.
    #[error("yt-dlp parse error: {0}")]
    YtdlpParse(String),
    /// yt-dlp direct download failure (HLS/DASH fallback).
    #[error("yt-dlp download error: {0}")]
    YtdlpDownload(String),
    /// yt-dlp parse operation timed out.
    #[error("yt-dlp parse timed out")]
    YtdlpTimeout,
```

Also update the `serialize_all_variants_are_tagged` test to include the new variants:

```rust
            ("YtdlpParse", AppError::YtdlpParse("y".into())),
            ("YtdlpDownload", AppError::YtdlpDownload("d".into())),
            ("YtdlpTimeout", AppError::YtdlpTimeout),
```

Note: `YtdlpTimeout` has no inner string, so the assertion format differs — the existing test checks `json.starts_with(&format!("{{\"{tag}\""))` which will match `{"YtdlpTimeout":null}` via the `"YtdlpTimeout"` prefix. If the test fails for this variant because serde serializes unit variants differently, adjust the `YtdlpTimeout` assertion to check for `"YtdlpTimeout"` substring instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib error::tests`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "feat(ytdlp): add YtdlpParse, YtdlpDownload, YtdlpTimeout error variants"
```

---

## Task 3: Rust — yt-dlp CLI Client

**Files:**
- Create: `src-tauri/src/ytdlp/client.rs`
- Modify: `src-tauri/src/ytdlp/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/ytdlp/client.rs`**

This module invokes the yt-dlp sidecar for URL parsing. It follows the same `app.shell().sidecar()` pattern as `engine/lifecycle.rs`.

```rust
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use crate::error::AppError;
use super::types::{ParseResult, PlaylistInfo, PlaylistItem, VideoInfo};

const PARSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Invokes yt-dlp with the given args, collects stdout, and returns it as a String.
/// Kills the process if it exceeds the timeout.
async fn run_ytdlp(app: &tauri::AppHandle, args: &[&str]) -> Result<String, AppError> {
    let sidecar = app
        .shell()
        .sidecar("motrixnext-ytdlp")
        .map_err(|e| AppError::YtdlpParse(format!("failed to create sidecar: {e}")))?
        .args(args);

    let output = tokio::time::timeout(PARSE_TIMEOUT, sidecar.output())
        .await
        .map_err(|_| AppError::YtdlpTimeout)?
        .map_err(|e| AppError::YtdlpParse(format!("failed to run yt-dlp: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::YtdlpParse(stderr.trim().to_string()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parses a URL to determine if it's a video, playlist, or non-media content.
///
/// Uses `--dump-json --no-download`. For playlists, uses `--flat-playlist` to
/// quickly get the entry list without resolving each video.
pub async fn parse_url(app: &tauri::AppHandle, url: &str) -> Result<ParseResult, AppError> {
    let stdout = run_ytdlp(
        app,
        &["--dump-json", "--no-download", "--flat-playlist", url],
    )
    .await?;

    // yt-dlp outputs one JSON object per line.
    // Single video: 1 line. Playlist with --flat-playlist: 1 line per entry.
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();

    if lines.is_empty() {
        return Ok(ParseResult::NotMedia);
    }

    // Try parsing the first line to check for playlist type
    let first: serde_json::Value =
        serde_json::from_str(lines[0]).map_err(|e| AppError::YtdlpParse(e.to_string()))?;

    // yt-dlp includes `_type: "playlist"` at the top level for playlists.
    // With --flat-playlist + --dump-json, playlists produce a single JSON
    // with `entries` array, while single videos produce a flat object.
    if first.get("_type").and_then(|v| v.as_str()) == Some("playlist") {
        let playlist_id = first["id"].as_str().unwrap_or("unknown").to_string();
        let playlist_title = first["title"].as_str().unwrap_or("Untitled Playlist").to_string();
        let uploader = first["uploader"].as_str().map(String::from);

        let entries: Vec<PlaylistItem> = if let Some(arr) = first.get("entries").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|e| serde_json::from_value(e.clone()).ok())
                .collect()
        } else {
            vec![]
        };

        return Ok(ParseResult::Playlist(PlaylistInfo {
            id: playlist_id,
            title: playlist_title,
            uploader,
            entries,
        }));
    }

    // Single video — parse the full VideoInfo
    if lines.len() == 1 {
        let video: VideoInfo =
            serde_json::from_str(lines[0]).map_err(|e| AppError::YtdlpParse(e.to_string()))?;
        return Ok(ParseResult::Video(video));
    }

    // Multiple lines without playlist _type — treat as non-media
    Ok(ParseResult::NotMedia)
}

/// Parses a single playlist item URL to get its full VideoInfo with formats.
pub async fn parse_playlist_item(
    app: &tauri::AppHandle,
    url: &str,
) -> Result<VideoInfo, AppError> {
    let stdout = run_ytdlp(app, &["--dump-json", "--no-download", url]).await?;

    let first_line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| AppError::YtdlpParse("empty output".into()))?;

    serde_json::from_str(first_line).map_err(|e| AppError::YtdlpParse(e.to_string()))
}
```

- [ ] **Step 2: Update `src-tauri/src/ytdlp/mod.rs`**

```rust
pub mod client;
pub mod types;

pub use types::*;
```

- [ ] **Step 3: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ytdlp/client.rs src-tauri/src/ytdlp/mod.rs
git commit -m "feat(ytdlp): add yt-dlp CLI client for URL parsing"
```

---

## Task 4: Rust — HLS/DASH Fallback Downloader

**Files:**
- Create: `src-tauri/src/ytdlp/downloader.rs`
- Modify: `src-tauri/src/ytdlp/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/ytdlp/downloader.rs`**

Manages long-lived yt-dlp download processes for HLS/DASH content. Parses progress from stdout and emits events to the frontend.

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::error::AppError;
use super::types::{YtdlpProgress, YtdlpTaskStatus};

/// Managed state for active yt-dlp download processes.
pub struct YtdlpState {
    /// Active download process PIDs, keyed by task_id.
    processes: Arc<Mutex<HashMap<String, u32>>>,
    /// Counter for generating unique task IDs.
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

impl YtdlpState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        }
    }

    pub fn generate_task_id(&self) -> String {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("ytdlp-{id}")
    }
}

/// Starts a yt-dlp download process and monitors its progress.
///
/// Returns a task_id that can be used to cancel the download.
pub async fn start_download(
    app: &tauri::AppHandle,
    state: &YtdlpState,
    url: &str,
    format_id: &str,
    output_path: &str,
) -> Result<String, AppError> {
    let task_id = state.generate_task_id();

    let sidecar = app
        .shell()
        .sidecar("motrixnext-ytdlp")
        .map_err(|e| AppError::YtdlpDownload(format!("failed to create sidecar: {e}")))?
        .args(&[
            "-f",
            format_id,
            "--newline",
            "--progress",
            "--progress-template",
            "%(progress._percent_str)s %(progress._downloaded_bytes_str)s %(progress._total_bytes_str)s %(progress._speed_str)s %(progress._eta_str)s",
            "-o",
            output_path,
            url,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| AppError::YtdlpDownload(format!("failed to spawn yt-dlp: {e}")))?;

    let pid = child.pid();
    log::info!("ytdlp download started: task_id={task_id}, pid={pid}");

    {
        let mut procs = state.processes.lock().await;
        procs.insert(task_id.clone(), pid);
    }

    let app_handle = app.clone();
    let tid = task_id.clone();
    let processes = state.processes.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(progress) = parse_progress_line(trimmed, &tid) {
                        let _ = app_handle.emit("ytdlp-progress", &progress);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        log::warn!("ytdlp stderr [{}]: {}", tid, trimmed);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let exit_code = payload.code.unwrap_or(-1);
                    log::info!("ytdlp process terminated: task_id={tid}, exit_code={exit_code}");

                    let status = if exit_code == 0 {
                        YtdlpTaskStatus::Complete
                    } else {
                        YtdlpTaskStatus::Error
                    };

                    let progress = YtdlpProgress {
                        task_id: tid.clone(),
                        status,
                        percent: if exit_code == 0 { 100.0 } else { 0.0 },
                        downloaded_bytes: None,
                        total_bytes: None,
                        speed: None,
                        eta: None,
                    };
                    let _ = app_handle.emit("ytdlp-progress", &progress);

                    let mut procs = processes.lock().await;
                    procs.remove(&tid);
                }
                _ => {}
            }
        }
    });

    Ok(task_id)
}

/// Cancels an active yt-dlp download by killing its process.
pub async fn cancel_download(state: &YtdlpState, task_id: &str) -> Result<(), AppError> {
    let mut procs = state.processes.lock().await;
    if let Some(pid) = procs.remove(task_id) {
        kill_pid(pid)?;
        log::info!("ytdlp download cancelled: task_id={task_id}, pid={pid}");
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "no active ytdlp download with task_id: {task_id}"
        )))
    }
}

fn kill_pid(pid: u32) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| AppError::YtdlpDownload(format!("taskkill failed: {e}")))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| AppError::YtdlpDownload(format!("kill failed: {e}")))?;
    }
    Ok(())
}

/// Parses a yt-dlp progress line.
///
/// Expected format (from --progress-template):
/// "  45.2%  123.4MiB  274.8MiB  2.5MiB/s  00:32"
fn parse_progress_line(line: &str, task_id: &str) -> Option<YtdlpProgress> {
    // yt-dlp also prints "[download]", "[Merger]" prefixed lines
    if line.starts_with("[Merger]") || line.contains("Merging") {
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

    // Skip non-progress lines
    if line.starts_with('[') || !line.contains('%') {
        return None;
    }

    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    let percent = parts[0].trim_end_matches('%').parse::<f64>().ok()?;
    let speed = parts.get(3).map(|s| s.to_string());
    let eta = parts.get(4).map(|s| s.to_string());

    Some(YtdlpProgress {
        task_id: task_id.to_string(),
        status: YtdlpTaskStatus::Downloading,
        percent,
        downloaded_bytes: None,
        total_bytes: None,
        speed,
        eta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_percentage_line() {
        let line = "  45.2%  123.4MiB  274.8MiB  2.5MiB/s  00:32";
        let p = parse_progress_line(line, "ytdlp-1").unwrap();
        assert_eq!(p.percent, 45.2);
        assert_eq!(p.speed, Some("2.5MiB/s".to_string()));
        assert_eq!(p.eta, Some("00:32".to_string()));
        assert_eq!(p.status, YtdlpTaskStatus::Downloading);
    }

    #[test]
    fn parse_merger_line() {
        let line = "[Merger] Merging formats into output.mkv";
        let p = parse_progress_line(line, "ytdlp-1").unwrap();
        assert_eq!(p.status, YtdlpTaskStatus::Merging);
    }

    #[test]
    fn skip_download_prefix_line() {
        let line = "[download] Downloading video 1 of 5";
        assert!(parse_progress_line(line, "ytdlp-1").is_none());
    }

    #[test]
    fn skip_empty_line() {
        assert!(parse_progress_line("", "ytdlp-1").is_none());
    }

    #[test]
    fn parse_100_percent() {
        let line = "100.0%  500.0MiB  500.0MiB  10.0MiB/s  00:00";
        let p = parse_progress_line(line, "ytdlp-2").unwrap();
        assert_eq!(p.percent, 100.0);
    }
}
```

- [ ] **Step 2: Update `src-tauri/src/ytdlp/mod.rs`**

```rust
pub mod client;
pub mod downloader;
pub mod types;

pub use downloader::YtdlpState;
pub use types::*;
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib ytdlp::downloader::tests`
Expected: all 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ytdlp/downloader.rs src-tauri/src/ytdlp/mod.rs
git commit -m "feat(ytdlp): add HLS/DASH fallback downloader with progress parsing"
```

---

## Task 5: Rust — Tauri Commands

**Files:**
- Create: `src-tauri/src/commands/ytdlp.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Create `src-tauri/src/commands/ytdlp.rs`**

```rust
use tauri::State;

use crate::aria2::Aria2State;
use crate::error::AppError;
use crate::ytdlp;
use crate::ytdlp::{ParseResult, YtdlpState};

/// Parses a URL with yt-dlp to detect video/playlist content.
#[tauri::command]
pub async fn ytdlp_parse_url(
    app: tauri::AppHandle,
    url: String,
) -> Result<ParseResult, AppError> {
    ytdlp::client::parse_url(&app, &url).await
}

/// Downloads a video via aria2 (for direct-link formats).
///
/// yt-dlp resolves the format to a direct URL, then we pass it to aria2
/// with appropriate headers (Referer, User-Agent) for anti-hotlink protection.
#[tauri::command]
pub async fn ytdlp_download_via_aria2(
    app: tauri::AppHandle,
    aria2: State<'_, Aria2State>,
    url: String,
    format_id: String,
    dir: String,
) -> Result<String, AppError> {
    // First, resolve the format to get the direct URL and required headers
    let video = ytdlp::client::parse_playlist_item(&app, &url).await?;

    let format = video
        .formats
        .iter()
        .find(|f| f.format_id == format_id)
        .ok_or_else(|| {
            AppError::YtdlpParse(format!("format '{format_id}' not found in video"))
        })?;

    let direct_url = format
        .url
        .as_ref()
        .ok_or_else(|| {
            AppError::YtdlpParse("selected format has no direct download URL".into())
        })?;

    // Build aria2 options with video-specific headers
    let mut opts = serde_json::json!({
        "dir": dir,
        "out": sanitize_filename(&video.title, &format.ext),
    });

    // Add Referer header to prevent hotlink blocking
    if let Some(obj) = opts.as_object_mut() {
        obj.insert("referer".to_string(), serde_json::json!(url));
    }

    let gid = aria2.0.add_uri(vec![direct_url.clone()], opts).await?;
    Ok(gid)
}

/// Downloads a video directly with yt-dlp (HLS/DASH fallback).
#[tauri::command]
pub async fn ytdlp_download_direct(
    app: tauri::AppHandle,
    state: State<'_, YtdlpState>,
    url: String,
    format_id: String,
    dir: String,
) -> Result<String, AppError> {
    // Resolve the video title for the output filename
    let video = ytdlp::client::parse_playlist_item(&app, &url).await?;
    let format = video
        .formats
        .iter()
        .find(|f| f.format_id == format_id);
    let ext = format.map(|f| f.ext.as_str()).unwrap_or("mp4");
    let filename = sanitize_filename(&video.title, ext);
    let output_path = std::path::Path::new(&dir).join(&filename);
    let output_str = output_path.to_string_lossy().to_string();

    ytdlp::downloader::start_download(&app, &state, &url, &format_id, &output_str).await
}

/// Cancels an active yt-dlp direct download.
#[tauri::command]
pub async fn ytdlp_cancel_download(
    state: State<'_, YtdlpState>,
    task_id: String,
) -> Result<(), AppError> {
    ytdlp::downloader::cancel_download(&state, &task_id).await
}

/// Sanitizes a video title into a safe filename.
fn sanitize_filename(title: &str, ext: &str) -> String {
    let safe: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = safe.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        format!("video.{ext}")
    } else {
        format!("{trimmed}.{ext}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_basic_title() {
        assert_eq!(
            sanitize_filename("My Video Title", "mp4"),
            "My Video Title.mp4"
        );
    }

    #[test]
    fn sanitize_special_chars() {
        assert_eq!(
            sanitize_filename("Video: The \"Best\" <One>", "mkv"),
            "Video_ The _Best_ _One_.mkv"
        );
    }

    #[test]
    fn sanitize_empty_title() {
        assert_eq!(sanitize_filename("", "mp4"), "video.mp4");
    }

    #[test]
    fn sanitize_path_separators() {
        assert_eq!(
            sanitize_filename("folder/sub\\file", "webm"),
            "folder_sub_file.webm"
        );
    }
}
```

- [ ] **Step 2: Add `ytdlp` to `src-tauri/src/commands/mod.rs`**

Add after line 8 (`pub mod history;`):

```rust
pub mod ytdlp;
```

And add after line 21 (`pub use history::*;`):

```rust
pub use ytdlp::*;
```

- [ ] **Step 3: Register YtdlpState and commands in `src-tauri/src/lib.rs`**

Add the `YtdlpState` import near the top of `lib.rs` (around line 23, alongside the `EngineState` use):

```rust
use ytdlp::YtdlpState;
```

In the builder chain (around line 664), add `.manage(YtdlpState::new())` after the existing `.manage()` calls:

```rust
        .manage(YtdlpState::new())
```

In the `invoke_handler(tauri::generate_handler![...])` block, add the new commands (after `commands::wait_for_engine,`):

```rust
            commands::ytdlp_parse_url,
            commands::ytdlp_download_via_aria2,
            commands::ytdlp_download_direct,
            commands::ytdlp_cancel_download,
```

- [ ] **Step 4: Add yt-dlp sidecar to `src-tauri/tauri.conf.json`**

Change `externalBin` from:

```json
"externalBin": [
  "binaries/motrixnext-aria2c"
],
```

To:

```json
"externalBin": [
  "binaries/motrixnext-aria2c",
  "binaries/motrixnext-ytdlp"
],
```

- [ ] **Step 5: Run tests and check compilation**

Run: `cd src-tauri && cargo test --lib commands::ytdlp::tests && cargo check`
Expected: 4 tests PASS, compilation succeeds

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/ytdlp.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat(ytdlp): add Tauri commands and register sidecar"
```

---

## Task 6: Frontend — TypeScript Types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add video-related types to the bottom of `src/shared/types.ts`**

Append before the closing of the file (before line 419):

```typescript
// ── yt-dlp types ───────────────────────────────────────────────────

export interface VideoFormat {
  formatId: string
  ext: string
  resolution?: string
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number
  filesizeApprox?: number
  tbr?: number
  url?: string
  protocol: string
}

export interface VideoInfo {
  id: string
  title: string
  url: string
  thumbnail?: string
  duration?: number
  uploader?: string
  extractor: string
  formats: VideoFormat[]
  isLive?: boolean
  playlistIndex?: number
}

export interface PlaylistItem {
  id: string
  title: string
  url: string
  duration?: number
  thumbnail?: string
}

export interface PlaylistInfo {
  id: string
  title: string
  uploader?: string
  entries: PlaylistItem[]
}

export type ParseResultType = 'Video' | 'Playlist' | 'NotMedia'

export type ParseResult =
  | { type: 'Video' } & VideoInfo
  | { type: 'Playlist' } & PlaylistInfo
  | { type: 'NotMedia' }

export interface FormatPreset {
  label: string
  formatId: string
  estimatedSize?: number
}

export type YtdlpTaskStatus = 'Downloading' | 'Merging' | 'Complete' | 'Error'

export interface YtdlpProgress {
  taskId: string
  status: YtdlpTaskStatus
  percent: number
  downloadedBytes?: number
  totalBytes?: number
  speed?: string
  eta?: string
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `pnpm type-check` (or `npx vue-tsc --noEmit`)
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(ytdlp): add frontend TypeScript types for video parsing"
```

---

## Task 7: Frontend — API Layer

**Files:**
- Create: `src/api/ytdlp.ts`

- [ ] **Step 1: Create `src/api/ytdlp.ts`**

Follow the same pattern as `src/api/aria2.ts` — thin invoke wrappers.

```typescript
import { invoke } from '@tauri-apps/api/core'
import type { ParseResult, YtdlpProgress } from '@shared/types'
import { listen } from '@tauri-apps/api/event'

/** Parses a URL with yt-dlp to detect video/playlist content. */
export async function parseUrl(url: string): Promise<ParseResult> {
  return invoke<ParseResult>('ytdlp_parse_url', { url })
}

/** Downloads a video through aria2 (direct-link formats). */
export async function downloadViaAria2(params: {
  url: string
  formatId: string
  dir: string
}): Promise<string> {
  return invoke<string>('ytdlp_download_via_aria2', params)
}

/** Downloads a video directly with yt-dlp (HLS/DASH fallback). */
export async function downloadDirect(params: {
  url: string
  formatId: string
  dir: string
}): Promise<string> {
  return invoke<string>('ytdlp_download_direct', params)
}

/** Cancels an active yt-dlp direct download. */
export async function cancelDownload(taskId: string): Promise<void> {
  return invoke<void>('ytdlp_cancel_download', { taskId })
}

/** Subscribes to yt-dlp download progress events. Returns an unlisten function. */
export async function onProgress(
  callback: (progress: YtdlpProgress) => void,
): Promise<() => void> {
  return listen<YtdlpProgress>('ytdlp-progress', (event) => {
    callback(event.payload)
  })
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm type-check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/api/ytdlp.ts
git commit -m "feat(ytdlp): add frontend API layer for yt-dlp commands"
```

---

## Task 8: Frontend — useVideoFlow Composable

**Files:**
- Create: `src/composables/useVideoFlow.ts`

- [ ] **Step 1: Create `src/composables/useVideoFlow.ts`**

This composable orchestrates the video detection, format selection, and download submission flow.

```typescript
import { ref, computed } from 'vue'
import type {
  ParseResult,
  VideoInfo,
  VideoFormat,
  PlaylistInfo,
  FormatPreset,
} from '@shared/types'
import * as ytdlpApi from '@/api/ytdlp'

export function useVideoFlow() {
  const isParsing = ref(false)
  const parseResult = ref<ParseResult | null>(null)
  const parseError = ref<string | null>(null)

  /** Selected format ID for single video download */
  const selectedFormatId = ref<string>('')

  /** Selected playlist item indices for batch download */
  const selectedPlaylistItems = ref<Set<number>>(new Set())

  /** Whether to show the full format list (vs presets only) */
  const showAllFormats = ref(false)

  const isVideo = computed(() => parseResult.value?.type === 'Video')
  const isPlaylist = computed(() => parseResult.value?.type === 'Playlist')
  const isNotMedia = computed(() => parseResult.value === null || parseResult.value?.type === 'NotMedia')

  const videoInfo = computed<VideoInfo | null>(() => {
    if (parseResult.value?.type === 'Video') {
      return parseResult.value as unknown as VideoInfo
    }
    return null
  })

  const playlistInfo = computed<PlaylistInfo | null>(() => {
    if (parseResult.value?.type === 'Playlist') {
      return parseResult.value as unknown as PlaylistInfo
    }
    return null
  })

  /** Generates simplified format presets from the full format list. */
  const formatPresets = computed<FormatPreset[]>(() => {
    const info = videoInfo.value
    if (!info) return []

    const formats = info.formats.filter((f) => f.vcodec && f.vcodec !== 'none')
    const presets: FormatPreset[] = []

    // Best quality
    const best = formats[formats.length - 1]
    if (best) {
      presets.push({
        label: '最高画质',
        formatId: 'bestvideo+bestaudio/best',
        estimatedSize: best.filesize ?? best.filesizeApprox,
      })
    }

    // 1080p
    const f1080 = formats.find((f) => f.height === 1080)
    if (f1080) {
      presets.push({
        label: '1080p',
        formatId: f1080.formatId,
        estimatedSize: f1080.filesize ?? f1080.filesizeApprox,
      })
    }

    // 720p
    const f720 = formats.find((f) => f.height === 720)
    if (f720) {
      presets.push({
        label: '720p',
        formatId: f720.formatId,
        estimatedSize: f720.filesize ?? f720.filesizeApprox,
      })
    }

    // Audio only
    const audioOnly = info.formats.find(
      (f) => (f.vcodec === 'none' || !f.vcodec) && f.acodec && f.acodec !== 'none',
    )
    if (audioOnly) {
      presets.push({
        label: '仅音频',
        formatId: 'bestaudio/best',
        estimatedSize: audioOnly.filesize ?? audioOnly.filesizeApprox,
      })
    }

    return presets
  })

  /** Attempts to parse a URL. Returns true if it's a video/playlist. */
  async function tryParseUrl(url: string): Promise<boolean> {
    if (!url.trim()) return false

    isParsing.value = true
    parseError.value = null
    parseResult.value = null
    selectedFormatId.value = ''
    selectedPlaylistItems.value = new Set()
    showAllFormats.value = false

    try {
      const result = await ytdlpApi.parseUrl(url)
      parseResult.value = result

      if (result.type === 'Video') {
        // Auto-select best quality by default
        selectedFormatId.value = 'bestvideo+bestaudio/best'
        return true
      }
      if (result.type === 'Playlist') {
        // Select all items by default
        const pl = result as unknown as PlaylistInfo
        selectedPlaylistItems.value = new Set(pl.entries.map((_, i) => i))
        return true
      }
      return false
    } catch (err: unknown) {
      // Silent fallback — non-video URLs should just go through aria2
      parseResult.value = { type: 'NotMedia' }
      return false
    } finally {
      isParsing.value = false
    }
  }

  /** Determines whether the selected format needs yt-dlp direct download. */
  function needsDirectDownload(formatId: string): boolean {
    const info = videoInfo.value
    if (!info) return false

    // Composite format IDs like "bestvideo+bestaudio/best" always need yt-dlp
    if (formatId.includes('+') || formatId.includes('/')) return true

    const format = info.formats.find((f) => f.formatId === formatId)
    return format ? format.protocol !== 'https' && format.protocol !== 'http' : true
  }

  /** Submits a single video download. */
  async function submitVideoDownload(dir: string): Promise<string> {
    const fmtId = selectedFormatId.value
    const info = videoInfo.value
    if (!info) throw new Error('no video info')

    if (needsDirectDownload(fmtId)) {
      return ytdlpApi.downloadDirect({ url: info.url, formatId: fmtId, dir })
    } else {
      return ytdlpApi.downloadViaAria2({ url: info.url, formatId: fmtId, dir })
    }
  }

  /** Resets all video flow state. */
  function reset() {
    isParsing.value = false
    parseResult.value = null
    parseError.value = null
    selectedFormatId.value = ''
    selectedPlaylistItems.value = new Set()
    showAllFormats.value = false
  }

  /** Toggles selection of a playlist item by index. */
  function togglePlaylistItem(index: number) {
    const items = new Set(selectedPlaylistItems.value)
    if (items.has(index)) {
      items.delete(index)
    } else {
      items.add(index)
    }
    selectedPlaylistItems.value = items
  }

  /** Selects or deselects all playlist items. */
  function toggleSelectAll() {
    const pl = playlistInfo.value
    if (!pl) return
    if (selectedPlaylistItems.value.size === pl.entries.length) {
      selectedPlaylistItems.value = new Set()
    } else {
      selectedPlaylistItems.value = new Set(pl.entries.map((_, i) => i))
    }
  }

  return {
    isParsing,
    parseResult,
    parseError,
    selectedFormatId,
    selectedPlaylistItems,
    showAllFormats,
    isVideo,
    isPlaylist,
    isNotMedia,
    videoInfo,
    playlistInfo,
    formatPresets,
    tryParseUrl,
    needsDirectDownload,
    submitVideoDownload,
    reset,
    togglePlaylistItem,
    toggleSelectAll,
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm type-check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/composables/useVideoFlow.ts
git commit -m "feat(ytdlp): add useVideoFlow composable for video detection and download"
```

---

## Task 9: Frontend — VideoInfoPanel Component

**Files:**
- Create: `src/components/task/VideoInfoPanel.vue`

- [ ] **Step 1: Create `src/components/task/VideoInfoPanel.vue`**

Displays video metadata and format selection. Uses Naive UI components consistent with existing UI.

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NImage, NTag, NSpace, NButton, NRadioGroup, NRadio, NDataTable } from 'naive-ui'
import type { VideoInfo, VideoFormat, FormatPreset } from '@shared/types'

const props = defineProps<{
  video: VideoInfo
  presets: FormatPreset[]
  selectedFormatId: string
  showAllFormats: boolean
}>()

const emit = defineEmits<{
  'update:selectedFormatId': [id: string]
  'update:showAllFormats': [show: boolean]
}>()

function formatDuration(seconds?: number): string {
  if (!seconds) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const videoFormats = computed(() =>
  props.video.formats.filter(
    (f) => f.vcodec && f.vcodec !== 'none',
  ),
)

const formatTableColumns = [
  { title: '分辨率', key: 'resolution', width: 100, render: (row: VideoFormat) => row.resolution || '-' },
  { title: '扩展名', key: 'ext', width: 70 },
  { title: '编码', key: 'vcodec', width: 100, render: (row: VideoFormat) => row.vcodec || '-' },
  { title: '大小', key: 'filesize', width: 100, render: (row: VideoFormat) => formatFileSize(row.filesize ?? row.filesizeApprox) },
  { title: '协议', key: 'protocol', width: 80 },
]
</script>

<template>
  <div class="video-info-panel">
    <!-- Video Summary -->
    <div class="video-summary">
      <NImage
        v-if="video.thumbnail"
        :src="video.thumbnail"
        :width="160"
        object-fit="cover"
        preview-disabled
        class="video-thumbnail"
      />
      <div class="video-meta">
        <div class="video-title">{{ video.title }}</div>
        <NSpace size="small">
          <NTag size="small" :bordered="false" type="info">{{ video.extractor }}</NTag>
          <NTag v-if="video.duration" size="small" :bordered="false">{{ formatDuration(video.duration) }}</NTag>
          <NTag v-if="video.uploader" size="small" :bordered="false">{{ video.uploader }}</NTag>
          <NTag v-if="video.isLive" size="small" :bordered="false" type="error">直播</NTag>
        </NSpace>
      </div>
    </div>

    <!-- Live stream warning -->
    <div v-if="video.isLive" class="live-warning">
      暂不支持直播下载
    </div>

    <!-- Format Presets -->
    <template v-else>
      <div class="format-section">
        <div class="section-label">选择格式</div>
        <NRadioGroup
          :value="selectedFormatId"
          @update:value="(v: string) => emit('update:selectedFormatId', v)"
        >
          <NSpace>
            <NRadio
              v-for="preset in presets"
              :key="preset.formatId"
              :value="preset.formatId"
            >
              {{ preset.label }}
              <span v-if="preset.estimatedSize" class="preset-size">
                (~{{ formatFileSize(preset.estimatedSize) }})
              </span>
            </NRadio>
          </NSpace>
        </NRadioGroup>
      </div>

      <!-- Expand full format list -->
      <NButton
        text
        type="primary"
        size="small"
        @click="emit('update:showAllFormats', !showAllFormats)"
      >
        {{ showAllFormats ? '收起格式列表 ▲' : '显示全部格式 ▼' }}
      </NButton>

      <NDataTable
        v-if="showAllFormats"
        :columns="formatTableColumns"
        :data="videoFormats"
        :max-height="200"
        size="small"
        :row-key="(row: VideoFormat) => row.formatId"
        :row-class-name="(row: VideoFormat) => row.formatId === selectedFormatId ? 'selected-format' : ''"
        @update:checked-row-keys="(keys: string[]) => keys[0] && emit('update:selectedFormatId', keys[0])"
      />
    </template>
  </div>
</template>

<style scoped>
.video-info-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.video-summary {
  display: flex;
  gap: 12px;
}
.video-thumbnail {
  border-radius: 6px;
  flex-shrink: 0;
}
.video-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.video-title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.format-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.7;
}
.preset-size {
  font-size: 12px;
  opacity: 0.6;
}
.live-warning {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--n-warning-color-suppl, #fcf3cf);
  color: var(--n-warning-color, #f0a020);
  font-size: 13px;
}
:deep(.selected-format) {
  background: var(--n-merged-color, rgba(24, 160, 88, 0.1));
}
</style>
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm type-check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/task/VideoInfoPanel.vue
git commit -m "feat(ytdlp): add VideoInfoPanel component for format selection"
```

---

## Task 10: Frontend — PlaylistPanel Component

**Files:**
- Create: `src/components/task/PlaylistPanel.vue`

- [ ] **Step 1: Create `src/components/task/PlaylistPanel.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NCheckbox, NTag, NSpace, NScrollbar } from 'naive-ui'
import type { PlaylistInfo, FormatPreset } from '@shared/types'

const props = defineProps<{
  playlist: PlaylistInfo
  selectedItems: Set<number>
  presets: FormatPreset[]
  selectedFormatId: string
}>()

const emit = defineEmits<{
  toggleItem: [index: number]
  toggleSelectAll: []
  'update:selectedFormatId': [id: string]
}>()

const selectedCount = computed(() => props.selectedItems.size)
const totalCount = computed(() => props.playlist.entries.length)
const allSelected = computed(() => selectedCount.value === totalCount.value)

function formatDuration(seconds?: number): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const PAGE_SIZE = 50
const visibleEntries = computed(() => props.playlist.entries.slice(0, PAGE_SIZE))
</script>

<template>
  <div class="playlist-panel">
    <!-- Header -->
    <div class="playlist-header">
      <div class="playlist-title">{{ playlist.title }}</div>
      <NSpace size="small" align="center">
        <NTag v-if="playlist.uploader" size="small" :bordered="false">{{ playlist.uploader }}</NTag>
        <span class="selection-count">已选: {{ selectedCount }}/{{ totalCount }}</span>
      </NSpace>
    </div>

    <!-- Select All -->
    <div class="select-all">
      <NCheckbox
        :checked="allSelected"
        :indeterminate="selectedCount > 0 && !allSelected"
        @update:checked="emit('toggleSelectAll')"
      >
        全选
      </NCheckbox>
    </div>

    <!-- Entry List -->
    <NScrollbar style="max-height: 300px">
      <div
        v-for="(entry, index) in visibleEntries"
        :key="entry.id"
        class="playlist-item"
        @click="emit('toggleItem', index)"
      >
        <NCheckbox
          :checked="selectedItems.has(index)"
          @update:checked="emit('toggleItem', index)"
          @click.stop
        />
        <span class="item-index">{{ index + 1 }}.</span>
        <span class="item-title">{{ entry.title }}</span>
        <span v-if="entry.duration" class="item-duration">{{ formatDuration(entry.duration) }}</span>
      </div>
      <div v-if="totalCount > PAGE_SIZE" class="pagination-hint">
        显示前 {{ PAGE_SIZE }} 条，共 {{ totalCount }} 条
      </div>
    </NScrollbar>

    <!-- Format Selection -->
    <div class="format-section">
      <span class="section-label">统一格式:</span>
      <NSpace size="small">
        <NTag
          v-for="preset in presets"
          :key="preset.formatId"
          :type="selectedFormatId === preset.formatId ? 'success' : 'default'"
          :bordered="selectedFormatId !== preset.formatId"
          size="small"
          style="cursor: pointer"
          @click="emit('update:selectedFormatId', preset.formatId)"
        >
          {{ preset.label }}
        </NTag>
      </NSpace>
    </div>
  </div>
</template>

<style scoped>
.playlist-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.playlist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.playlist-title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selection-count {
  font-size: 12px;
  opacity: 0.6;
}
.select-all {
  padding: 4px 0;
  border-bottom: 1px solid var(--n-border-color);
}
.playlist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}
.playlist-item:hover {
  background: var(--n-merged-color, rgba(0, 0, 0, 0.04));
}
.item-index {
  font-size: 12px;
  opacity: 0.5;
  min-width: 24px;
}
.item-title {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-duration {
  font-size: 12px;
  opacity: 0.5;
  flex-shrink: 0;
}
.format-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--n-border-color);
}
.section-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.7;
  flex-shrink: 0;
}
.pagination-hint {
  padding: 8px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
</style>
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `pnpm type-check`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/task/PlaylistPanel.vue
git commit -m "feat(ytdlp): add PlaylistPanel component for batch video selection"
```

---

## Task 11: Frontend — Integrate Video Flow into AddTask Dialog

**Files:**
- Modify: `src/components/task/AddTask.vue`

This is the most integration-heavy task. The AddTask component needs to:
1. Call `tryParseUrl()` when a URL is pasted
2. Show `VideoInfoPanel` or `PlaylistPanel` when video content is detected
3. Submit video downloads when the user clicks download

- [ ] **Step 1: Add video flow imports and setup to AddTask.vue**

In the `<script setup>` section of `src/components/task/AddTask.vue`, add imports:

```typescript
import { useVideoFlow } from '@/composables/useVideoFlow'
import VideoInfoPanel from './VideoInfoPanel.vue'
import PlaylistPanel from './PlaylistPanel.vue'
```

Initialize the composable alongside existing state:

```typescript
const videoFlow = useVideoFlow()
```

- [ ] **Step 2: Add URL watcher for auto-detection**

Add a `watch` on the URL input value (find the reactive ref that holds the URI text — likely part of the form model). When the URL changes and looks like a web URL (starts with `http`), debounce-call `videoFlow.tryParseUrl()`:

```typescript
import { watch } from 'vue'

let parseTimer: ReturnType<typeof setTimeout> | null = null

// Watch the URI input for video URL auto-detection
watch(
  () => formModel.value.uris, // adjust to match the actual reactive ref name
  (newVal) => {
    if (parseTimer) clearTimeout(parseTimer)
    videoFlow.reset()

    const trimmed = (newVal ?? '').trim()
    // Only try to parse single URLs (not multi-line), that look like web URLs
    if (trimmed && !trimmed.includes('\n') && /^https?:\/\//i.test(trimmed)) {
      parseTimer = setTimeout(() => {
        videoFlow.tryParseUrl(trimmed)
      }, 500)
    }
  },
)
```

- [ ] **Step 3: Add video UI panels to the template**

In the template section, after the URI input area and before the download directory selector, add:

```vue
<!-- Video detection loading -->
<div v-if="videoFlow.isParsing.value" class="video-loading">
  正在解析视频信息...
</div>

<!-- Video info panel -->
<VideoInfoPanel
  v-if="videoFlow.isVideo.value && videoFlow.videoInfo.value"
  :video="videoFlow.videoInfo.value"
  :presets="videoFlow.formatPresets.value"
  v-model:selected-format-id="videoFlow.selectedFormatId.value"
  v-model:show-all-formats="videoFlow.showAllFormats.value"
/>

<!-- Playlist panel -->
<PlaylistPanel
  v-if="videoFlow.isPlaylist.value && videoFlow.playlistInfo.value"
  :playlist="videoFlow.playlistInfo.value"
  :selected-items="videoFlow.selectedPlaylistItems.value"
  :presets="videoFlow.formatPresets.value"
  v-model:selected-format-id="videoFlow.selectedFormatId.value"
  @toggle-item="videoFlow.togglePlaylistItem"
  @toggle-select-all="videoFlow.toggleSelectAll"
/>
```

- [ ] **Step 4: Modify the submit handler**

In the submit handler, add video download logic before the existing aria2 submission:

```typescript
// If a video was detected, use video download flow
if (videoFlow.isVideo.value) {
  try {
    await videoFlow.submitVideoDownload(formModel.value.dir)
    // Close dialog and refresh task list
    videoFlow.reset()
    // ... trigger existing close/refresh logic
    return
  } catch (err) {
    // handle error
  }
}

// If a playlist was detected, submit selected items
if (videoFlow.isPlaylist.value && videoFlow.playlistInfo.value) {
  const pl = videoFlow.playlistInfo.value
  const items = Array.from(videoFlow.selectedPlaylistItems.value)
    .sort((a, b) => a - b)
    .map((i) => pl.entries[i])
    .filter(Boolean)

  for (const item of items) {
    try {
      // Each playlist item needs individual format resolution
      // Use yt-dlp direct download with the selected format
      await ytdlpApi.downloadDirect({
        url: item.url,
        formatId: videoFlow.selectedFormatId.value,
        dir: formModel.value.dir,
      })
    } catch (err) {
      console.error(`Failed to download playlist item: ${item.title}`, err)
    }
  }
  videoFlow.reset()
  // ... trigger existing close/refresh logic
  return
}

// ... existing aria2 submission code continues below
```

- [ ] **Step 5: Reset video flow when dialog closes**

In the dialog close/cancel handler, add:

```typescript
videoFlow.reset()
```

- [ ] **Step 6: Verify compilation and test in browser**

Run: `pnpm type-check`
Then start the dev server: `pnpm tauri dev`
Test: Paste a YouTube URL into the Add Task dialog and verify the video info panel appears.

- [ ] **Step 7: Commit**

```bash
git add src/components/task/AddTask.vue
git commit -m "feat(ytdlp): integrate video auto-detection into AddTask dialog"
```

---

## Task 12: Frontend — Video Task Metadata in TaskItem

**Files:**
- Modify: `src/components/task/TaskItem.vue`

- [ ] **Step 1: Add video metadata display to TaskItem.vue**

In `TaskItem.vue`, parse the `meta` field from HistoryRecord to detect video tasks and show additional info.

In the `<script setup>`, add a computed for video metadata:

```typescript
const videoMeta = computed(() => {
  // For stopped tasks, check history record meta
  const meta = props.task.meta ?? props.historyRecord?.meta
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta)
    if (parsed.video_title) return parsed
  } catch {
    // not a video task
  }
  return null
})
```

In the template, find where the task name is displayed. Add video tags after the name:

```vue
<NTag v-if="videoMeta?.extractor" size="tiny" :bordered="false" type="info" class="video-tag">
  {{ videoMeta.extractor }}
</NTag>
<NTag v-if="videoMeta?.resolution" size="tiny" :bordered="false" class="video-tag">
  {{ videoMeta.resolution }}
</NTag>
```

And use the video title as the display name when available:

```typescript
const displayName = computed(() => {
  if (videoMeta.value?.video_title) return videoMeta.value.video_title
  // ... existing name resolution logic
})
```

- [ ] **Step 2: Add minimal styles**

```css
.video-tag {
  margin-left: 4px;
  vertical-align: middle;
}
```

- [ ] **Step 3: Verify compilation and test**

Run: `pnpm type-check`
Test in dev server that video tasks show the extractor and resolution tags.

- [ ] **Step 4: Commit**

```bash
git add src/components/task/TaskItem.vue
git commit -m "feat(ytdlp): show video metadata tags in task list items"
```

---

## Task 13: Sidecar Binary Placeholder

**Files:**
- Create: placeholder yt-dlp binaries for development

- [ ] **Step 1: Create placeholder binaries for the current platform**

For development and compilation to succeed, we need a yt-dlp binary in the sidecar path. Download the real yt-dlp binary for the current platform:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o public/binaries/motrixnext-ytdlp-aarch64-apple-darwin
chmod +x public/binaries/motrixnext-ytdlp-aarch64-apple-darwin

# macOS (Intel)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o public/binaries/motrixnext-ytdlp-x86_64-apple-darwin
chmod +x public/binaries/motrixnext-ytdlp-x86_64-apple-darwin
```

For other platforms, download the appropriate binary from `https://github.com/yt-dlp/yt-dlp/releases/latest/download/`:
- Linux x64: `yt-dlp_linux` → `motrixnext-ytdlp-x86_64-unknown-linux-gnu`
- Linux ARM64: `yt-dlp_linux_aarch64` → `motrixnext-ytdlp-aarch64-unknown-linux-gnu`
- Windows x64: `yt-dlp.exe` → `motrixnext-ytdlp-x86_64-pc-windows-msvc.exe`
- Windows ARM64: `yt-dlp.exe` → `motrixnext-ytdlp-aarch64-pc-windows-msvc.exe`

- [ ] **Step 2: Add binaries to .gitignore or commit them**

Decision point: yt-dlp binaries are ~20-30MB each. Either:
- Add them to `.gitignore` and handle binary download in CI (recommended for repo size)
- Or commit them if the team prefers bundled binaries (matching the aria2c approach)

Check how `motrixnext-aria2c` binaries are handled (committed or in `.gitignore`) and follow the same pattern.

- [ ] **Step 3: Verify `pnpm tauri dev` starts without sidecar errors**

Run: `pnpm tauri dev`
Expected: app starts, yt-dlp sidecar is registered (may show "binary not found" for non-current platforms, which is fine for dev)

- [ ] **Step 4: Commit**

```bash
git add public/binaries/motrixnext-ytdlp-* src-tauri/tauri.conf.json
git commit -m "chore: add yt-dlp sidecar binaries for development"
```

---

## Task 14: Integration Testing

**Files:** No new files — manual testing workflow

- [ ] **Step 1: Start the dev server**

Run: `pnpm tauri dev`

- [ ] **Step 2: Test single video URL**

1. Open Add Task dialog
2. Paste a YouTube video URL (e.g., a short public-domain video)
3. Verify: loading indicator appears → video info panel shows with thumbnail, title, format presets
4. Select "720p" preset
5. Click download
6. Verify: task appears in task list with video title and YouTube tag

- [ ] **Step 3: Test non-video URL fallback**

1. Open Add Task dialog
2. Paste a regular file URL (e.g., `https://example.com/file.zip`)
3. Verify: normal aria2 download flow (no video panel shown)

- [ ] **Step 4: Test playlist URL**

1. Open Add Task dialog
2. Paste a YouTube playlist URL
3. Verify: playlist panel shows with selectable entries
4. Deselect some entries, click download
5. Verify: only selected videos start downloading

- [ ] **Step 5: Test error scenarios**

1. Paste an invalid URL → should silently fall back to aria2
2. Paste a URL with network error → should show timeout/error message
3. Paste a live stream URL → should show "暂不支持直播下载" warning

- [ ] **Step 6: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix(ytdlp): address issues found during integration testing"
```
