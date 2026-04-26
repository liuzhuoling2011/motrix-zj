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

/// Probe budget for ffmpeg / ffprobe — they're plain native binaries and
/// always respond within a second.
const FAST_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Probe budget for the PyInstaller-frozen yt-dlp.  First launch on
/// macOS triggers Gatekeeper verify + bootloader unpack which can run
/// 15-25 seconds on cold caches; 45s gives headroom without leaving the
/// startup probe hanging forever on a truly broken binary.
const SLOW_PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// Delay before retrying a sidecar that failed its first probe.  The
/// retry covers two failure modes: yt-dlp losing the race against the
/// initial macOS Gatekeeper hold, and a transient sidecar resolve error
/// while the app is still wiring its tauri-plugin-shell handles.
const PROBE_RETRY_DELAY: Duration = Duration::from_secs(10);

fn probe_timeout_for(name: &str) -> Duration {
    match name {
        "ytdlp" => SLOW_PROBE_TIMEOUT,
        _ => FAST_PROBE_TIMEOUT,
    }
}

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
        self.versions.read().map(|r| r.clone()).unwrap_or_default()
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
    let budget = probe_timeout_for(name);
    log::info!("sidecar {name}: probing version (timeout {}s)", budget.as_secs());
    match tokio::time::timeout(budget, probe_version(app, name)).await {
        Ok(Ok(v)) => {
            log::info!("sidecar {name}: version = {v}");
            Some(v)
        }
        Ok(Err(e)) => {
            log::warn!("sidecar {name}: probe failed: {e}");
            None
        }
        Err(_) => {
            log::warn!("sidecar {name}: probe timed out after {}s", budget.as_secs());
            None
        }
    }
}

/// Updates the cached version for a single sidecar and broadcasts the
/// full snapshot to the frontend. Used by both the initial parallel
/// probe and the delayed retry path so the UI never has to reconcile
/// partial state — every emit carries the complete picture.
fn publish_sidecar_versions(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let snapshot = match app.try_state::<SidecarVersionState>() {
        Some(state) => state.snapshot(),
        None => return,
    };
    let _ = app.emit(
        "sidecar-versions-ready",
        serde_json::json!({
            "ytdlp": snapshot.get("ytdlp").cloned().unwrap_or(None),
            "ffmpeg": snapshot.get("ffmpeg").cloned().unwrap_or(None),
            "ffprobe": snapshot.get("ffprobe").cloned().unwrap_or(None),
        }),
    );
}

/// Fire-and-forget background probe of all bundled sidecars at startup.
/// Runs all three in parallel so a slow one doesn't delay the others.
/// Emits `sidecar-versions-ready` once the parallel pass settles so the
/// frontend can refresh its cache — yt-dlp's PyInstaller first-launch
/// unpack can take longer than `main.ts`'s initial snapshot fetch.
///
/// Any sidecar that came back `None` is retried once after
/// `PROBE_RETRY_DELAY`, then republished. The frontend listener uses
/// merge semantics so a late success can't blow away a value that
/// already arrived.
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
        let mut failed: Vec<&'static str> = Vec::new();
        if let Some(state) = app.try_state::<SidecarVersionState>() {
            state.set("ytdlp", ytdlp.clone());
            state.set("ffmpeg", ffmpeg.clone());
            state.set("ffprobe", ffprobe.clone());
        }
        if ytdlp.is_none() {
            failed.push("ytdlp");
        }
        if ffmpeg.is_none() {
            failed.push("ffmpeg");
        }
        if ffprobe.is_none() {
            failed.push("ffprobe");
        }
        publish_sidecar_versions(&app);

        if failed.is_empty() {
            return;
        }
        log::info!(
            "sidecar: scheduling retry in {}s for: {:?}",
            PROBE_RETRY_DELAY.as_secs(),
            failed
        );
        tokio::time::sleep(PROBE_RETRY_DELAY).await;
        let mut anything_recovered = false;
        for name in failed {
            if let Some(v) = probe_with_timeout(&app, name).await {
                if let Some(state) = app.try_state::<SidecarVersionState>() {
                    state.set(name, Some(v));
                }
                anything_recovered = true;
            }
        }
        if anything_recovered {
            publish_sidecar_versions(&app);
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
