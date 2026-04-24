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
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TOOLBAR_LABEL: &str = "web-panel-toolbar";
const CONTENT_LABEL: &str = "web-panel-content";
const TOOLBAR_HEIGHT: f64 = 48.0;
// Must match `--aside-width` (78px) + `--subnav-width` (200px) in
// src/styles/variables.css.  When config_width == 0 (auto mode), the panel
// takes half of the remaining space, yielding a 50/50 split with `.content`.
const ASIDE_WIDTH: f64 = 78.0;
const SUBNAV_WIDTH: f64 = 200.0;
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

/// Computes the right-panel geometry given the main window's current size
/// and the configured panel width.  When `config_width <= 0`, auto-sizes to
/// half of the remaining content area (window - aside - subnav), yielding
/// a 50/50 split with `.content`.  Otherwise uses `config_width` clamped by
/// `MIN_MAIN_CONTENT_WIDTH` so the main content keeps ≥ 320px visible.
fn compute_panel_rects(
    window_width: f64,
    window_height: f64,
    config_width: f64,
) -> (LogicalPosition<f64>, LogicalSize<f64>, LogicalPosition<f64>, LogicalSize<f64>) {
    let effective = if config_width <= 0.0 {
        ((window_width - ASIDE_WIDTH - SUBNAV_WIDTH) / 2.0).max(0.0)
    } else {
        (window_width - MIN_MAIN_CONTENT_WIDTH)
            .max(0.0)
            .min(config_width)
    };
    let x = window_width - effective;

    let toolbar_pos = LogicalPosition::new(x, 0.0);
    let toolbar_sz = LogicalSize::new(effective, TOOLBAR_HEIGHT);

    let content_pos = LogicalPosition::new(x, TOOLBAR_HEIGHT);
    let content_sz = LogicalSize::new(effective, (window_height - TOOLBAR_HEIGHT).max(0.0));

    (toolbar_pos, toolbar_sz, content_pos, content_sz)
}

/// "Hidden" geometry: zero size + off-screen position. Using both ensures the
/// webview is not painted and cannot receive input events across platforms.
fn hidden_rect() -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (LogicalPosition::new(-20000.0, -20000.0), LogicalSize::new(0.0, 0.0))
}

/// Reads the main window's current logical size. Returns `None` if the
/// window is missing (app is being torn down).
fn main_window_logical_size(app: &AppHandle) -> Option<(f64, f64)> {
    let window = app.get_window(MAIN_WINDOW_LABEL)?;
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().ok()?;
    let logical = size.to_logical::<f64>(scale);
    Some((logical.width, logical.height))
}

/// Applies the current visibility + width to both panel webviews.
/// The panel is on-screen only when the user intent is visible AND no modal
/// has temporarily suspended it.
fn apply_panel_layout(app: &AppHandle, inner: &WebPanelInner) {
    let Some(toolbar_wv) = app.get_webview(TOOLBAR_LABEL) else { return };
    let Some(content_wv) = app.get_webview(CONTENT_LABEL) else { return };

    if inner.visible && !inner.suspended {
        let Some((w, h)) = main_window_logical_size(app) else { return };
        let (tp, ts, cp, cs) = compute_panel_rects(w, h, inner.width);
        let _ = toolbar_wv.set_position(tp);
        let _ = toolbar_wv.set_size(ts);
        let _ = content_wv.set_position(cp);
        let _ = content_wv.set_size(cs);
    } else {
        let (hp, hs) = hidden_rect();
        let _ = toolbar_wv.set_position(hp);
        let _ = toolbar_wv.set_size(hs);
        let _ = content_wv.set_position(hp);
        let _ = content_wv.set_size(hs);
    }
}

/// Creates the two child webviews the first time the panel opens.
/// Caller holds the state lock and has confirmed `!inner.created`.
fn create_panel_webviews(app: &AppHandle, width: f64) -> Result<(), String> {
    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not available".to_string())?;

    let (w, h) = main_window_logical_size(app)
        .ok_or_else(|| "main window size unavailable".to_string())?;
    let (tp, ts, cp, cs) = compute_panel_rects(w, h, width);

    let toolbar = WebviewBuilder::new(TOOLBAR_LABEL, WebviewUrl::App("web-toolbar.html".into()));
    window
        .add_child(toolbar, tp, ts)
        .map_err(|e| format!("toolbar add_child failed: {e}"))?;

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
        .add_child(content, cp, cs)
        .map_err(|e| {
            // Roll back the toolbar if content creation failed.
            if let Some(tb) = app.get_webview(TOOLBAR_LABEL) {
                let _ = tb.close();
            }
            format!("content add_child failed: {e}")
        })?;

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
        let mut inner = state.0.lock().map_err(|e| format!("state lock poisoned: {e}"))?;
        if inner.created {
            let toolbar_alive = app.get_webview(TOOLBAR_LABEL).is_some();
            let content_alive = app.get_webview(CONTENT_LABEL).is_some();
            if !toolbar_alive || !content_alive {
                log::warn!(
                    "web-panel: webviews went missing (toolbar_alive={}, content_alive={}); resetting state",
                    toolbar_alive,
                    content_alive,
                );
                inner.created = false;
                inner.visible = false;
            }
        }
    }

    // 1. Compute target visibility under the lock; release before doing I/O.
    let (target_visible, effective_width, need_create) = {
        let mut inner = state.0.lock().map_err(|e| format!("state lock poisoned: {e}"))?;
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

    // 2. Create webviews outside the lock (Tauri I/O, can block briefly).
    if need_create {
        create_panel_webviews(&app, effective_width)?;
    }

    // 3. Commit new state + re-apply layout.
    {
        let mut inner = state.0.lock().map_err(|e| format!("state lock poisoned: {e}"))?;
        if need_create {
            inner.created = true;
        }
        inner.visible = target_visible;
        apply_panel_layout(&app, &inner);
    }

    // 4. Spawn SPA URL watcher exactly once (first successful creation).
    if need_create {
        spawn_url_watcher(&app);
    }

    // 5. Broadcast state change so the frontend can sync appStore.
    app.emit("web-panel-state-changed", serde_json::json!({ "open": target_visible }))
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
        let mut guard = state.0.lock().map_err(|e| format!("state lock poisoned: {e}"))?;
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
    let Some(window) = app.get_window(MAIN_WINDOW_LABEL) else { return };
    let app2 = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(_) = event {
            let Some(state) = app2.try_state::<WebPanelState>() else { return };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_rects_auto_splits_content_area_50_50() {
        // config_width = 0 → auto mode: panel takes half of (W - aside - subnav).
        // (1200 - 78 - 200) / 2 = 461
        let (tp, ts, cp, cs) = compute_panel_rects(1200.0, 800.0, 0.0);
        assert_eq!(tp.x, 1200.0 - 461.0);
        assert_eq!(tp.y, 0.0);
        assert_eq!(ts.width, 461.0);
        assert_eq!(ts.height, TOOLBAR_HEIGHT);
        assert_eq!(cp.x, 1200.0 - 461.0);
        assert_eq!(cp.y, TOOLBAR_HEIGHT);
        assert_eq!(cs.width, 461.0);
        assert_eq!(cs.height, 800.0 - TOOLBAR_HEIGHT);
    }

    #[test]
    fn panel_rects_auto_collapses_when_window_smaller_than_chrome() {
        // Auto mode, W smaller than aside + subnav — half of negative clamps to 0.
        let (_tp, ts, _cp, cs) = compute_panel_rects(200.0, 400.0, 0.0);
        assert_eq!(ts.width, 0.0);
        assert_eq!(cs.width, 0.0);
    }

    #[test]
    fn panel_rects_explicit_config_width_overrides_auto() {
        // Non-zero config_width switches to explicit sizing, clamped by
        // MIN_MAIN_CONTENT_WIDTH = 320.
        let (tp, ts, _cp, _cs) = compute_panel_rects(1200.0, 800.0, 960.0);
        // (1200 - 320) = 880 → clamped down from 960
        assert_eq!(ts.width, 880.0);
        assert_eq!(tp.x, 320.0);
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
}
