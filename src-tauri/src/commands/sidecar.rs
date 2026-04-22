//! Sidecar introspection commands (version probes for the About panel).

use tauri_plugin_shell::ShellExt;

/// Runs `<sidecar> --version` and returns the first non-empty line of stdout.
///
/// Accepted `name` values map to bundled sidecars:
/// `ytdlp` → `motrixnext-ytdlp`, `ffmpeg` → `motrixnext-ffmpeg`, `ffprobe` → `ffprobe`.
#[tauri::command]
pub async fn get_sidecar_version(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let (binary, flag) = match name.as_str() {
        "ytdlp" => ("motrixnext-ytdlp", "--version"),
        "ffmpeg" => ("motrixnext-ffmpeg", "-version"),
        "ffprobe" => ("ffprobe", "-version"),
        other => return Err(format!("unknown sidecar: {other}")),
    };

    let output = app
        .shell()
        .sidecar(binary)
        .map_err(|e| format!("sidecar resolve failed: {e}"))?
        .args([flag])
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
