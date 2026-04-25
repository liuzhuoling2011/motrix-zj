//! Embedded web-browser panel attached to the main window.
//!
//! The panel consists of two child webviews on the main window:
//!   * `web-panel-toolbar`   — 48px strip at top-right, local `web-toolbar.html`
//!   * `web-panel-content`   — fills the rest of the panel, local `web-content.html`
//!
//! Lifecycle:
//!   * First toggle-open call: create both child webviews, position on right.
//!   * Subsequent close: resize to zero + move off-screen (webviews stay alive;
//!     login sessions and in-progress video playback persist).
//!   * Subsequent open: resize back + move to right-panel coords.
//!   * Main window resize: re-apply right-panel coords if visible.
//!   * App exit: children auto-destroyed with parent window.

use serde::Deserialize;
use std::sync::Mutex;
use tauri::webview::Cookie;
use tauri::{
    AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(test)]
use tauri::{LogicalPosition, LogicalSize};

const MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_WINDOW_LABEL: &str = "web-browser";
const TOOLBAR_LABEL: &str = "web-panel-toolbar";
const CONTENT_LABEL: &str = BROWSER_WINDOW_LABEL;
#[cfg(test)]
const TOOLBAR_HEIGHT: f64 = 48.0;
#[cfg(test)]
const MIN_MAIN_CONTENT_WIDTH: f64 = 320.0;

/// Internal state tracking whether the panel webviews have been created,
/// whether the user intends them visible, and whether a modal dialog has
/// temporarily suspended display. Managed via `app.manage()`.
///
/// `suspended` exists so the frontend can hide the panel during modal
/// overlays (e.g. AddTask dialog) without changing the user's intent —
/// dismissing the modal restores visibility if `visible` is still true.
pub struct WebPanelInner {
    pub created: bool,
    pub visible: bool,
    pub suspended: bool,
    pub width: f64,
}

impl Default for WebPanelInner {
    fn default() -> Self {
        Self {
            created: false,
            visible: false,
            suspended: false,
            // 0 = auto — compute_panel_rects will 50/50 split the content area.
            width: 0.0,
        }
    }
}

pub struct WebPanelState(pub Mutex<WebPanelInner>);

impl WebPanelState {
    pub fn new() -> Self {
        Self(Mutex::new(WebPanelInner::default()))
    }
}

impl Default for WebPanelState {
    fn default() -> Self {
        Self::new()
    }
}

/// Returns a Chrome-131 User-Agent string matching the host OS.
fn chrome_user_agent() -> &'static str {
    match std::env::consts::OS {
        "macos" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "windows" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        _ => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
}

const STEALTH_INIT_SCRIPT: &str = r#"
(() => {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }); } catch (_) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true }); } catch (_) {}
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
  try {
    const origOpen = window.open;
    window.open = function (url) {
      if (url) { try { window.location.href = String(url); } catch (_) {} }
      return window;
    };
    void origOpen;
  } catch (_) {}
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

/// ≥ 320px visible.
/// Applies the current visibility intent to the standalone browser window.
fn apply_panel_layout(app: &AppHandle, inner: &WebPanelInner) {
    let Some(browser_window) = app.get_window(BROWSER_WINDOW_LABEL) else {
        return;
    };

    if inner.visible && !inner.suspended {
        let _ = browser_window.show();
        let _ = browser_window.set_focus();
    } else {
        let _ = browser_window.hide();
    }
}

#[cfg(test)]
fn compute_panel_rects(
    window_width: f64,
    window_height: f64,
    config_width: f64,
) -> (
    LogicalPosition<f64>,
    LogicalSize<f64>,
    LogicalPosition<f64>,
    LogicalSize<f64>,
) {
    let effective = if config_width <= 0.0 {
        window_width.max(0.0)
    } else {
        (window_width - MIN_MAIN_CONTENT_WIDTH)
            .max(0.0)
            .min(config_width)
    };

    let toolbar_pos = LogicalPosition::new(0.0, 0.0);
    let toolbar_sz = LogicalSize::new(effective, TOOLBAR_HEIGHT);
    let content_pos = LogicalPosition::new(0.0, TOOLBAR_HEIGHT);
    let content_sz = LogicalSize::new(effective, (window_height - TOOLBAR_HEIGHT).max(0.0));

    (toolbar_pos, toolbar_sz, content_pos, content_sz)
}

#[cfg(test)]
fn hidden_rect() -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(-20000.0, -20000.0),
        LogicalSize::new(0.0, 0.0),
    )
}

/// Creates the standalone browser webview the first time the panel opens.
/// Caller holds the state lock and has confirmed `!inner.created`.
#[allow(dead_code)]
fn create_panel_webviews(app: &AppHandle, width: f64) -> Result<(), String> {
    let _ = width;
    if app.get_webview_window(BROWSER_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::App("web-content.html".into()),
    )
    .title("Motrix Next Browser")
    .inner_size(1068.0, 680.0)
    .min_inner_size(720.0, 480.0)
    .center()
    .visible(false)
    .user_agent(chrome_user_agent())
    .initialization_script(STEALTH_INIT_SCRIPT)
    .build()
    .map_err(|e| format!("browser window build failed: {e}"))?;

    Ok(())
}

/// Toggle or explicitly set the embedded web-panel visibility.
///
/// * `open = Some(true)` — ensure created + visible
/// * `open = Some(false)` — ensure hidden (never destroys)
/// * `open = None` — toggle from current visibility
/// * `width` — update the panel width; takes effect immediately if visible
#[tauri::command]
pub async fn toggle_web_panel(
    app: AppHandle,
    state: State<'_, WebPanelState>,
    open: Option<bool>,
    width: Option<f64>,
) -> Result<(), String> {
    // 0. Self-heal: if a previous lifecycle destroyed the child webviews
    //    (e.g. main window torn down in lightweight mode) but the state still
    //    reports `created`, reset so the next branch re-creates them.
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if inner.created {
            let browser_alive = app.get_webview_window(BROWSER_WINDOW_LABEL).is_some();
            if !browser_alive {
                log::warn!("web-panel: browser window went missing; resetting state",);
                inner.created = false;
                inner.visible = false;
            }
        }
    }

    // 1. Compute target visibility under the lock; release before doing I/O.
    let (target_visible, effective_width, need_create) = {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        // 0 = auto mode.  Only overwrite state when the caller supplied a
        // concrete, non-negative width (positive = explicit size, 0 = auto).
        if let Some(w) = width {
            if w >= 0.0 {
                inner.width = w;
            }
        }
        let next_visible = match open {
            Some(v) => v,
            None => !inner.visible,
        };
        let need_create = !inner.created && next_visible;
        (next_visible, inner.width, need_create)
    };

    let _ = (effective_width, need_create);

    // 3. Commit new state + re-apply layout.
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        inner.created = target_visible;
        inner.visible = target_visible;
        apply_panel_layout(&app, &inner);
    }

    app.emit(
        "web-panel-state-changed",
        serde_json::json!({ "open": target_visible }),
    )
    .map_err(|e| format!("emit failed: {e}"))?;

    Ok(())
}

/// Temporarily hide the panel (move webviews off-screen) while a modal
/// overlay is open — without changing the user's visibility intent.
/// When `suspended = false`, restores the panel to whatever visibility the
/// user last set via `toggle_web_panel`. No-op if the panel was never
/// created. Does NOT emit `web-panel-state-changed`, because `appStore.
/// webPanelOpen` still reflects the user's intent.
#[tauri::command]
pub async fn suspend_web_panel(
    app: AppHandle,
    state: State<'_, WebPanelState>,
    suspended: bool,
) -> Result<(), String> {
    let inner = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if !guard.created {
            return Ok(());
        }
        guard.suspended = suspended;
        WebPanelInner {
            created: guard.created,
            visible: guard.visible,
            suspended: guard.suspended,
            width: guard.width,
        }
    };
    apply_panel_layout(&app, &inner);
    Ok(())
}

/// Registers a single main-window resize hook that re-applies panel layout
/// whenever the window changes size. Called once from `setup_app`.
pub fn install_main_window_resize_hook(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let app2 = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(_) = event {
            let Some(state) = app2.try_state::<WebPanelState>() else {
                return;
            };
            let inner = match state.0.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if !inner.created {
                return;
            }
            apply_panel_layout(&app2, &inner);
        }
    });
}

/// Polls the content webview's URL every 400ms and, on change, emits
/// `web-browser-url-changed` to the toolbar. Handles SPA pushState sites
/// (YouTube, Bilibili) where `on_page_load` does not fire.
/// Loops for the remaining process lifetime — panel hide just leaves the
/// URL stable.
#[allow(dead_code)]
fn spawn_url_watcher(app: &AppHandle) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let Some(content) = app.get_webview(CONTENT_LABEL) else {
                return;
            };
            let Ok(url) = content.url() else { continue };
            let s = url.as_str().to_string();
            if s != last {
                last = s.clone();
                let payload = serde_json::json!({
                    "url": s,
                    "canGoBack": true,
                    "canGoForward": true,
                });
                let _ = app.emit_to(TOOLBAR_LABEL, "web-browser-url-changed", payload);
            }
        }
    });
}

fn cookie_header_for_url(cookies: &[Cookie<'_>], url: &str) -> String {
    let Some(target_domain) = Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .and_then(|host| crate::cookies::domain::registrable_domain(&host))
    else {
        return String::new();
    };

    cookies
        .iter()
        .filter(|cookie| {
            cookie
                .domain()
                .and_then(crate::cookies::domain::registrable_domain)
                .as_deref()
                == Some(target_domain.as_str())
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Toolbar → content navigation actions.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NavAction {
    Back,
    Forward,
    Reload,
    Home,
    Load,
}

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
            // Derive the home URL from the toolbar's URL so the scheme + host
            // match the runtime environment (dev = http://localhost:PORT,
            // prod on macOS = tauri://localhost, prod on Windows/Linux =
            // http://tauri.localhost).  Hardcoding `tauri://localhost/...`
            // broke Home in Vite dev mode — the file lived at
            // http://localhost:1420/web-content.html there.
            content
                .eval("window.location.href = '/web-content.html'")
                .map_err(|e| e.to_string())?
        }
        NavAction::Load => {
            let raw = url.ok_or_else(|| "missing url for load action".to_string())?;
            let u = Url::parse(&raw).map_err(|e| format!("invalid url: {e}"))?;
            content.navigate(u).map_err(|e| e.to_string())?
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_cookies_and_trigger_download(
    app: AppHandle,
    store: State<'_, crate::cookies::CookieStore>,
    url: String,
) -> Result<(), String> {
    let content = app
        .get_webview(MAIN_WINDOW_LABEL)
        .or_else(|| app.get_webview(CONTENT_LABEL))
        .ok_or_else(|| "content webview not available".to_string())?;
    let cookies = content
        .cookies()
        .map_err(|e| format!("cookies read failed: {e}"))?;
    let cookie_header = cookie_header_for_url(&cookies, &url);
    let written = store
        .save_from_webview(cookies)
        .map_err(|e| format!("cookies write failed: {e}"))?;
    log::info!(
        "save_cookies_and_trigger_download: saved {} domain(s): {:?}",
        written.len(),
        written,
    );

    app.emit(
        "add-task-from-web",
        serde_json::json!({
            "url": url,
            "referer": url,
            "cookie": cookie_header,
        }),
    )
    .map_err(|e| format!("emit failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_rects_auto_fills_content_area() {
        // config_width = 0 → auto mode: panel takes W - aside - subnav.
        // 1200 - 78 - 200 = 922
        let (tp, ts, cp, cs) = compute_panel_rects(1200.0, 800.0, 0.0);
        assert_eq!(tp.x, 0.0);
        assert_eq!(tp.y, 0.0);
        assert_eq!(ts.width, 1200.0);
        assert_eq!(ts.height, TOOLBAR_HEIGHT);
        assert_eq!(cp.x, 0.0);
        assert_eq!(cp.y, TOOLBAR_HEIGHT);
        assert_eq!(cs.width, 1200.0);
        assert_eq!(cs.height, 800.0 - TOOLBAR_HEIGHT);
    }

    #[test]
    fn panel_rects_auto_collapses_when_window_smaller_than_chrome() {
        // Auto mode, W smaller than aside + subnav — negative clamps to 0.
        let (_tp, ts, _cp, cs) = compute_panel_rects(200.0, 400.0, 0.0);
        assert_eq!(ts.width, 200.0);
        assert_eq!(cs.width, 200.0);
    }

    #[test]
    fn panel_rects_explicit_config_width_overrides_auto() {
        // Non-zero config_width switches to explicit sizing, clamped by
        // MIN_MAIN_CONTENT_WIDTH = 320.
        let (tp, ts, _cp, _cs) = compute_panel_rects(1200.0, 800.0, 960.0);
        // (1200 - 320) = 880 → clamped down from 960
        assert_eq!(ts.width, 880.0);
        assert_eq!(tp.x, 0.0);
    }

    #[test]
    fn panel_rects_explicit_width_clamps_when_window_too_narrow() {
        // Window is 500px wide; MIN_MAIN_CONTENT_WIDTH = 320 → panel ≤ 180.
        let (_tp, ts, _cp, cs) = compute_panel_rects(500.0, 600.0, 960.0);
        assert_eq!(ts.width, 180.0);
        assert_eq!(cs.width, 180.0);
    }

    #[test]
    fn panel_rects_explicit_width_zero_when_window_smaller_than_min_content() {
        // Window smaller than MIN_MAIN_CONTENT_WIDTH — panel collapses to 0.
        let (_tp, ts, _cp, cs) = compute_panel_rects(200.0, 400.0, 960.0);
        assert_eq!(ts.width, 0.0);
        assert_eq!(cs.width, 0.0);
    }

    #[test]
    fn panel_rects_respects_smaller_explicit_config_width() {
        let (_tp, ts, _cp, _cs) = compute_panel_rects(2000.0, 1000.0, 640.0);
        assert_eq!(ts.width, 640.0);
    }

    #[test]
    fn hidden_rect_is_off_screen_with_zero_size() {
        let (pos, size) = hidden_rect();
        assert!(pos.x < 0.0);
        assert!(pos.y < 0.0);
        assert_eq!(size.width, 0.0);
        assert_eq!(size.height, 0.0);
    }

    #[test]
    fn cookie_header_for_url_keeps_target_registrable_domain() {
        let cookies = vec![
            Cookie::build(("SESSDATA".to_string(), "login".to_string()))
                .domain("bilibili.com".to_string())
                .path("/".to_string())
                .build(),
            Cookie::build(("buvid3".to_string(), "guest".to_string()))
                .domain("www.bilibili.com".to_string())
                .path("/".to_string())
                .build(),
            Cookie::build(("SID".to_string(), "other".to_string()))
                .domain("youtube.com".to_string())
                .path("/".to_string())
                .build(),
        ];

        let header =
            cookie_header_for_url(&cookies, "https://www.bilibili.com/video/BV1LRwyz3EcN/");

        assert!(header.contains("SESSDATA=login"));
        assert!(header.contains("buvid3=guest"));
        assert!(!header.contains("SID=other"));
    }
}
