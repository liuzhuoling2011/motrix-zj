use std::time::Duration;
use tauri_plugin_shell::ShellExt;

use super::types::{ParseResult, PlaylistInfo, PlaylistItem, VideoInfo};
use crate::error::AppError;

/// Timeout for a single yt-dlp parse operation.
///
/// Applied to `run_ytdlp` via `tokio::time::timeout`; exceeding this
/// maps to [`AppError::YtdlpTimeout`].
const PARSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Spawns the yt-dlp sidecar, waits for completion, and returns stdout.
///
/// Wraps the sidecar call in a 30-second timeout. On non-zero exit status,
/// returns the stderr text as [`AppError::YtdlpParse`].
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

/// Parses a URL with yt-dlp using `--dump-json --no-download --flat-playlist`.
///
/// Returns:
/// - [`ParseResult::Playlist`] when the first JSON line is a playlist descriptor.
/// - [`ParseResult::Video`] when exactly one JSON line describing a video is emitted.
/// - [`ParseResult::NotMedia`] when stdout is empty or the shape is unrecognised.
pub async fn parse_url(app: &tauri::AppHandle, url: &str) -> Result<ParseResult, AppError> {
    let stdout = run_ytdlp(
        app,
        &["--dump-json", "--no-download", "--flat-playlist", url],
    )
    .await?;

    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();

    if lines.is_empty() {
        return Ok(ParseResult::NotMedia);
    }

    let first: serde_json::Value =
        serde_json::from_str(lines[0]).map_err(|e| AppError::YtdlpParse(e.to_string()))?;

    if first.get("_type").and_then(|v| v.as_str()) == Some("playlist") {
        let playlist_id = first
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let playlist_title = first
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Playlist")
            .to_string();
        let uploader = first
            .get("uploader")
            .and_then(|v| v.as_str())
            .map(String::from);

        let entries: Vec<PlaylistItem> =
            if let Some(arr) = first.get("entries").and_then(|v| v.as_array()) {
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

    if lines.len() == 1 {
        let video: VideoInfo =
            serde_json::from_str(lines[0]).map_err(|e| AppError::YtdlpParse(e.to_string()))?;
        return Ok(ParseResult::Video(video));
    }

    Ok(ParseResult::NotMedia)
}

/// Resolves a single playlist entry to a full [`VideoInfo`] with format list.
///
/// Runs `yt-dlp --dump-json --no-download <URL>` (no `--flat-playlist`) so
/// the resulting JSON includes the `formats` array required for quality
/// selection.
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
