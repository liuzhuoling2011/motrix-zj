//! Tauri commands exposing yt-dlp functionality to the frontend.
//!
//! Four IPC entry points:
//!
//! 1. [`ytdlp_parse_url`]  — detect whether a URL is a video, a playlist, or
//!    not media at all.
//! 2. [`ytdlp_download_via_aria2`] — resolve a format's direct URL and hand
//!    it to aria2 (the fast path for regular HTTPS downloads).
//! 3. [`ytdlp_download_direct`] — spawn the yt-dlp sidecar to download HLS or
//!    DASH streams that aria2 cannot handle.
//! 4. [`ytdlp_cancel_download`] — terminate an in-flight direct download.

use tauri::State;

use crate::aria2::client::Aria2State;
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
/// Looks up the requested `format_id` in the parsed [`VideoInfo`], extracts
/// the direct download URL, and hands it to aria2 with a filename derived
/// from the video title. Fails with [`AppError::YtdlpParse`] if the format
/// is not found or lacks a direct URL (manifest-only formats such as HLS
/// must use [`ytdlp_download_direct`] instead).
#[tauri::command]
pub async fn ytdlp_download_via_aria2(
    app: tauri::AppHandle,
    aria2: State<'_, Aria2State>,
    url: String,
    format_id: String,
    dir: String,
) -> Result<String, AppError> {
    // Resolve the format to get direct URL
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
        })?
        .clone();

    let mut opts = serde_json::json!({
        "dir": dir,
        "out": sanitize_filename(&video.title, &format.ext),
        "referer": url,
    });

    // Add user-agent if we have one (could be refined later)
    if let Some(obj) = opts.as_object_mut() {
        obj.insert(
            "user-agent".to_string(),
            serde_json::json!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"),
        );
    }

    aria2.0.add_uri(vec![direct_url], opts).await
}

/// Downloads a video directly with yt-dlp (HLS/DASH fallback).
///
/// Spawns the `motrixnext-ytdlp` sidecar via [`ytdlp::downloader::start_download`]
/// and returns a generated task id immediately. Progress events are emitted on
/// the `ytdlp-progress` channel until the download completes or is cancelled.
#[tauri::command]
pub async fn ytdlp_download_direct(
    app: tauri::AppHandle,
    state: State<'_, YtdlpState>,
    url: String,
    format_id: String,
    dir: String,
) -> Result<String, AppError> {
    let video = ytdlp::client::parse_playlist_item(&app, &url).await?;
    let format = video.formats.iter().find(|f| f.format_id == format_id);
    let ext = format.map(|f| f.ext.as_str()).unwrap_or("mp4");
    let filename = sanitize_filename(&video.title, ext);
    let output_path = std::path::Path::new(&dir).join(&filename);
    let output_str = output_path.to_string_lossy().to_string();

    // `start_download` takes `AppHandle` by value; `parse_playlist_item`
    // above borrowed it, so the handle is still owned here and can be moved.
    ytdlp::downloader::start_download(app, &state, url, format_id, output_str).await
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
///
/// Replaces characters that are illegal on Windows/macOS/Linux filesystems
/// with underscores, trims surrounding whitespace and trailing dots
/// (Windows strips trailing dots at open time), and falls back to
/// `video.<ext>` when the sanitized title is empty.
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
