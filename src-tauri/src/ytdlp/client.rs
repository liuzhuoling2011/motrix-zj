use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use super::types::{ParseResult, PlaylistInfo, PlaylistItem, VideoInfo};
use crate::error::AppError;

/// Timeout for a single yt-dlp parse operation.
///
/// Applied to `run_ytdlp` via `tokio::time::timeout`; exceeding this
/// maps to [`AppError::YtdlpTimeout`].
const PARSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Optional HTTP headers passed to yt-dlp via `--add-header`.
///
/// Used primarily to bypass bot detection on sites like YouTube and Bilibili
/// by supplying the user's browser `Cookie` and matching `User-Agent`.
#[derive(Debug, Default, Clone)]
pub struct YtdlpHeaders {
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
    /// Name of a local browser whose cookie store yt-dlp should read
    /// (e.g. "chrome", "firefox", "safari"). When set, takes precedence
    /// over `cookie` because it avoids YouTube's session-bound cookie
    /// rotation that invalidates copy-pasted cookies.
    pub cookies_from_browser: Option<String>,
}

impl YtdlpHeaders {
    /// Builds `--user-agent` / `--cookies-from-browser` / `--cookies <file>` args.
    ///
    /// Precedence for cookie sources:
    ///   1. `cookies_from_browser` — `--cookies-from-browser <name>`; reads
    ///      the user's live browser cookie DB (best for YouTube).
    ///   2. `cookie` — parsed into a Netscape `cookies.txt` and passed via
    ///      `--cookies`; scoped to the URL's domain.
    ///
    /// When both are set, the browser source wins and the pasted cookie is
    /// ignored to keep the final CLI unambiguous.
    pub async fn resolve_args(
        &self,
        app: &tauri::AppHandle,
        target_url: &str,
    ) -> Result<Vec<String>, AppError> {
        let mut args = Vec::new();
        if let Some(ua) = self.user_agent.as_ref().filter(|s| !s.trim().is_empty()) {
            args.push("--user-agent".to_string());
            args.push(ua.clone());
        }
        if let Some(browser) = self
            .cookies_from_browser
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.clone());
        } else if let Some(cookie) = self.cookie.as_ref().filter(|s| !s.trim().is_empty()) {
            let path = write_cookies_file(app, target_url, cookie).await?;
            args.push("--cookies".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Ok(args)
    }
}

/// Writes a Netscape-format cookies file containing every `name=value` pair
/// from `cookie_str`, scoped to the URL's domain.
///
/// Persists under `<app_data>/ytdlp-cookies.txt` (overwritten each call).
/// Returns the absolute path so callers can pass it to `yt-dlp --cookies`.
async fn write_cookies_file(
    app: &tauri::AppHandle,
    target_url: &str,
    cookie_str: &str,
) -> Result<PathBuf, AppError> {
    let host = url::Url::parse(target_url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .ok_or_else(|| AppError::YtdlpParse(format!("invalid URL for cookie scoping: {target_url}")))?;
    let domain = format!(".{host}");

    let mut contents = String::from("# Netscape HTTP Cookie File\n");
    for pair in cookie_str.split(';') {
        let trimmed = pair.trim();
        if trimmed.is_empty() {
            continue;
        }
        let eq_at = match trimmed.find('=') {
            Some(i) => i,
            None => continue,
        };
        let (name, value_raw) = trimmed.split_at(eq_at);
        let value = &value_raw[1..]; // skip '='
        // Netscape fields, TAB-separated:
        // domain, includeSubdomains, path, secure, expires, name, value.
        // includeSubdomains=TRUE since we prefix domain with '.'; secure=TRUE
        // is safe for HTTPS-only sites like YouTube/Bilibili; expires=0 means
        // session (yt-dlp accepts this for login-scoped cookies).
        contents.push_str(&format!("{domain}\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n"));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::YtdlpParse(format!("app_data_dir: {e}")))?;
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|e| AppError::YtdlpParse(format!("create data dir: {e}")))?;
    let path = data_dir.join("ytdlp-cookies.txt");
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| AppError::YtdlpParse(format!("write cookies file: {e}")))?;
    Ok(path)
}

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
pub async fn parse_url(
    app: &tauri::AppHandle,
    url: &str,
    headers: &YtdlpHeaders,
) -> Result<ParseResult, AppError> {
    let mut args: Vec<String> = headers.resolve_args(app, url).await?;
    args.extend([
        "--dump-json".into(),
        "--no-download".into(),
        "--flat-playlist".into(),
        url.into(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = run_ytdlp(app, &arg_refs).await?;

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
    headers: &YtdlpHeaders,
) -> Result<VideoInfo, AppError> {
    let mut args: Vec<String> = headers.resolve_args(app, url).await?;
    args.extend(["--dump-json".into(), "--no-download".into(), url.into()]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = run_ytdlp(app, &arg_refs).await?;

    let first_line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| AppError::YtdlpParse("empty output".into()))?;

    serde_json::from_str(first_line).map_err(|e| AppError::YtdlpParse(e.to_string()))
}
