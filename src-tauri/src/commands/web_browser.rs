//! In-app browser window commands.
//!
//! Creates a dedicated `web-browser` window with two child webviews:
//! a 48px toolbar on top (`web-browser-toolbar`) and a content area below
//! (`web-browser-content`). The content webview is the one that navigates
//! to external sites; the toolbar is a static local entry.

use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const WIN_LABEL: &str = "web-browser";
const TOOLBAR_LABEL: &str = "web-browser-toolbar";
const CONTENT_LABEL: &str = "web-browser-content";
const TOOLBAR_HEIGHT: f64 = 48.0;

/// Opens (or focuses) the in-app browser window.
///
/// Must be `async` — `Window::add_child` on Windows deadlocks when invoked
/// from a synchronous command handler (see Webview2 upstream issue).
#[tauri::command]
pub async fn open_web_browser(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_window(WIN_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WindowBuilder::new(&app, WIN_LABEL)
        .title("Motrix ZJ – 内置浏览器")
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("window build failed: {e}"))?;

    let size = window
        .inner_size()
        .map_err(|e| format!("inner_size failed: {e}"))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("scale_factor failed: {e}"))?;
    let logical = size.to_logical::<f64>(scale);

    // Toolbar webview: top 48px, local HTML entry.
    let toolbar = WebviewBuilder::new(TOOLBAR_LABEL, WebviewUrl::App("web-toolbar.html".into()));
    window
        .add_child(
            toolbar,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(logical.width, TOOLBAR_HEIGHT),
        )
        .map_err(|e| format!("toolbar add_child failed: {e}"))?;

    // Content webview: below toolbar, local HTML entry (SiteGrid).
    let content = WebviewBuilder::new(CONTENT_LABEL, WebviewUrl::App("web-content.html".into()));
    window
        .add_child(
            content,
            LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
            LogicalSize::new(logical.width, logical.height - TOOLBAR_HEIGHT),
        )
        .map_err(|e| format!("content add_child failed: {e}"))?;

    Ok(())
}
