use serde::{Deserialize, Serialize};

/// yt-dlp `--dump-json` output — only the fields we consume.
/// Uses `#[serde(default)]` so missing keys get zero-values instead of errors.
///
/// `rename_all(serialize = "camelCase")` applies only on the Rust → frontend
/// edge so TypeScript receives idiomatic camelCase keys. Deserialization
/// (yt-dlp JSON → Rust) keeps the default snake_case matching since the Rust
/// field names already use snake_case.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
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
#[serde(rename_all(serialize = "camelCase"))]
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
#[serde(rename_all(serialize = "camelCase"))]
pub struct PlaylistInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub entries: Vec<PlaylistItem>,
}

/// Single entry within a playlist (from `--flat-playlist`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
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
