# Embedded Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone `web-browser` window with a right-side child-webview panel embedded inside the main application window; toggle via sidebar globe button; hide (off-screen) instead of destroy to preserve login sessions.

**Architecture:** Two Tauri child webviews (`web-panel-toolbar`, `web-panel-content`) attached to the existing `main` window. Rust owns creation/positioning/visibility via a single `Mutex`-wrapped `WebPanelState`. Vue reserves matching CSS space via a placeholder div and stays in sync through a `web-panel-state-changed` event.

**Tech Stack:** Tauri 2 (Rust), Vue 3 Composition API, Pinia, Naive UI, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-24-embedded-web-panel-design.md`

---

## Ground Rules for This Plan

- **TDD where testable**: Vue reactive state changes + config round-trip get Vitest tests. Rust webview positioning is GUI behavior — verified via `cargo check` and manual QA per AGENTS.md Section I (no browser-based tests for Tauri).
- **Commit after each task**: Each task ends with a git commit so partial progress can be reverted cleanly.
- **Verification before commit**: Every task that touches TS must pass `npx vue-tsc --noEmit`. Every task that touches Rust must pass `cargo check` in `src-tauri/`.
- **Label invariants**: After Task 4, anywhere that said `web-browser-content` now says `web-panel-content`, and anywhere that said `web-browser-toolbar` now says `web-panel-toolbar`. No stale references.

---

## Task 1: Add `webPanelWidth` config key

**Files:**
- Modify: `src/shared/types.ts` (AppConfig interface, around line 289)
- Modify: `src/shared/constants.ts` (DEFAULT_APP_CONFIG, around line 305)
- Modify: `src/shared/configKeys.ts` (userKeys array, around line 61)

- [ ] **Step 1: Add field to AppConfig interface**

In `src/shared/types.ts`, find the block near line 285 that ends with `fileAllocation: string`, and add the new field right before `/** Per-tab sort configuration... */`:

```ts
  /** Disk space pre-allocation method. Maps to aria2 --file-allocation.
   *  Values: 'none' | 'trunc' | 'prealloc' | 'falloc' */
  fileAllocation: string
  /** Logical pixel width of the embedded web browser panel on the right of the main window.
   *  Clamped at runtime so the main content area keeps at least 320px visible. */
  webPanelWidth: number
  /** Per-tab sort configuration (field + direction), persisted independently per tab. */
  taskSort: import('@/composables/useTaskSort').TaskSortConfig
```

- [ ] **Step 2: Add default value**

In `src/shared/constants.ts`, find the `// ── Power Management ──────` comment near line 304 and add a new section above it:

```ts
  // ── Embedded Web Panel ──────────────────────────────────────────
  webPanelWidth: 960,

  // ── Power Management ────────────────────────────────────────────
  shutdownWhenComplete: false,
```

- [ ] **Step 3: Register as user-persisted key**

In `src/shared/configKeys.ts`, add `'web-panel-width'` to the `userKeys` array in alphabetical position (between `'update-channel'` and the closing `]`). Insert this as a new line after `'update-channel',`:

```ts
  'update-channel',
  'web-panel-width',
]
```

- [ ] **Step 4: Write failing test for config round-trip**

Create `src/shared/__tests__/configKeys.webPanel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { userKeys } from '@shared/configKeys'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import type { AppConfig } from '@shared/types'

describe('webPanelWidth config key', () => {
  it('is registered in userKeys so it persists across app restarts', () => {
    expect(userKeys).toContain('web-panel-width')
  })

  it('has a default value of 960 logical pixels', () => {
    expect(DEFAULT_APP_CONFIG.webPanelWidth).toBe(960)
  })

  it('is typed as number on AppConfig', () => {
    const config: AppConfig = { ...DEFAULT_APP_CONFIG }
    config.webPanelWidth = 1200
    expect(typeof config.webPanelWidth).toBe('number')
  })
})
```

- [ ] **Step 5: Run the test**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
npx vitest run src/shared/__tests__/configKeys.webPanel.test.ts
```

Expected: **3 passing**.

- [ ] **Step 6: Type check**

```bash
npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/shared/configKeys.ts src/shared/__tests__/configKeys.webPanel.test.ts
git commit -m "feat(config): add webPanelWidth preference with 960px default"
```

---

## Task 2: Add `webPanelOpen` runtime state to useAppStore

**Files:**
- Modify: `src/stores/app.ts` (around line 88 for declaration, line 349 for return)

- [ ] **Step 1: Write failing test**

Create `src/stores/__tests__/appStore.webPanel.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '@/stores/app'

describe('useAppStore webPanelOpen', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defaults webPanelOpen to false', () => {
    const store = useAppStore()
    expect(store.webPanelOpen).toBe(false)
  })

  it('allows toggling webPanelOpen', () => {
    const store = useAppStore()
    store.webPanelOpen = true
    expect(store.webPanelOpen).toBe(true)
    store.webPanelOpen = false
    expect(store.webPanelOpen).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run src/stores/__tests__/appStore.webPanel.test.ts
```

Expected: **FAIL** — `store.webPanelOpen` is `undefined`.

- [ ] **Step 3: Add state declaration**

In `src/stores/app.ts`, find the line `const pendingMagnetGids = ref<string[]>([])` around line 89 and add below it:

```ts
  const pendingMagnetGids = ref<string[]>([])
  /** Whether the embedded web browser panel is visible on the right of the main window.
   *  Driven by the Rust `web-panel-state-changed` event to stay in sync with the
   *  native child webviews' visibility. Not persisted — panel always starts closed. */
  const webPanelOpen = ref(false)
  /** Protocols detected as hijacked at startup (set by syncProtocolHandlers). */
```

- [ ] **Step 4: Export state in return object**

In the same file, find the `return {` block around line 349. Insert `webPanelOpen,` right after `pendingMagnetGids,`:

```ts
    pendingMagnetGids,
    webPanelOpen,
    updateInterval,
```

- [ ] **Step 5: Run test to confirm pass**

```bash
npx vitest run src/stores/__tests__/appStore.webPanel.test.ts
```

Expected: **2 passing**.

- [ ] **Step 6: Type check**

```bash
npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/stores/app.ts src/stores/__tests__/appStore.webPanel.test.ts
git commit -m "feat(store): add webPanelOpen runtime state to appStore"
```

---

## Task 3: Rewrite `web_browser.rs` to embedded panel model

Replaces the standalone window command with a toggle command that attaches two child webviews to the **main** window. Labels change from `web-browser-{toolbar,content}` to `web-panel-{toolbar,content}`. The old `open_web_browser` function is deleted. `WebPanelState` is introduced for lifecycle tracking.

**Files:**
- Rewrite: `src-tauri/src/commands/web_browser.rs`

- [ ] **Step 1: Replace the entire file**

Overwrite `src-tauri/src/commands/web_browser.rs` with the complete listing below:

```rust
//! Embedded web-browser panel attached to the main window.
//!
//! The panel consists of two child webviews on the main window:
//!   * `web-panel-toolbar`   — 48px strip at top-right, local `web-toolbar.html`
//!   * `web-panel-content`   — fills the rest of the panel, local `web-content.html`
//!
//! Lifecycle:
//!   * First toggle-open call:   create both child webviews, position on right.
//!   * Subsequent close:         resize to zero + move off-screen (webviews stay alive;
//!                               login sessions and in-progress video playback persist).
//!   * Subsequent open:          resize back + move to right-panel coords.
//!   * Main window resize:       re-apply right-panel coords if visible.
//!   * App exit:                 children auto-destroyed with parent window.

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
const MIN_MAIN_CONTENT_WIDTH: f64 = 320.0;

/// Internal state tracking whether the panel webviews have been created
/// and whether they are currently visible. Managed via `app.manage()`.
#[derive(Default)]
pub struct WebPanelInner {
    pub created: bool,
    pub visible: bool,
    pub width: f64,
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
/// and the configured panel width. Falls back to (0.0, 0.0) if the window
/// is so narrow that no panel fits (clamped by `MIN_MAIN_CONTENT_WIDTH`).
fn compute_panel_rects(
    window_width: f64,
    window_height: f64,
    config_width: f64,
) -> (LogicalPosition<f64>, LogicalSize<f64>, LogicalPosition<f64>, LogicalSize<f64>) {
    let effective = (window_width - MIN_MAIN_CONTENT_WIDTH)
        .max(0.0)
        .min(config_width.max(0.0));
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
fn apply_panel_layout(app: &AppHandle, inner: &WebPanelInner) {
    let Some(toolbar_wv) = app.get_webview(TOOLBAR_LABEL) else { return };
    let Some(content_wv) = app.get_webview(CONTENT_LABEL) else { return };

    if inner.visible {
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
    // 1. Compute target visibility under the lock; release before doing I/O.
    let (target_visible, effective_width, need_create) = {
        let mut inner = state.0.lock().map_err(|e| format!("state lock poisoned: {e}"))?;
        if let Some(w) = width {
            if w > 0.0 {
                inner.width = w;
            }
        }
        if inner.width <= 0.0 {
            inner.width = 960.0;
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
    fn panel_rects_basic() {
        let (tp, ts, cp, cs) = compute_panel_rects(1200.0, 800.0, 960.0);
        assert_eq!(tp.x, 240.0);
        assert_eq!(tp.y, 0.0);
        assert_eq!(ts.width, 960.0);
        assert_eq!(ts.height, TOOLBAR_HEIGHT);
        assert_eq!(cp.x, 240.0);
        assert_eq!(cp.y, TOOLBAR_HEIGHT);
        assert_eq!(cs.width, 960.0);
        assert_eq!(cs.height, 800.0 - TOOLBAR_HEIGHT);
    }

    #[test]
    fn panel_rects_clamps_when_window_too_narrow() {
        // Window is 500px wide; MIN_MAIN_CONTENT_WIDTH = 320 → panel ≤ 180.
        let (_tp, ts, _cp, cs) = compute_panel_rects(500.0, 600.0, 960.0);
        assert_eq!(ts.width, 180.0);
        assert_eq!(cs.width, 180.0);
    }

    #[test]
    fn panel_rects_zero_when_window_smaller_than_min_content() {
        // Window smaller than MIN_MAIN_CONTENT_WIDTH — panel collapses to 0.
        let (_tp, ts, _cp, cs) = compute_panel_rects(200.0, 400.0, 960.0);
        assert_eq!(ts.width, 0.0);
        assert_eq!(cs.width, 0.0);
    }

    #[test]
    fn panel_rects_respects_smaller_config_width() {
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
```

- [ ] **Step 2: Run Rust unit tests**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next/src-tauri
cargo test --lib web_browser::tests
```

Expected: **5 passing** (`panel_rects_basic`, `panel_rects_clamps_when_window_too_narrow`, `panel_rects_zero_when_window_smaller_than_min_content`, `panel_rects_respects_smaller_config_width`, `hidden_rect_is_off_screen_with_zero_size`).

- [ ] **Step 3: Cargo check**

```bash
cargo check
```

Expected: compiles with zero errors. There will be an error about `open_web_browser` not being in `web_browser` module — this is resolved in Task 4.

**Note:** Do NOT commit this step alone — Task 4 is required before the project builds end-to-end.

---

## Task 4: Register new state and command in `lib.rs`, remove old command

**Files:**
- Modify: `src-tauri/src/lib.rs` (manage block near line 817, invoke_handler list near line 913, setup_app near line 192)

- [ ] **Step 1: Register `WebPanelState` in `setup_app`**

Find the section near line 192 that ends with:

```rust
    // App lifecycle — tracks cold-start vs runtime phase for autostart
    // visibility decisions.  See AppLifecycleState doc and issue #206.
    app.manage(AppLifecycleState::new());
```

Add immediately after:

```rust
    app.manage(AppLifecycleState::new());

    // Embedded web-panel state — child webviews attached to the main window.
    // The resize hook is installed below once the main window exists.
    app.manage(commands::web_browser::WebPanelState::new());
```

- [ ] **Step 2: Install the main-window resize hook**

Still in `setup_app`, locate the function's final `Ok(())` return. Insert two lines immediately before it — the existing `Ok(())` stays untouched:

```rust
    // ... existing setup body ends here ...

    // Keep panel webviews anchored to the right edge whenever the window resizes.
    commands::web_browser::install_main_window_resize_hook(app.handle());

    Ok(())
}
```

If `setup_app` has conditional branches that each return `Ok(())`, insert the hook call only before the one at the end of the main body (the non-error happy path).

- [ ] **Step 3: Swap command in `invoke_handler` list**

Find the handler list near line 913:

```rust
            commands::open_web_browser,
            commands::web_browser_navigate,
            commands::save_cookies_and_trigger_download,
```

Replace with:

```rust
            commands::toggle_web_panel,
            commands::web_browser_navigate,
            commands::save_cookies_and_trigger_download,
```

- [ ] **Step 4: Cargo check**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next/src-tauri
cargo check
```

Expected: zero errors.

- [ ] **Step 5: Clippy**

```bash
cargo clippy -- -D warnings
```

Expected: zero warnings.

- [ ] **Step 6: Commit**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
git add src-tauri/src/commands/web_browser.rs src-tauri/src/lib.rs
git commit -m "feat(panel): embed web browser as right-side child webviews on main window"
```

---

## Task 5: Update `AsideBar.vue` to toggle the panel

**Files:**
- Modify: `src/components/layout/AsideBar.vue`

- [ ] **Step 1: Replace script + button**

Replace the content of `src/components/layout/AsideBar.vue` with this exact file:

```vue
<script setup lang="ts">
/** @fileoverview Sidebar navigation component. */
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'

import { NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { ListOutline, AddOutline, SettingsOutline, HelpCircleOutline, GlobeOutline } from '@vicons/ionicons5'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const emit = defineEmits<{ 'show-about': [] }>()

function nav(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}

function showAddTask() {
  appStore.showAddTaskDialog()
}

async function toggleWebPanel() {
  try {
    await invoke('toggle_web_panel', {
      open: !appStore.webPanelOpen,
      width: preferenceStore.config.webPanelWidth,
    })
  } catch (e) {
    logger.warn('AsideBar', `toggle_web_panel failed: ${e}`)
  }
}
</script>

<template>
  <aside class="aside" data-tauri-drag-region>
    <div class="aside-inner" data-tauri-drag-region>
      <h1 class="logo-mini">
        <a target="_blank" href="https://github.com/AnInsomniacy/motrix-next/">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="18" viewBox="0 0 40 18">
            <rect
              x="0.5"
              y="0.5"
              width="39"
              height="17"
              rx="4"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            />
            <text
              x="20"
              y="13"
              fill="currentColor"
              font-family="Arial, Helvetica, sans-serif"
              font-weight="900"
              font-size="10"
              text-anchor="middle"
              letter-spacing="1"
            >
              ZJ
            </text>
          </svg>
        </a>
      </h1>
      <ul class="menu top-menu" data-tauri-drag-region>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.task-list')"
                @click="nav('/task/all')"
              >
                <NIcon :size="20"><ListOutline /></NIcon>
              </button>
            </template>
            {{ t('app.task-list') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.add-task')"
                @click="showAddTask"
              >
                <NIcon :size="20"><AddOutline /></NIcon>
              </button>
            </template>
            {{ t('app.add-task') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :class="{ active: appStore.webPanelOpen }"
                aria-label="Web 浏览器面板"
                @click="toggleWebPanel"
              >
                <NIcon :size="20"><GlobeOutline /></NIcon>
              </button>
            </template>
            Web 浏览器面板
          </MTooltip>
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.about')"
                @click="emit('show-about')"
              >
                <NIcon :size="20"><HelpCircleOutline /></NIcon>
              </button>
            </template>
            {{ t('app.about') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.preferences')"
                @click="nav('/preference/general')"
              >
                <NIcon :size="20"><SettingsOutline /></NIcon>
              </button>
            </template>
            {{ t('app.preferences') }}
          </MTooltip>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.aside {
  width: var(--aside-width);
  height: 100%;
  background-color: var(--aside-bg);
  color: var(--m3-on-surface);
  flex-shrink: 0;
  z-index: 10;
}
.aside-inner {
  display: flex;
  height: 100%;
  flex-flow: column;
}
.logo-mini {
  margin: 0;
  padding: 0;
  width: 100%;
  margin-top: 50px;
}
.logo-mini > a {
  display: block;
  width: 40px;
  height: 18px;
  text-align: center;
  font-size: 0;
  outline: none;
  padding: 2px;
  margin: 0 auto;
}
.menu {
  list-style: none;
  padding: 0;
  margin: 0 auto;
  user-select: none;
  cursor: default;
}
.menu > li {
  margin-top: 24px;
}
.menu-button {
  width: 32px;
  height: 32px;
  cursor: pointer;
  border-radius: 16px;
  transition: background-color 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--m3-on-surface-variant);
  background: transparent;
  border: none;
  padding: 0;
}
.menu-button:hover,
.menu-button:focus-visible {
  background-color: var(--aside-icon-hover-bg);
  color: var(--m3-on-surface);
  outline: none;
}
.menu-button.active {
  background-color: var(--aside-icon-hover-bg);
  color: var(--m3-on-surface);
}
.top-menu {
  flex: 1;
}
.bottom-menu {
  margin-bottom: 24px;
}
</style>
```

- [ ] **Step 2: Type check**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AsideBar.vue
git commit -m "feat(sidebar): wire globe button to toggle_web_panel + active state"
```

---

## Task 6: Add close button to `WebToolbar.vue`

**Files:**
- Modify: `src/web/toolbar/WebToolbar.vue`

- [ ] **Step 1: Replace file**

Overwrite `src/web/toolbar/WebToolbar.vue` with:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
}>()

const emit = defineEmits<{
  back: []
  forward: []
  reload: []
  home: []
  navigate: [url: string]
  download: [url: string]
  close: []
}>()

const input = ref(props.currentUrl)
watch(
  () => props.currentUrl,
  (u) => {
    input.value = u
  },
)

const isDownloadable = () => /^https?:\/\//i.test(props.currentUrl)

function onEnter() {
  const v = input.value.trim()
  if (v) emit('navigate', v)
}
</script>

<template>
  <div class="web-toolbar">
    <button class="btn btn-back" :disabled="!canGoBack" aria-label="后退" @click="emit('back')">←</button>
    <button class="btn btn-forward" :disabled="!canGoForward" aria-label="前进" @click="emit('forward')">→</button>
    <button class="btn btn-reload" aria-label="刷新" @click="emit('reload')">↻</button>
    <button class="btn btn-home" aria-label="首页" @click="emit('home')">🏠</button>
    <input
      v-model="input"
      type="text"
      class="url-input"
      placeholder="输入网址或粘贴视频页链接"
      @keydown.enter="onEnter"
    />
    <button class="btn btn-download" :disabled="!isDownloadable()" @click="emit('download', currentUrl)">
      下载视频
    </button>
    <button class="btn btn-close" aria-label="关闭面板" @click="emit('close')">✕</button>
  </div>
</template>

<style scoped>
.web-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 48px;
  padding: 0 8px;
  background: #f8f8f8;
  border-bottom: 1px solid #e0e0e0;
  font-size: 13px;
}
.btn {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: white;
  cursor: pointer;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-download {
  margin-left: 4px;
  padding: 0 14px;
  background: #15803d;
  color: white;
  border-color: #15803d;
  font-weight: 600;
}
.btn-download:hover:not(:disabled) {
  background: #166534;
}
.btn-close {
  margin-left: 4px;
  color: #666;
  font-weight: 600;
}
.btn-close:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #991b1b;
}
.url-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  font-size: 13px;
}
.url-input:focus {
  outline: none;
  border-color: #15803d;
}
</style>
```

- [ ] **Step 2: Type check**

```bash
npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/toolbar/WebToolbar.vue
git commit -m "feat(web-toolbar): add × close button with red hover accent"
```

---

## Task 7: Wire close event in `WebToolbarApp.vue`

**Files:**
- Modify: `src/web/toolbar/WebToolbarApp.vue`

- [ ] **Step 1: Replace file**

Overwrite `src/web/toolbar/WebToolbarApp.vue` with:

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import WebToolbar from './WebToolbar.vue'

const currentUrl = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)
let stop: (() => void) | null = null

onMounted(async () => {
  stop = await listen<{ url: string; canGoBack: boolean; canGoForward: boolean }>(
    'web-browser-url-changed',
    ({ payload }) => {
      currentUrl.value = payload.url
      canGoBack.value = payload.canGoBack
      canGoForward.value = payload.canGoForward
    },
  )
})
onBeforeUnmount(() => {
  if (stop) stop()
})

function nav(action: string, url?: string) {
  invoke('web_browser_navigate', { action, url: url ?? null })
}
function download(url: string) {
  invoke('save_cookies_and_trigger_download', { url })
}
function close() {
  invoke('toggle_web_panel', { open: false, width: null })
}
</script>

<template>
  <WebToolbar
    :current-url="currentUrl"
    :can-go-back="canGoBack"
    :can-go-forward="canGoForward"
    @back="nav('back')"
    @forward="nav('forward')"
    @reload="nav('reload')"
    @home="nav('home')"
    @navigate="(u) => nav('load', u)"
    @download="download"
    @close="close"
  />
</template>
```

- [ ] **Step 2: Type check**

```bash
npx vue-tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/toolbar/WebToolbarApp.vue
git commit -m "feat(web-toolbar): wire close button to toggle_web_panel"
```

---

## Task 8: Integrate panel into `MainLayout.vue`

Adds a CSS placeholder div, listens for `web-panel-state-changed`, and watches `webPanelWidth` to re-invoke Rust when the preference changes.

**Files:**
- Modify: `src/layouts/MainLayout.vue`

- [ ] **Step 1: Add listener variable declaration**

In `src/layouts/MainLayout.vue`, find the line:

```ts
let unlistenAddFromWeb: (() => void) | null = null
```

Add below it:

```ts
let unlistenAddFromWeb: (() => void) | null = null
let unlistenWebPanelState: (() => void) | null = null
```

- [ ] **Step 2: Add computed for effective panel width**

Find the block near the top of `<script setup>` right after the line `const showEngineOverlay = ref(false)`. Add a computed:

```ts
const showEngineOverlay = ref(false)

/** Width applied to the right-side placeholder, clamped to keep the main
 *  content area at least 320px wide.  Kept in sync with Rust's
 *  `compute_panel_rects` formula so the native webview and DOM placeholder
 *  overlap pixel-perfect. */
const effectivePanelWidth = computed(() => {
  if (!appStore.webPanelOpen) return 0
  const configured = preferenceStore.config.webPanelWidth
  const containerWidth = window.innerWidth
  return Math.max(0, Math.min(configured, containerWidth - 320))
})
```

- [ ] **Step 3: Subscribe to panel state event inside `onMounted`**

Find the `unlistenAddFromWeb = await listen<{ url: string }>(...)` block near line 804. Immediately after that block (after its closing `})`), add:

```ts
  unlistenWebPanelState = await listen<{ open: boolean }>('web-panel-state-changed', ({ payload }) => {
    appStore.webPanelOpen = payload.open
  })

  // Re-invoke Rust whenever the user changes the panel width preference while the
  // panel is open, so the native child webviews resize immediately.  Debounced
  // implicitly by Vue's reactivity (1 flush per tick).
  watch(
    () => preferenceStore.config.webPanelWidth,
    async (width) => {
      if (!appStore.webPanelOpen) return
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('toggle_web_panel', { open: true, width })
      } catch (e) {
        logger.debug('MainLayout.webPanelWidth', String(e))
      }
    },
  )
```

- [ ] **Step 4: Unlisten on unmount**

Find the `onUnmounted` block near line 929. After `if (unlistenAddFromWeb) unlistenAddFromWeb()`, add:

```ts
  if (unlistenAddFromWeb) unlistenAddFromWeb()
  if (unlistenWebPanelState) unlistenWebPanelState()
```

- [ ] **Step 5: Add placeholder div to template**

Find the closing `</main>` tag of `<main class="content">`. Immediately after `</main>`, before `<WindowControls ...>`, add:

```vue
    </main>
    <div
      v-if="appStore.webPanelOpen"
      class="web-panel-placeholder"
      :style="{ width: `${effectivePanelWidth}px` }"
      aria-hidden="true"
    />
    <WindowControls
```

- [ ] **Step 6: Add placeholder CSS**

In the same file's `<style scoped>` block, find `.content {` and add a new rule below its closing `}`:

```css
.content {
  flex: 1;
  overflow-y: auto;
  background-color: var(--main-bg);
}
.web-panel-placeholder {
  flex-shrink: 0;
  height: 100%;
  background-color: transparent;
  pointer-events: none;
}
```

- [ ] **Step 7: Verify type check + test**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
npx vue-tsc --noEmit
```

Expected: zero errors.

```bash
npx vitest run src/layouts/__tests__
```

Expected: all existing layout tests still pass (no regressions).

- [ ] **Step 8: Commit**

```bash
git add src/layouts/MainLayout.vue
git commit -m "feat(layout): reserve right-panel space and sync webPanelOpen via event"
```

---

## Task 9: Manual verification + end-to-end sanity

This task is intentionally manual per AGENTS.md Section I ("DO NOT use browser tools to test this app").

**Files:** none (verification only).

- [ ] **Step 1: Full-project checks**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
pnpm format:check
npx vue-tsc --noEmit
npx vitest run
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test
```

Expected: every command passes with zero errors.

- [ ] **Step 2: Build once to surface bundling issues**

```bash
cd /Users/liuzhuoling/Documents/repos_external/motrix-next
npx vite build
```

Expected: build succeeds, `dist/web-toolbar.html` and `dist/web-content.html` emitted.

- [ ] **Step 3: Ask 灵哥 to verify in `pnpm tauri dev`**

Hand off to 灵哥 with the checklist below. Claude must NOT attempt to run `pnpm tauri dev` and interact with the app — Tauri webviews cannot be driven by browser automation tools.

Manual QA checklist 灵哥 should confirm:

1. Sidebar globe button opens right-side panel; main content area shrinks.
2. Panel toolbar shows address bar, back/forward/reload/home, download, and `✕` close buttons.
3. Clicking `✕` hides the panel; sidebar globe button loses `active` styling.
4. Clicking the globe button again reopens the panel; content is on the same URL as before (hide-not-destroy works).
5. Log into YouTube inside the panel → click `✕` → click globe → still logged in.
6. Start a video in the panel → click `✕` → click globe → video resumes at same timestamp.
7. Resize the main window while panel is open — panel stays anchored to right edge, content area takes the remainder.
8. Minimize window with panel open → restore → panel still there, same state.
9. Maximize main window → panel still pinned to right edge.
10. Open panel → `✕` download button on a video page (e.g. a B站 video) → AddTask dialog appears pre-filled.
11. Quit the app while panel is open → relaunch → panel is closed by default (runtime-only state, correct behavior).
12. Sidebar button tooltip reads "Web 浏览器面板".

- [ ] **Step 4: Commit any polish fixes surfaced by QA**

If QA surfaces minor visual/behavioral issues, commit fixes as separate follow-ups, e.g.:

```bash
git commit -m "fix(panel): <specific issue>"
```

Do NOT create a catch-all "QA fixes" commit.

- [ ] **Step 5: Final commit marker (optional)**

If everything passes QA, no additional commit is needed — the feature is complete.

---

## Summary of Files Touched

| File | Purpose |
|---|---|
| `src/shared/types.ts` | Add `webPanelWidth` to `AppConfig` |
| `src/shared/constants.ts` | `DEFAULT_APP_CONFIG.webPanelWidth = 960` |
| `src/shared/configKeys.ts` | `'web-panel-width'` in `userKeys` |
| `src/shared/__tests__/configKeys.webPanel.test.ts` | Config round-trip tests |
| `src/stores/app.ts` | Add `webPanelOpen` reactive state |
| `src/stores/__tests__/appStore.webPanel.test.ts` | State reactivity tests |
| `src-tauri/src/commands/web_browser.rs` | Rewrite to embedded-panel model, add `toggle_web_panel`, `WebPanelState`, `install_main_window_resize_hook`, inline unit tests |
| `src-tauri/src/lib.rs` | Manage `WebPanelState`, install resize hook, swap handler command |
| `src/components/layout/AsideBar.vue` | Toggle button + active state |
| `src/web/toolbar/WebToolbar.vue` | `✕` close button |
| `src/web/toolbar/WebToolbarApp.vue` | Wire close → `toggle_web_panel(false)` |
| `src/layouts/MainLayout.vue` | Placeholder div, state event listener, width watcher |
