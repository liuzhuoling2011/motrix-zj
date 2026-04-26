//! Embedded web-browser panel attached to the main window.
//!
//! Two implementation paths share the same state machine:
//!   * macOS — a Tauri child webview (`web-browser`) is `add_child`ed to the
//!     main window so we can pin a Chrome UA + stealth init script onto it,
//!     bypassing UA-version checks (Bilibili, etc.). Toolbar buttons proxy
//!     navigation through `web_browser_navigate`.
//!   * Windows / Linux — embedding a child webview into the host window has
//!     known WebView2 / WebKitGTK regressions, so the frontend renders an
//!     `<iframe>` instead. The shared Chrome UA on the main webview
//!     (`tauri.conf.json > userAgent`) flows down to the iframe, achieving
//!     the same effect at the network layer.
//!
//! Lifecycle (macOS path):
//!   * First toggle-open: lazily create the child webview at off-screen
//!     coords, then position into the panel area.
//!   * Subsequent close: hide the child webview (login sessions persist).
//!   * Subsequent open: re-position + show.
//!   * Frontend toggles content visibility separately so SiteGrid (Vue) can
//!     show through when no URL is loaded.
//!   * Main window resize: re-apply panel coords if visible.

use serde::Deserialize;
use std::sync::Mutex;
use tauri::webview::Cookie;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const CONTENT_LABEL: &str = "web-browser";
const PANEL_TOOLBAR_HEIGHT: f64 = 48.0;
const PANEL_ASIDE_WIDTH: f64 = 78.0;
const PANEL_SUBNAV_WIDTH: f64 = 200.0;
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
    /// macOS only: whether the child webview should be visible right now
    /// (false = Vue SiteGrid shows through, true = the loaded URL shows).
    /// On other platforms this flag has no native effect — the iframe
    /// drives content visibility itself.
    pub content_visible: bool,
    pub width: f64,
}

impl Default for WebPanelInner {
    fn default() -> Self {
        Self {
            created: false,
            visible: false,
            suspended: false,
            content_visible: false,
            // 0 = auto — compute_panel_geometry derives W from main_w - aside - subnav.
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

/// Computes the child-webview rectangle inside the main window's client
/// area for the embedded panel.
///
/// `panel_width = 0` means auto: panel fills the area normally taken by
/// aside (78px) + subnav (200px) + content. Positive `panel_width` is
/// treated as an explicit user-set width, clamped so the main view keeps
/// at least `MIN_MAIN_CONTENT_WIDTH` (320px) on the left.
///
/// Returns `(position, size)` for the content webview (the toolbar above
/// it lives in the Vue layer, not as a separate webview).
fn compute_panel_geometry(
    window_width: f64,
    window_height: f64,
    config_width: f64,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let panel_width = if config_width <= 0.0 {
        (window_width - PANEL_ASIDE_WIDTH - PANEL_SUBNAV_WIDTH).max(0.0)
    } else {
        (window_width - MIN_MAIN_CONTENT_WIDTH)
            .max(0.0)
            .min(config_width)
    };

    let x = (window_width - panel_width).max(0.0);
    let y = PANEL_TOOLBAR_HEIGHT;
    let h = (window_height - PANEL_TOOLBAR_HEIGHT).max(0.0);

    (LogicalPosition::new(x, y), LogicalSize::new(panel_width, h))
}

const HIDDEN_POS: LogicalPosition<f64> = LogicalPosition::new(-20000.0, -20000.0);
const HIDDEN_SIZE: LogicalSize<f64> = LogicalSize::new(0.0, 0.0);

/// Re-applies the desired layout (geometry + visibility) of the macOS
/// child webview based on `WebPanelInner`. No-op on other platforms,
/// where the panel is rendered with an `<iframe>` in the Vue layer.
#[cfg(target_os = "macos")]
fn apply_panel_layout(app: &AppHandle, inner: &WebPanelInner) {
    let Some(webview) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let Some(main) = app.get_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let panel_open = inner.visible && !inner.suspended;
    if !panel_open {
        let _ = webview.hide();
        let _ = webview.set_position(HIDDEN_POS);
        let _ = webview.set_size(HIDDEN_SIZE);
        return;
    }

    let scale = main.scale_factor().unwrap_or(1.0);
    let phys = match main.inner_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let main_w = phys.width as f64 / scale;
    let main_h = phys.height as f64 / scale;

    let (pos, size) = compute_panel_geometry(main_w, main_h, inner.width);
    let _ = webview.set_position(pos);
    let _ = webview.set_size(size);

    if inner.content_visible {
        let _ = webview.show();
    } else {
        let _ = webview.hide();
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_panel_layout(_app: &AppHandle, _inner: &WebPanelInner) {
    // Other platforms render the browser via <iframe> in InternalBrowserPanel.vue.
    // The native side only owns visibility state for the Vue placeholder.
}

/// Lazily attaches the child webview to the main window. macOS only —
/// other platforms use the iframe path and never enter this branch.
#[cfg(target_os = "macos")]
fn ensure_panel_child_webview(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::webview::{PageLoadEvent, WebviewBuilder};

    if app.get_webview(CONTENT_LABEL).is_some() {
        return Ok(());
    }
    let main = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let blank: Url = "about:blank"
        .parse()
        .map_err(|e| format!("about:blank parse: {e}"))?;
    let app_for_callback = app.clone();
    // Polling can't safely start until the webview has committed *some*
    // URL — wry 0.54.4 panics on `URL().unwrap()` for an uninitialized
    // WKWebView. We arm the watcher from the first `on_page_load` event,
    // which fires after `about:blank` settles.
    let polling_armed = Arc::new(AtomicBool::new(false));
    let polling_armed_cb = polling_armed.clone();
    let builder = WebviewBuilder::new(CONTENT_LABEL, WebviewUrl::External(blank))
        .user_agent(chrome_user_agent())
        .initialization_script(STEALTH_INIT_SCRIPT)
        .on_page_load(move |_webview, payload| {
            // First load (any event) → arm the URL watcher. Cheap to
            // call swap repeatedly; the watcher only spawns once.
            if !polling_armed_cb.swap(true, Ordering::SeqCst) {
                spawn_url_watcher(app_for_callback.clone());
            }
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let url = payload.url().as_str();
            if url == "about:blank" {
                return;
            }
            let _ = app_for_callback.emit_to(
                MAIN_WINDOW_LABEL,
                "web-browser-url-changed",
                serde_json::json!({ "url": url }),
            );
        });

    main.add_child(builder, HIDDEN_POS, HIDDEN_SIZE)
        .map_err(|e| format!("add_child failed: {e}"))?;

    Ok(())
}

/// Polls the child webview's URL on a 400ms tick to catch SPA navigation
/// (YouTube/Bilibili switch videos via history.pushState, which doesn't
/// fire `on_page_load`). Caller MUST gate this on at least one
/// `on_page_load` having fired — wry 0.54.4 panics on `webview.url()`
/// before any URL has been committed. We still wrap the call in
/// `catch_unwind` as defense-in-depth so a runtime panic on a bad tick
/// can't crash the app.
#[cfg(target_os = "macos")]
fn spawn_url_watcher(app: AppHandle) {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let Some(content) = app.get_webview(CONTENT_LABEL) else {
                return; // child webview destroyed → exit poller
            };
            let url_result = catch_unwind(AssertUnwindSafe(|| content.url()));
            let Ok(Ok(url)) = url_result else {
                continue;
            };
            let s = url.as_str().to_string();
            if s == last || s == "about:blank" {
                continue;
            }
            last = s.clone();
            let _ = app.emit_to(
                MAIN_WINDOW_LABEL,
                "web-browser-url-changed",
                serde_json::json!({ "url": s }),
            );
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn ensure_panel_child_webview(_app: &AppHandle) -> Result<(), String> {
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
    // 0. Self-heal: if a previous lifecycle destroyed the child webview
    //    (e.g. main window torn down in lightweight mode) but the state still
    //    reports `created`, reset so the next branch re-creates it.
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if inner.created && app.get_webview(CONTENT_LABEL).is_none() {
            log::warn!("web-panel: child webview went missing; resetting state");
            inner.created = false;
            inner.visible = false;
            inner.content_visible = false;
        }
    }

    // 1. Compute target visibility under the lock; release before doing I/O.
    let (target_visible, need_create) = {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if let Some(w) = width {
            if w >= 0.0 {
                inner.width = w;
            }
        }
        let next_visible = match open {
            Some(v) => v,
            None => !inner.visible,
        };
        let need_create = !inner.created && next_visible && cfg!(target_os = "macos");
        (next_visible, need_create)
    };

    // 2. Create the child webview lazily on macOS (no-op elsewhere).
    if need_create {
        ensure_panel_child_webview(&app)?;
    }

    // 3. Commit new state + re-apply layout.
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if need_create {
            inner.created = true;
        }
        inner.visible = target_visible;
        // Closing the panel resets content visibility so the next open
        // starts on SiteGrid until the user navigates again.
        if !target_visible {
            inner.content_visible = false;
        }
        apply_panel_layout(&app, &inner);
    }

    app.emit(
        "web-panel-state-changed",
        serde_json::json!({ "open": target_visible }),
    )
    .map_err(|e| format!("emit failed: {e}"))?;

    Ok(())
}

/// macOS only: toggles the child webview's visibility independently of
/// the panel's overall open/close state. Lets the Vue toolbar swap
/// between SiteGrid (no URL) and the loaded page without tearing down
/// the webview. No-op on other platforms (the iframe handles its own
/// visibility).
#[tauri::command]
pub async fn set_web_panel_content_visible(
    app: AppHandle,
    state: State<'_, WebPanelState>,
    visible: bool,
) -> Result<(), String> {
    let inner = {
        let mut guard = state
            .0
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.content_visible = visible;
        WebPanelInner {
            created: guard.created,
            visible: guard.visible,
            suspended: guard.suspended,
            content_visible: guard.content_visible,
            width: guard.width,
        }
    };
    apply_panel_layout(&app, &inner);
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
            content_visible: guard.content_visible,
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
    // macOS loads pages in the child `web-browser` webview, so its cookie
    // store has the site's session. Other platforms load via iframe in
    // the main webview, so `main` is the source of truth.
    #[cfg(target_os = "macos")]
    let content = app
        .get_webview(CONTENT_LABEL)
        .or_else(|| app.get_webview(MAIN_WINDOW_LABEL))
        .ok_or_else(|| "content webview not available".to_string())?;
    #[cfg(not(target_os = "macos"))]
    let content = app
        .get_webview(MAIN_WINDOW_LABEL)
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
    fn panel_geometry_auto_pins_to_right_below_toolbar() {
        // Auto mode: panel width = W - aside - subnav = 1200 - 78 - 200 = 922.
        let (pos, size) = compute_panel_geometry(1200.0, 800.0, 0.0);
        assert_eq!(size.width, 922.0);
        assert_eq!(size.height, 800.0 - PANEL_TOOLBAR_HEIGHT);
        assert_eq!(pos.x, 1200.0 - 922.0);
        assert_eq!(pos.y, PANEL_TOOLBAR_HEIGHT);
    }

    #[test]
    fn panel_geometry_auto_collapses_when_window_smaller_than_chrome() {
        // Auto mode, W < aside + subnav — width clamps to 0, x clamps to W.
        let (pos, size) = compute_panel_geometry(200.0, 400.0, 0.0);
        assert_eq!(size.width, 0.0);
        assert_eq!(pos.x, 200.0);
    }

    #[test]
    fn panel_geometry_explicit_width_clamped_by_min_main_content() {
        // (1200 - 320) = 880 → explicit 960 clamps down to 880.
        let (pos, size) = compute_panel_geometry(1200.0, 800.0, 960.0);
        assert_eq!(size.width, 880.0);
        assert_eq!(pos.x, 320.0);
    }

    #[test]
    fn panel_geometry_explicit_width_respects_smaller_value() {
        let (pos, size) = compute_panel_geometry(2000.0, 1000.0, 640.0);
        assert_eq!(size.width, 640.0);
        assert_eq!(pos.x, 1360.0);
    }

    #[test]
    fn panel_geometry_explicit_width_zero_when_window_smaller_than_min_content() {
        // Window narrower than MIN_MAIN_CONTENT_WIDTH — panel collapses.
        let (pos, size) = compute_panel_geometry(200.0, 400.0, 960.0);
        assert_eq!(size.width, 0.0);
        assert_eq!(pos.x, 200.0);
    }

    #[test]
    fn hidden_constants_are_off_screen_with_zero_size() {
        assert!(HIDDEN_POS.x < 0.0);
        assert!(HIDDEN_POS.y < 0.0);
        assert_eq!(HIDDEN_SIZE.width, 0.0);
        assert_eq!(HIDDEN_SIZE.height, 0.0);
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
