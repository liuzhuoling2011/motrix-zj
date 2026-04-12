//! System proxy detection for Windows, macOS, and Linux.
//!
//! Returns the OS-level HTTP proxy configuration without any external crate
//! dependencies. Each platform uses its native API:
//! - **Windows**: Registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
//! - **macOS**: `networksetup -getwebproxy` on the active network service
//! - **Linux**: `gsettings` for GNOME system proxy
//!
//! Note: SOCKS proxies are reported with `is_socks: true` so the frontend
//! can reject them at the UI level (aria2 does not support SOCKS).

use crate::error::AppError;
use serde::Serialize;

/// Information about the system-configured proxy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyInfo {
    /// Proxy URL, e.g. "http://127.0.0.1:7890"
    pub server: String,
    /// Bypass list from the OS (comma-separated domains/CIDRs)
    pub bypass: String,
    /// True if the detected proxy uses a SOCKS protocol
    pub is_socks: bool,
}

/// Detects the system-level HTTP proxy configuration.
///
/// Returns `Ok(Some(info))` when a proxy is configured and enabled,
/// `Ok(None)` when no proxy is detected or the platform is unsupported.
#[tauri::command]
pub fn get_system_proxy() -> Result<Option<SystemProxyInfo>, AppError> {
    get_system_proxy_impl()
}

// ── Platform implementations ────────────────────────────────────────

#[cfg(target_os = "windows")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .map_err(|e| AppError::Io(format!("Failed to open proxy registry key: {e}")))?;

    let enabled: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return Ok(None);
    }

    let server: String = match settings.get_value("ProxyServer") {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    if server.trim().is_empty() {
        return Ok(None);
    }

    let bypass: String = settings.get_value("ProxyOverride").unwrap_or_default();
    let is_socks = server.to_lowercase().starts_with("socks");

    // Format as URL if bare host:port
    let formatted_server = if server.contains("://") {
        server
    } else {
        format!("http://{server}")
    };

    Ok(Some(SystemProxyInfo {
        server: formatted_server,
        bypass,
        is_socks,
    }))
}

#[cfg(target_os = "macos")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    use std::process::Command;

    // Get the primary network service (usually "Wi-Fi" or "Ethernet")
    let order_output = Command::new("networksetup")
        .args(["-listnetworkserviceorder"])
        .output()
        .map_err(|e| AppError::Io(format!("Failed to run networksetup: {e}")))?;

    let order_text = String::from_utf8_lossy(&order_output.stdout);
    let service = parse_first_service(&order_text).unwrap_or_else(|| "Wi-Fi".to_string());

    // Try HTTP proxy first
    if let Some(info) = query_macos_proxy(&service, "web", false)? {
        return Ok(Some(info));
    }
    // Try HTTPS proxy
    if let Some(info) = query_macos_proxy(&service, "secureweb", false)? {
        return Ok(Some(info));
    }
    // Check SOCKS (report as is_socks=true)
    if let Some(info) = query_macos_proxy(&service, "socksfirewall", true)? {
        return Ok(Some(info));
    }

    Ok(None)
}

#[cfg(target_os = "macos")]
fn parse_first_service(output: &str) -> Option<String> {
    // Lines look like: "(1) Wi-Fi"
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('(') {
            if let Some(pos) = trimmed.find(')') {
                let name = trimmed[pos + 1..].trim();
                if !name.is_empty()
                    && name != "An asterisk (*) denotes that a network service is disabled."
                {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn query_macos_proxy(
    service: &str,
    proxy_type: &str,
    is_socks: bool,
) -> Result<Option<SystemProxyInfo>, AppError> {
    use std::process::Command;

    let flag = match proxy_type {
        "web" => "-getwebproxy",
        "secureweb" => "-getsecurewebproxy",
        "socksfirewall" => "-getsocksfirewallproxy",
        _ => return Ok(None),
    };

    let output = Command::new("networksetup")
        .args([flag, service])
        .output()
        .map_err(|e| AppError::Io(format!("Failed to query {proxy_type} proxy: {e}")))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = String::new();
    let mut port = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("Enabled:") {
            enabled = line.ends_with("Yes");
        } else if line.starts_with("Server:") {
            server = line.trim_start_matches("Server:").trim().to_string();
        } else if line.starts_with("Port:") {
            port = line.trim_start_matches("Port:").trim().to_string();
        }
    }

    if !enabled || server.is_empty() {
        return Ok(None);
    }

    let scheme = if is_socks { "socks5" } else { "http" };
    let formatted = if port.is_empty() || port == "0" {
        format!("{scheme}://{server}")
    } else {
        format!("{scheme}://{server}:{port}")
    };

    Ok(Some(SystemProxyInfo {
        server: formatted,
        bypass: String::new(),
        is_socks,
    }))
}

#[cfg(target_os = "linux")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    use std::process::Command;

    // Check if GNOME proxy mode is 'manual'
    let mode = gsettings_get("org.gnome.system.proxy", "mode")?;
    if mode.trim().trim_matches('\'') != "manual" {
        return Ok(None);
    }

    // Try HTTP proxy
    let host = gsettings_get("org.gnome.system.proxy.http", "host")?;
    let host = host.trim().trim_matches('\'').to_string();
    if !host.is_empty() {
        let port = gsettings_get("org.gnome.system.proxy.http", "port")?;
        let port = port.trim().trim_matches('\'').to_string();
        let server = if port.is_empty() || port == "0" {
            format!("http://{host}")
        } else {
            format!("http://{host}:{port}")
        };

        let ignore_hosts = gsettings_get("org.gnome.system.proxy", "ignore-hosts")?;
        let bypass = parse_gnome_ignore_hosts(&ignore_hosts);

        return Ok(Some(SystemProxyInfo {
            server,
            bypass,
            is_socks: false,
        }));
    }

    // Try SOCKS proxy
    let socks_host = gsettings_get("org.gnome.system.proxy.socks", "host")?;
    let socks_host = socks_host.trim().trim_matches('\'').to_string();
    if !socks_host.is_empty() {
        let socks_port = gsettings_get("org.gnome.system.proxy.socks", "port")?;
        let socks_port = socks_port.trim().trim_matches('\'').to_string();
        let server = if socks_port.is_empty() || socks_port == "0" {
            format!("socks5://{socks_host}")
        } else {
            format!("socks5://{socks_host}:{socks_port}")
        };
        return Ok(Some(SystemProxyInfo {
            server,
            bypass: String::new(),
            is_socks: true,
        }));
    }

    Ok(None)
}

#[cfg(target_os = "linux")]
fn gsettings_get(schema: &str, key: &str) -> Result<String, AppError> {
    use std::process::Command;
    let output = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .map_err(|e| AppError::Io(format!("Failed to run gsettings: {e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "linux")]
fn parse_gnome_ignore_hosts(raw: &str) -> String {
    // gsettings returns: ['localhost', '127.0.0.0/8', '::1']
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches('\'').trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

// Fallback for unsupported platforms (FreeBSD, etc.)
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_proxy_info_serializes_to_camel_case() {
        let info = SystemProxyInfo {
            server: "http://127.0.0.1:7890".into(),
            bypass: "*.local".into(),
            is_socks: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"isSocks\""));
        assert!(json.contains("\"server\""));
        assert!(json.contains("\"bypass\""));
    }

    #[test]
    fn get_system_proxy_does_not_panic() {
        // Must not panic on any platform, even if no proxy is configured
        let result = get_system_proxy();
        assert!(result.is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_first_service_extracts_wifi() {
        let output = r#"An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(2) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
"#;
        assert_eq!(parse_first_service(output), Some("Wi-Fi".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_first_service_returns_none_for_empty() {
        assert_eq!(parse_first_service(""), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_gnome_ignore_hosts_parses_array() {
        let raw = "['localhost', '127.0.0.0/8', '::1']";
        assert_eq!(parse_gnome_ignore_hosts(raw), "localhost,127.0.0.0/8,::1");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_gnome_ignore_hosts_handles_empty() {
        assert_eq!(parse_gnome_ignore_hosts("[]"), "");
    }
}
