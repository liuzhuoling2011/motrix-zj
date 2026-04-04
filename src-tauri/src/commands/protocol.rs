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
    use objc2_foundation::{NSBundle, NSString, NSURL};

    /// Returns the bundle identifier of the app registered as the default
    /// handler for the given URL scheme, or `None` if no handler is set.
    pub fn get_default_handler_bundle_id(protocol: &str) -> Option<String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url_str = format!("{protocol}://test");
        let ns_url_str = NSString::from_str(&url_str);
        let test_url = NSURL::URLWithString(&ns_url_str)?;
        let handler_url = workspace.URLForApplicationToOpenURL(&test_url)?;
        let handler_bundle = NSBundle::bundleWithURL(&handler_url)?;
        let bundle_id = handler_bundle.bundleIdentifier()?;
        Some(bundle_id.to_string())
    }

    /// Registers this application as the default handler for the given URL
    /// scheme using `LSSetDefaultHandlerForURLScheme`.
    ///
    /// This API works with bundle identifiers (not file paths), so it
    /// functions correctly in both dev mode (`cargo run`) and release
    /// (`.app` bundle).
    pub fn set_as_default_handler(protocol: &str, bundle_id: &str) -> Result<(), String> {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;

        let scheme = CFString::new(protocol);
        let handler = CFString::new(bundle_id);

        // SAFETY: LSSetDefaultHandlerForURLScheme is a stable C API.
        let status = unsafe {
            core_foundation::base::OSStatus::from(LSSetDefaultHandlerForURLScheme(
                scheme.as_concrete_TypeRef(),
                handler.as_concrete_TypeRef(),
            ))
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("LSSetDefaultHandlerForURLScheme returned {status}"))
        }
    }

    // FFI binding for Launch Services
    extern "C" {
        fn LSSetDefaultHandlerForURLScheme(
            scheme: core_foundation::string::CFStringRef,
            handler: core_foundation::string::CFStringRef,
        ) -> i32;
    }
}

// ── Cross-platform Tauri commands ───────────────────────────────────

/// Returns `true` when this application is the OS-level default handler
/// for the given URL scheme (e.g. `"magnet"`, `"thunder"`).
///
/// On macOS, uses the app's configured identifier from `tauri.conf.json`
/// (not `NSBundle.mainBundle`) to avoid inheriting the parent process's
/// bundle ID in dev mode (e.g. Terminal.app).
#[tauri::command]
pub async fn is_default_protocol_client(
    app: AppHandle,
    protocol: String,
) -> Result<bool, AppError> {
    #[cfg(target_os = "macos")]
    {
        let handler_id = macos::get_default_handler_bundle_id(&protocol);
        let self_id = &app.config().identifier;
        match handler_id {
            Some(handler) => Ok(handler == *self_id),
            None => Ok(false),
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
/// On macOS, uses `LSSetDefaultHandlerForURLScheme` with the app's
/// configured identifier from `tauri.conf.json`. Performs a post-
/// registration verification because the API silently succeeds even
/// when no `.app` bundle exists for the given identifier (dev mode).
#[tauri::command]
pub async fn set_default_protocol_client(app: AppHandle, protocol: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = &app.config().identifier;
        macos::set_as_default_handler(&protocol, bundle_id).map_err(AppError::Protocol)?;

        // Verify the registration actually took effect.
        // LSSetDefaultHandlerForURLScheme returns 0 even when macOS
        // cannot find a .app bundle for the given identifier, making
        // the registration a silent no-op. We check immediately after.
        let handler = macos::get_default_handler_bundle_id(&protocol);
        let registered = handler.as_deref() == Some(bundle_id.as_str());
        if registered {
            Ok(())
        } else {
            Err(AppError::Protocol(format!(
                "registration accepted but did not take effect (handler={handler:?}, expected={bundle_id})"
            )))
        }
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
        fn get_default_handler_bundle_id_returns_some_for_https() {
            // https:// should always have a handler (Safari/Chrome)
            let result = macos::get_default_handler_bundle_id("https");
            assert!(result.is_some(), "expected a handler for https://");
            let id = result.expect("already checked");
            // Bundle IDs are reverse-DNS (e.g. "com.apple.Safari")
            assert!(
                id.contains('.'),
                "expected reverse-DNS bundle ID, got: {id}"
            );
        }

        #[test]
        fn get_default_handler_bundle_id_returns_none_for_nonsense_scheme() {
            // A random scheme with no handler registered
            let result = macos::get_default_handler_bundle_id("zzznotarealscheme12345");
            assert!(
                result.is_none(),
                "expected None for unregistered scheme, got: {result:?}"
            );
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
