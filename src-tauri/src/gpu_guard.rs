//! Linux WebKitGTK GPU rendering guard.
//!
//! WebKitGTK's DMA-BUF renderer can crash on some GPU, driver, and Wayland
//! compositor combinations. Motrix Next defaults Linux to software compositing
//! for stability and lets users opt into DMA-BUF rendering from Advanced
//! preferences.

#[cfg(target_os = "linux")]
use std::io::Write;

#[cfg(any(target_os = "linux", test))]
const SELF_SET_MARKER: &str = "_MOTRIX_DMABUF_SELF_SET";

#[cfg(any(target_os = "linux", test))]
fn data_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("com.motrix.next"))
}

#[cfg(target_os = "linux")]
fn guard_log(message: &str) {
    eprintln!("[motrix-next] {message}");
    if let Some(dir) = data_dir() {
        let log_dir = dir.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("motrix-next.log");
        let timestamp = chrono::Local::now().format("%Y-%m-%d][%H:%M:%S");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "[{timestamp}][INFO][gpu_guard] {message}");
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn read_hardware_rendering_from_config(data_dir: &std::path::Path) -> bool {
    (|| -> Option<bool> {
        let path = data_dir.join("config.json");
        let content = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;
        json.get("preferences")?.get("hardwareRendering")?.as_bool()
    })()
    .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn disable_dmabuf_with_marker() {
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var(SELF_SET_MARKER, "1");
    }
}

#[cfg(target_os = "linux")]
pub fn pre_flight() -> bool {
    if std::env::var(SELF_SET_MARKER).is_ok() {
        unsafe {
            std::env::remove_var(SELF_SET_MARKER);
            std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
        }
        guard_log("gpu_guard: cleared inherited env vars from relaunch");
    } else if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_ok() {
        let disabled = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        guard_log(&format!(
            "gpu_guard: external WEBKIT_DISABLE_DMABUF_RENDERER override disabled={disabled}"
        ));
        return disabled;
    }

    let Some(dir) = data_dir() else {
        guard_log("gpu_guard: cannot resolve data dir, disabling DMA-BUF");
        disable_dmabuf_with_marker();
        return true;
    };

    if read_hardware_rendering_from_config(&dir) {
        guard_log("gpu_guard: hardware rendering enabled by user preference");
        false
    } else {
        disable_dmabuf_with_marker();
        guard_log("gpu_guard: hardware rendering disabled, using software compositing");
        true
    }
}

#[cfg(not(target_os = "linux"))]
pub fn pre_flight() -> bool {
    false
}

pub fn is_hardware_rendering_enabled() -> bool {
    std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
        .map(|v| v != "1" && !v.eq_ignore_ascii_case("true"))
        .unwrap_or(true)
        && cfg!(target_os = "linux")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("motrix-gpu-guard-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    fn write_config(dir: &std::path::Path, hw: bool) {
        let config = serde_json::json!({
            "preferences": {
                "hardwareRendering": hw,
                "logLevel": "debug"
            }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .expect("write config");
    }

    #[test]
    fn read_hw_rendering_defaults_to_false_when_config_absent() {
        let dir = test_dir("read_absent");
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_defaults_to_false_when_key_missing() {
        let dir = test_dir("read_missing_key");
        let config = serde_json::json!({
            "preferences": { "logLevel": "debug" }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_preserves_false() {
        let dir = test_dir("read_false");
        write_config(&dir, false);
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_preserves_true() {
        let dir = test_dir("read_true");
        write_config(&dir, true);
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_defaults_to_false_when_json_malformed() {
        let dir = test_dir("read_malformed");
        fs::write(dir.join("config.json"), "not json at all").unwrap();
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn self_set_marker_is_stable_value() {
        assert_eq!(SELF_SET_MARKER, "_MOTRIX_DMABUF_SELF_SET");
    }

    #[test]
    fn data_dir_ends_with_app_identifier() {
        let dir = data_dir().expect("data_dir must resolve");
        assert!(
            dir.ends_with("com.motrix.next"),
            "data_dir must end with com.motrix.next, got: {:?}",
            dir
        );
    }

    #[test]
    fn pre_flight_function_exists_and_returns_bool() {
        let _result: bool = pre_flight();
    }
}
