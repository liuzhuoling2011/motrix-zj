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

use tauri::{Manager, State};

use crate::aria2::client::Aria2State;
use crate::error::AppError;
use crate::history::{HistoryDbState, HistoryRecord};
use crate::ytdlp;
use crate::ytdlp::client::YtdlpHeaders;
use crate::ytdlp::{ParseResult, YtdlpState};

const MAIN_WINDOW_LABEL: &str = "main";

/// Best-effort bridge from the in-app WebView cookie jar to the on-disk
/// yt-dlp cookie store. This keeps parse/download commands robust even when
/// they are triggered before the AddTask form has an explicit Cookie header.
fn refresh_webview_cookie_store(app: &tauri::AppHandle) {
    let Some(store) = app.try_state::<crate::cookies::CookieStore>() else {
        return;
    };
    let Some(webview) = app.get_webview(MAIN_WINDOW_LABEL) else {
        return;
    };

    let cookies = match webview.cookies() {
        Ok(cookies) => cookies,
        Err(e) => {
            log::debug!("ytdlp: webview cookie refresh skipped, read failed: {e}");
            return;
        }
    };
    match store.save_from_webview(cookies) {
        Ok(written) => {
            log::debug!(
                "ytdlp: refreshed webview cookies for {} domain(s)",
                written.len()
            );
        }
        Err(e) => {
            log::debug!("ytdlp: webview cookie refresh skipped, write failed: {e}");
        }
    }
}

/// Extracts `Cookie` and `User-Agent` from an aria2-shaped options JSON into
/// a [`YtdlpHeaders`] for bot-detection bypass. Both fields are optional.
///
/// `buildEngineOptions` on the frontend places the cookie inside the
/// `header` array as `"Cookie: <value>"` (an aria2 convention), so we scan
/// that array for a case-insensitive `Cookie:` prefix.
fn headers_from_options(options: &serde_json::Value) -> YtdlpHeaders {
    let user_agent = options
        .get("user-agent")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from);

    let referer = options
        .get("referer")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from);

    // Cookie may live either as a top-level `cookie` field OR inside the
    // `header` array. Accept both for forward compatibility.
    let cookie_from_top = options
        .get("cookie")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from);

    // `options.header` may arrive as either a JSON array (aria2 native shape)
    // OR a `\n`-joined string (the frontend's flattened `Record<string,string>`
    // form when handed off to ytdlp). Handle both.
    fn find_cookie_in_line(h: &str) -> Option<String> {
        let trimmed = h.trim();
        if trimmed.len() < 7 {
            return None;
        }
        let (prefix, value) = trimmed.split_at(7);
        if prefix.eq_ignore_ascii_case("Cookie:") {
            let v = value.trim();
            if v.is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        } else {
            None
        }
    }

    let cookie_from_headers = options.get("header").and_then(|v| {
        if let Some(arr) = v.as_array() {
            arr.iter()
                .filter_map(|h| h.as_str())
                .find_map(find_cookie_in_line)
        } else if let Some(s) = v.as_str() {
            s.split('\n').find_map(find_cookie_in_line)
        } else {
            None
        }
    });

    let cookie = cookie_from_top.or(cookie_from_headers);

    YtdlpHeaders {
        cookie,
        user_agent,
        referer,
        cookies_from_browser: None,
    }
}

/// Parses a URL with yt-dlp to detect video/playlist content.
///
/// Optional `cookie` and `user_agent` let the frontend supply bot-detection
/// bypass credentials from the Add Task dialog's advanced options before the
/// user has clicked download — useful for YouTube / Bilibili where anonymous
/// parse is rejected.
#[tauri::command]
pub async fn ytdlp_parse_url(
    app: tauri::AppHandle,
    url: String,
    cookie: Option<String>,
    user_agent: Option<String>,
    cookies_from_browser: Option<String>,
    referer: Option<String>,
) -> Result<ParseResult, AppError> {
    refresh_webview_cookie_store(&app);
    let headers = YtdlpHeaders {
        cookie,
        user_agent,
        referer,
        cookies_from_browser,
    };
    ytdlp::client::parse_url(&app, &url, &headers).await
}

/// Downloads a video via aria2 (for direct-link formats).
///
/// Looks up the requested `format_id` in the parsed [`VideoInfo`], extracts
/// the direct download URL, and hands it to aria2 with a filename derived
/// from the video title. Fails with [`AppError::YtdlpParse`] if the format
/// is not found or lacks a direct URL (manifest-only formats such as HLS
/// must use [`ytdlp_download_direct`] instead).
///
/// The caller-supplied `options` are the base aria2 preferences (dir, proxy,
/// split, user-agent, headers, etc.); we only overlay `out` (sanitized
/// filename) and `referer` (source URL for anti-hotlink) on top so that
/// frontend-configured settings are preserved.
#[tauri::command]
pub async fn ytdlp_download_via_aria2(
    app: tauri::AppHandle,
    aria2: State<'_, Aria2State>,
    url: String,
    format_id: String,
    options: serde_json::Value,
    cookies_from_browser: Option<String>,
) -> Result<String, AppError> {
    refresh_webview_cookie_store(&app);
    // Resolve the format to get direct URL. Pass the caller's cookie/UA so
    // the re-parse can also bypass bot detection; browser cookies take
    // precedence for sites that invalidate exported cookies (YouTube).
    let mut headers = headers_from_options(&options);
    headers.cookies_from_browser = cookies_from_browser;
    let video = ytdlp::client::parse_playlist_item(&app, &url, &headers).await?;

    let format = video
        .formats
        .iter()
        .find(|f| f.format_id == format_id)
        .ok_or_else(|| AppError::YtdlpParse(format!("format '{format_id}' not found in video")))?;

    let direct_url = format
        .url
        .as_ref()
        .ok_or_else(|| AppError::YtdlpParse("selected format has no direct download URL".into()))?
        .clone();

    // Start from the caller's options (dir, proxy, split, headers, etc.)
    let mut opts = options;
    if !opts.is_object() {
        opts = serde_json::json!({});
    }

    // Overlay video-specific fields: sanitized output filename + referer for anti-hotlink.
    if let Some(obj) = opts.as_object_mut() {
        obj.insert(
            "out".to_string(),
            serde_json::json!(sanitize_filename(&video.title, &format.ext)),
        );
        obj.insert("referer".to_string(), serde_json::json!(url));
    }

    aria2.0.add_uri(vec![direct_url], opts).await
}

/// Downloads a video directly with yt-dlp (HLS/DASH fallback).
///
/// Spawns the `motrixnext-ytdlp` sidecar via [`ytdlp::downloader::start_download`]
/// and returns a generated task id immediately. Progress events are emitted on
/// the `ytdlp-progress` channel until the download completes or is cancelled.
///
/// Accepts `options` (the same shape the frontend passes to `aria2_add_uri`)
/// to keep the IPC surface consistent; the download directory is extracted
/// from `options.dir`.
#[tauri::command]
pub async fn ytdlp_download_direct(
    app: tauri::AppHandle,
    state: State<'_, YtdlpState>,
    history: State<'_, HistoryDbState>,
    url: String,
    format_id: String,
    title: String,
    ext: String,
    meta: serde_json::Value,
    options: serde_json::Value,
    cookies_from_browser: Option<String>,
) -> Result<String, AppError> {
    refresh_webview_cookie_store(&app);
    let dir = options
        .get("dir")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::YtdlpDownload("missing 'dir' in options".into()))?
        .to_string();

    // Use the title from the initial parse instead of yt-dlp's runtime
    // `%(title)s` expansion. On Windows, sidecar log output can be decoded
    // with the wrong code page after completion; a deterministic filename
    // keeps history/UI state aligned with the actual output path.
    let (output_template, display_name) = build_ytdlp_output_template(&dir, &title, &ext);
    let mut headers = headers_from_options(&options);
    headers.cookies_from_browser = cookies_from_browser;
    log::info!(
        "ytdlp_download_direct options.header={:?} cookie_set={} ua_set={} browser={:?}",
        options.get("header"),
        headers.cookie.is_some(),
        headers.user_agent.is_some(),
        headers.cookies_from_browser,
    );

    // Clone so format_id / cookies_from_browser can be persisted in meta
    // after start_download consumes `headers`.
    let format_id_for_meta = format_id.clone();
    let cookies_from_browser_for_meta = headers.cookies_from_browser.clone();

    let task_id = ytdlp::downloader::start_download(
        app,
        &state,
        url.clone(),
        format_id,
        output_template,
        Some(display_name.clone()),
        headers,
    )
    .await?;

    // Record the task in history.db so it appears in the task list immediately.
    // The downloader's monitor task updates status to 'complete' / 'error' on
    // termination via HistoryDb::update_status.
    //
    // The stored `name` includes the extension so the UI's file-exists check
    // and "open folder" actions resolve to the actual on-disk file, which
    // yt-dlp writes as "<title>.<ext>".
    let now = chrono::Utc::now().to_rfc3339();
    // Persist format_id + ext + cookies_from_browser in meta so a later
    // restart can re-run the sidecar with the same choice without needing
    // the user to re-parse the video from the web panel.
    let meta_json = {
        let mut m = if let Some(obj) = meta.as_object() {
            obj.clone()
        } else {
            serde_json::Map::new()
        };
        m.entry("download_mode".to_string())
            .or_insert_with(|| serde_json::json!("ytdlp_direct"));
        m.insert(
            "format_id".to_string(),
            serde_json::json!(format_id_for_meta),
        );
        if !ext.is_empty() {
            m.insert("ext".to_string(), serde_json::json!(ext));
        }
        if let Some(browser) = cookies_from_browser_for_meta.as_deref() {
            m.insert(
                "cookies_from_browser".to_string(),
                serde_json::json!(browser),
            );
        }
        serde_json::Value::Object(m).to_string()
    };
    let total_length = meta
        .get("filesize")
        .and_then(|v| v.as_i64())
        .or_else(|| meta.get("filesizeApprox").and_then(|v| v.as_i64()));
    let record = HistoryRecord {
        id: None,
        gid: task_id.clone(),
        name: display_name,
        uri: Some(url),
        dir: Some(dir),
        total_length,
        status: "active".into(),
        task_type: Some("video".into()),
        added_at: Some(now),
        created_at: None,
        completed_at: None,
        meta: Some(meta_json),
    };
    if let Err(e) = history.0.add_record(&record).await {
        log::warn!("failed to record initial ytdlp history: {e}");
    }

    Ok(task_id)
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
    let ext = ext.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        if ext.is_empty() {
            "video".to_string()
        } else {
            format!("video.{ext}")
        }
    } else if ext.is_empty() {
        trimmed.to_string()
    } else {
        format!("{trimmed}.{ext}")
    }
}

fn build_ytdlp_output_template(dir: &str, title: &str, ext: &str) -> (String, String) {
    let filename = sanitize_filename(title, ext);
    let escaped_filename = filename.replace('%', "%%");
    let base_dir = dir.trim_end_matches(['/', '\\']);
    let output_template = if base_dir.is_empty() {
        escaped_filename
    } else {
        format!("{base_dir}/{escaped_filename}")
    };
    (output_template, filename)
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
    fn sanitize_empty_ext_does_not_leave_trailing_dot() {
        assert_eq!(sanitize_filename("My Video", ""), "My Video");
    }

    #[test]
    fn sanitize_path_separators() {
        assert_eq!(
            sanitize_filename("folder/sub\\file", "webm"),
            "folder_sub_file.webm"
        );
    }

    #[test]
    fn output_template_uses_known_title_and_escapes_percent() {
        let (template, filename) =
            build_ytdlp_output_template("C:\\Downloads\\", "周杰伦: 100% 现场", "mp4");

        assert_eq!(filename, "周杰伦_ 100% 现场.mp4");
        assert_eq!(template, "C:\\Downloads/周杰伦_ 100%% 现场.mp4");
    }
}
