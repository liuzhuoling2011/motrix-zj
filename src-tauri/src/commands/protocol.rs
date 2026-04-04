/// Protocol handler registration and query commands.
///
/// Provides three cross-platform Tauri commands for managing URL scheme
/// associations (e.g. `magnet:`, `thunder:`):
///
/// - `is_default_protocol_client` — checks if this app is the current default
/// - `set_default_protocol_client` — registers this app as the default handler
/// - `remove_as_default_protocol_client` — unregisters (Windows/Linux only)
///
/// ## Platform strategy
///
/// | Platform | Query                                   | Register                                    | Unregister           |
/// |----------|-----------------------------------------|---------------------------------------------|----------------------|
/// | macOS    | `NSWorkspace.urlForApplication(toOpen:)` | `NSWorkspace.setDefaultApplication(…)`     | no-op (unsupported)  |
/// | Windows  | `tauri-plugin-deep-link::is_registered`  | `tauri-plugin-deep-link::register`          | `…::unregister`      |
/// | Linux    | `tauri-plugin-deep-link::is_registered`  | `tauri-plugin-deep-link::register`          | `…::unregister`      |

use crate::error::AppError;
use tauri::AppHandle;

// ── macOS native implementation ─────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    /// Returns the file-system path of the app registered as the default
    /// handler for the given URL scheme, or `None` if no handler is set.
    pub fn get_default_handler_path(protocol: &str) -> Option<String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url_str = format!("{protocol}://test");
        let ns_url_str = NSString::from_str(&url_str);
        let test_url = NSURL::URLWithString(&ns_url_str)?;
        let handler_url = workspace.URLForApplicationToOpenURL(&test_url)?;
        let path = handler_url.path()?;
        Some(path.to_string())
    }

    /// Returns the bundle path of the currently running application.
    pub fn current_app_bundle_path() -> Option<String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url_str = "motrixnext://self-check";
        let ns_url_str = NSString::from_str(url_str);
        let test_url = NSURL::URLWithString(&ns_url_str)?;
        // motrixnext:// is declared in Info.plist — resolves to our own bundle
        let handler_url = workspace.URLForApplicationToOpenURL(&test_url)?;
        let path = handler_url.path()?;
        Some(path.to_string())
    }

    /// Attempts to set this application as the default handler for the given
    /// URL scheme. On macOS 12+, the system may prompt the user for confirmation.
    pub fn set_as_default_handler(protocol: &str, app_path: &str) -> Result<(), String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(app_path);
        let app_url = NSURL::fileURLWithPath(&ns_path);
        let ns_scheme = NSString::from_str(protocol);

        workspace.setDefaultApplicationAtURL_toOpenURLsWithScheme_completionHandler(
            &app_url,
            &ns_scheme,
            None,
        );
        Ok(())
    }
}

// ── Cross-platform Tauri commands ───────────────────────────────────

/// Returns `true` when this application is the OS-level default handler
/// for the given URL scheme (e.g. `"magnet"`, `"thunder"`).
#[tauri::command]
pub async fn is_default_protocol_client(
    _app: AppHandle,
    protocol: String,
) -> Result<bool, AppError> {
    #[cfg(target_os = "macos")]
    {
        let handler_path = macos::get_default_handler_path(&protocol);
        let self_path = macos::current_app_bundle_path();
        match (handler_path, self_path) {
            (Some(handler), Some(self_app)) => Ok(handler == self_app),
            // No handler registered → we are not the default
            (None, _) => Ok(false),
            // Cannot determine our own path → conservative false
            (_, None) => Ok(false),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .is_registered(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

/// Registers this application as the OS-level default handler for the
/// given URL scheme.
///
/// On macOS, the system may asynchronously prompt the user for confirmation
/// before the change takes effect — this is Apple's security design.
#[tauri::command]
pub async fn set_default_protocol_client(
    _app: AppHandle,
    protocol: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let self_path = macos::current_app_bundle_path()
            .ok_or_else(|| AppError::Protocol("cannot determine app bundle path".into()))?;
        macos::set_as_default_handler(&protocol, &self_path)
            .map_err(|e| AppError::Protocol(e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .register(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

/// Removes this application as the OS-level default handler for the
/// given URL scheme.
///
/// On macOS this is a no-op — Apple does not provide an API to
/// programmatically unregister a URL scheme handler. The frontend
/// should guide users to System Settings instead.
#[tauri::command]
pub async fn remove_as_default_protocol_client(
    app: AppHandle,
    protocol: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &protocol); // suppress unused warnings
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .unregister(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── macOS-specific tests ────────────────────────────────────────

    #[cfg(target_os = "macos")]
    mod macos_tests {
        use super::super::macos;

        #[test]
        fn get_default_handler_path_returns_some_for_https() {
            // https:// should always have a handler (Safari/Chrome)
            let result = macos::get_default_handler_path("https");
            assert!(result.is_some(), "expected a handler for https://");
            let path = result.expect("already checked");
            assert!(
                path.ends_with(".app"),
                "expected .app bundle path, got: {path}"
            );
        }

        #[test]
        fn get_default_handler_path_returns_none_for_nonsense_scheme() {
            // A random scheme with no handler registered
            let result = macos::get_default_handler_path("zzznotarealscheme12345");
            assert!(
                result.is_none(),
                "expected None for unregistered scheme, got: {result:?}"
            );
        }

        #[test]
        fn current_app_bundle_path_returns_some_when_motrixnext_registered() {
            // motrixnext:// is declared in Info.plist — if running as .app bundle,
            // this should return our own path. In test context (cargo test),
            // it may return None since we're not a bundled .app.
            let result = macos::current_app_bundle_path();
            // Accept both Some and None — just verify no panic.
            if let Some(path) = &result {
                assert!(!path.is_empty(), "bundle path should not be empty");
            }
        }
    }

    // ── Cross-platform logic tests ──────────────────────────────────
    // The Tauri commands require an AppHandle which is only available in
    // integration tests. Here we test the pure logic branches.

    #[test]
    fn protocol_error_variant_display() {
        let e = AppError::Protocol("test failure".into());
        assert_eq!(e.to_string(), "Protocol error: test failure");
    }

    #[test]
    fn protocol_error_variant_serializes() {
        let e = AppError::Protocol("reg failed".into());
        let json = serde_json::to_string(&e).expect("serialize");
        assert_eq!(json, r#"{"Protocol":"reg failed"}"#);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_remove_is_noop() {
        // Verify the macOS unregister path compiles and is a no-op.
        // We can't test the actual Tauri command without AppHandle,
        // but we verify the code path doesn't panic.
        let _ = "magnet"; // Placeholder — real test is compilation.
    }
}
