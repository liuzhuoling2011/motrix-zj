//! Sidecar introspection commands.
//!
//! Versions for yt-dlp / ffmpeg / ffprobe are probed **once at startup** by
//! [`prefetch_sidecar_versions`] and cached in [`SidecarVersionState`].
//! The frontend reads the snapshot via [`get_sidecar_versions`]; no more
//! on-demand sidecar spawning per panel open.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use tauri_plugin_shell::ShellExt;

const SIDECAR_NAMES: [&str; 3] = ["ytdlp", "ffmpeg", "ffprobe"];

/// Per-sidecar probe budget. PyInstaller-frozen yt-dlp's first launch on
/// macOS (Gatekeeper verify + unpack) can easily take 3-5 seconds; 8s
/// leaves headroom while still capping the wait on truly stuck binaries.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// In-memory cache of first-line `--version` / `-version` output per sidecar.
/// `None` means "fetch attempted and failed" (or not yet attempted at init).
#[derive(Default)]
pub struct SidecarVersionState {
    versions: RwLock<HashMap<String, Option<String>>>,
}

impl SidecarVersionState {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        for name in SIDECAR_NAMES {
            map.insert(name.to_string(), None);
        }
        Self {
            versions: RwLock::new(map),
        }
    }

    fn set(&self, name: &str, version: Option<String>) {
        if let Ok(mut w) = self.versions.write() {
            w.insert(name.to_string(), version);
        }
    }

    fn snapshot(&self) -> HashMap<String, Option<String>> {
        self.versions
            .read()
            .map(|r| r.clone())
            .unwrap_or_default()
    }
}

/// Runs `<sidecar> <version-flag>` and returns the first non-empty stdout line.
async fn probe_version(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    // `--no-config` stops yt-dlp from reading ~/.config/yt-dlp/config, which
    // can block on user-set update checks or invalid options.  ffmpeg /
    // ffprobe get `-hide_banner` so stdout is the single version line.
    let (binary, args): (&str, &[&str]) = match name {
        "ytdlp" => ("motrixnext-ytdlp", &["--no-config", "--version"]),
        "ffmpeg" => ("motrixnext-ffmpeg", &["-hide_banner", "-version"]),
        "ffprobe" => ("ffprobe", &["-hide_banner", "-version"]),
        other => return Err(format!("unknown sidecar: {other}")),
    };

    let output = app
        .shell()
        .sidecar(binary)
        .map_err(|e| format!("sidecar resolve failed: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("sidecar execute failed: {e}"))?;

    if !output.status.success() {
        return Err(format!("exited with status {:?}", output.status.code()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(first)
}

async fn probe_with_timeout(app: &tauri::AppHandle, name: &str) -> Option<String> {
    log::info!("sidecar {name}: probing version");
    match tokio::time::timeout(PROBE_TIMEOUT, probe_version(app, name)).await {
        Ok(Ok(v)) => {
            log::info!("sidecar {name}: version = {v}");
            Some(v)
        }
        Ok(Err(e)) => {
            log::warn!("sidecar {name}: probe failed: {e}");
            None
        }
        Err(_) => {
            log::warn!(
                "sidecar {name}: probe timed out after {}s",
                PROBE_TIMEOUT.as_secs()
            );
            None
        }
    }
}

/// Fire-and-forget background probe of all bundled sidecars at startup.
/// Runs all three in parallel so a slow one doesn't delay the others.
pub fn prefetch_sidecar_versions(app: tauri::AppHandle) {
    // `tauri::async_runtime::spawn` uses Tauri's own runtime handle, which
    // is available inside `setup_app` (plain `tokio::spawn` panics there
    // because the tokio reactor hasn't started yet).
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let (ytdlp, ffmpeg, ffprobe) = tokio::join!(
            probe_with_timeout(&app, "ytdlp"),
            probe_with_timeout(&app, "ffmpeg"),
            probe_with_timeout(&app, "ffprobe"),
        );
        if let Some(state) = app.try_state::<SidecarVersionState>() {
            state.set("ytdlp", ytdlp);
            state.set("ffmpeg", ffmpeg);
            state.set("ffprobe", ffprobe);
        }
    });
}

/// Returns the startup-populated sidecar version cache.
/// Keys: `ytdlp` / `ffmpeg` / `ffprobe`. Values: first-line `--version`
/// output, or `null` if the probe failed / hasn't completed yet.
#[tauri::command]
pub fn get_sidecar_versions(
    state: tauri::State<'_, SidecarVersionState>,
) -> HashMap<String, Option<String>> {
    state.snapshot()
}
