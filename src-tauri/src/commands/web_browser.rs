//! In-app browser window commands.
//!
//! Creates a dedicated `web-browser` window with two child webviews:
//! a 48px toolbar on top (`web-browser-toolbar`) and a content area below
//! (`web-browser-content`). The content webview is the one that navigates
//! to external sites; the toolbar is a static local entry.

use serde::Deserialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl, WindowEvent,
};

const WIN_LABEL: &str = "web-browser";
const TOOLBAR_LABEL: &str = "web-browser-toolbar";
const CONTENT_LABEL: &str = "web-browser-content";
const TOOLBAR_HEIGHT: f64 = 48.0;

/// Returns a Chrome-131 User-Agent string matching the host OS.
///
/// Needed because Tauri's default WebView UA is too bare for sites like
/// Bilibili / 爱奇艺, which detect "old browser" and disable playback when
/// they can't parse Chrome/Safari version numbers.
fn chrome_user_agent() -> &'static str {
    match std::env::consts::OS {
        "macos" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "windows" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        _ => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
}

/// JavaScript injected into every document before page scripts run.
///
/// Does two jobs:
/// 1. **Navigation patches** — redirect `target="_blank"` anchor clicks and
///    `window.open()` calls into the current webview so sites like Bilibili
///    (which uses `_blank` for video cards) don't silently swallow clicks.
/// 2. **Stealth patches** — suppress common bot/automation fingerprints so
///    services like Google Sign-In stop rejecting login as "this browser
///    may not be secure". Note: JS can't fake deep signals (TLS JA3,
///    Client Hints, WebGL GPU strings); for Google OAuth, expect failure
///    regardless — users should use yt-dlp's --cookies-from-browser firefox
///    for YouTube instead.
const STEALTH_INIT_SCRIPT: &str = r#"
(() => {
  // ── Stealth patches ───────────────────────────────────────────────
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch (_) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
  } catch (_) {}
  try {
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins, configurable: true });
  } catch (_) {}
  if (!window.chrome) {
    window.chrome = {
      runtime: { id: undefined, onConnect: undefined, onMessage: undefined },
      loadTimes: () => ({}),
      csi: () => ({}),
      app: { isInstalled: false },
    };
  }
  try {
    // Client Hints — Chromium 131 on matching platform
    if (!navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => ({
          brands: [
            { brand: 'Chromium', version: '131' },
            { brand: 'Google Chrome', version: '131' },
            { brand: 'Not_A Brand', version: '24' },
          ],
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: () => Promise.resolve({
            architecture: 'arm', bitness: '64', model: '',
            platformVersion: '14.0.0', uaFullVersion: '131.0.6778.86',
          }),
        }),
      });
    }
  } catch (_) {}
  try {
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery.call(navigator.permissions, p);
    }
  } catch (_) {}

  // ── Navigation patches (fix Bilibili/etc video card clicks) ──────
  try {
    // Redirect window.open to the current webview.
    const origOpen = window.open;
    window.open = function (url) {
      if (url) {
        try { window.location.href = String(url); } catch (_) {}
      }
      return window;
    };
    void origOpen;
  } catch (_) {}
  // Intercept <a target="_blank"> clicks and navigate in place.
  document.addEventListener('click', (e) => {
    try {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const tgt = a.getAttribute('target');
      if (tgt === '_blank' || tgt === '_new') {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = a.href;
      }
    } catch (_) {}
  }, true);
})();
"#;

/// Opens (or focuses) the in-app browser window.
///
/// Must be `async` — `Window::add_child` on Windows deadlocks when invoked
/// from a synchronous command handler (see Webview2 upstream issue).
#[tauri::command]
pub async fn open_web_browser(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_window(WIN_LABEL) {
        let _ = existing.unminimize();
        let _ = existing.show();
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
    let content_height = (logical.height - TOOLBAR_HEIGHT).max(0.0);

    // Toolbar webview: top 48px, local HTML entry.
    let toolbar = WebviewBuilder::new(TOOLBAR_LABEL, WebviewUrl::App("web-toolbar.html".into()));
    window
        .add_child(
            toolbar,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(logical.width, TOOLBAR_HEIGHT),
        )
        .map_err(|e| {
            // Roll back the half-created window so retries can start clean.
            let _ = window.close();
            format!("toolbar add_child failed: {e}")
        })?;

    // Content webview: below toolbar, local HTML entry (SiteGrid).
    //
    // URL-change forwarding is installed here (on the builder) — Tauri's
    // `on_page_load` is a builder-only hook. When the content webview
    // finishes navigating to a page we forward the URL to the toolbar so
    // its address input stays in sync.
    let app_for_load = app.clone();
    let content = WebviewBuilder::new(CONTENT_LABEL, WebviewUrl::App("web-content.html".into()))
        .user_agent(chrome_user_agent())
        .initialization_script(STEALTH_INIT_SCRIPT)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let url = payload.url().as_str().to_string();
                let payload = serde_json::json!({
                    "url": url,
                    "canGoBack": true,
                    "canGoForward": true,
                });
                let _ = app_for_load.emit_to(TOOLBAR_LABEL, "web-browser-url-changed", payload);
            }
        });
    window
        .add_child(
            content,
            LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
            LogicalSize::new(logical.width, content_height),
        )
        .map_err(|e| {
            let _ = window.close();
            format!("content add_child failed: {e}")
        })?;

    install_hooks(&app)?;

    Ok(())
}

/// Toolbar → content navigation actions.
///
/// Deserialised from `{ action: "back" | "forward" | ... }` payloads sent
/// by the toolbar webview over IPC.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NavAction {
    Back,
    Forward,
    Reload,
    Home,
    Load,
}

/// Executes a navigation action inside the content webview on behalf of
/// the toolbar webview.
///
/// - `Back` / `Forward` / `Reload` drive the History API via `eval`.
/// - `Home` resets to the local SiteGrid entry page.
/// - `Load` navigates to the supplied URL (required for this variant).
#[tauri::command]
pub async fn web_browser_navigate(
    app: AppHandle,
    action: NavAction,
    url: Option<String>,
) -> Result<(), String> {
    let content = app
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "content webview not available".to_string())?;

    match action {
        NavAction::Back => content.eval("history.back()").map_err(|e| e.to_string())?,
        NavAction::Forward => content
            .eval("history.forward()")
            .map_err(|e| e.to_string())?,
        NavAction::Reload => content
            .eval("location.reload()")
            .map_err(|e| e.to_string())?,
        NavAction::Home => {
            let u = Url::parse("tauri://localhost/web-content.html")
                .map_err(|e| e.to_string())?;
            content.navigate(u).map_err(|e| e.to_string())?
        }
        NavAction::Load => {
            let raw = url.ok_or_else(|| "missing url for load action".to_string())?;
            let u = Url::parse(&raw).map_err(|e| format!("invalid url: {e}"))?;
            content.navigate(u).map_err(|e| e.to_string())?
        }
    }
    Ok(())
}

/// Captures cookies from the content webview, groups them by domain into
/// Netscape cookies.txt files under `$APP_DATA/cookies/`, then asks the
/// main window to open AddTask pre-filled with `url`.
///
/// Called by the toolbar "下载视频" button. The WebView window is left open
/// so the user can keep browsing for more videos without re-logging in.
#[tauri::command]
pub async fn save_cookies_and_trigger_download(
    app: AppHandle,
    store: State<'_, crate::cookies::CookieStore>,
    url: String,
) -> Result<(), String> {
    let content = app
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "content webview not available".to_string())?;
    let cookies = content
        .cookies()
        .map_err(|e| format!("cookies read failed: {e}"))?;
    let written = store
        .save_from_webview(cookies)
        .map_err(|e| format!("cookies write failed: {e}"))?;
    log::info!(
        "save_cookies_and_trigger_download: saved {} domain(s): {:?}",
        written.len(),
        written,
    );

    app.emit("add-task-from-web", serde_json::json!({ "url": url }))
        .map_err(|e| format!("emit failed: {e}"))?;
    Ok(())
}

/// Installs a window-level resize handler that keeps both child webviews
/// sized to the window: toolbar stays at `TOOLBAR_HEIGHT` high across the
/// top, content fills the remainder (clamped to zero).
///
/// Called once by `open_web_browser` after both child webviews exist.
/// The URL-change forwarding hook is attached on the content builder
/// itself (see `on_page_load` in `open_web_browser`), because Tauri only
/// exposes that callback on `WebviewBuilder`, not on a constructed
/// `Webview`.
fn install_hooks(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_window(WIN_LABEL)
        .ok_or_else(|| "web-browser window not available".to_string())?;

    // Resize handler: keep toolbar 48px high, content fills the rest.
    let app2 = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(_) = event {
            let Some(window) = app2.get_window(WIN_LABEL) else {
                return;
            };
            let Ok(size) = window.inner_size() else {
                return;
            };
            let Ok(scale) = window.scale_factor() else {
                return;
            };
            let logical = size.to_logical::<f64>(scale);
            let content_height = (logical.height - TOOLBAR_HEIGHT).max(0.0);

            if let Some(toolbar) = app2.get_webview(TOOLBAR_LABEL) {
                let _ = toolbar.set_size(LogicalSize::new(logical.width, TOOLBAR_HEIGHT));
            }
            if let Some(content) = app2.get_webview(CONTENT_LABEL) {
                let _ = content.set_size(LogicalSize::new(logical.width, content_height));
            }
        }
    });

    Ok(())
}
