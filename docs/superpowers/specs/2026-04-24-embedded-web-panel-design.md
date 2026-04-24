# Embedded Web Panel — Design Spec

- **Date**: 2026-04-24
- **Owner**: 灵哥 (zoran.liu)
- **Status**: Approved, ready for implementation plan
- **Related files**: `src-tauri/src/commands/web_browser.rs`, `src/components/layout/AsideBar.vue`, `src/layouts/MainLayout.vue`, `src/web/toolbar/WebToolbar.vue`, `src/web/toolbar/WebToolbarApp.vue`

## 1. Goal

Replace the current standalone web-browser window with an **embedded side panel** inside the main application window. Clicking the sidebar globe button opens a right-side panel showing the in-app browser (toolbar + content webview) instead of popping a new OS window, matching the embedded-browser UX in Feishu / Lark.

## 2. Non-Goals (YAGNI)

- Drag-to-resize divider (MVP: fixed width from preference)
- Panel on left / top / bottom — only right side
- Multiple browser tabs
- Panel width settings UI — MVP only stores in `config.json`; UI can come later
- Width/state animations — native webviews cannot animate position smoothly

## 3. Current Architecture

```
Button click → invoke('open_web_browser')
  ↓
Rust creates separate window "web-browser"
  ├─ child webview "web-browser-toolbar" (48px top)   → web-toolbar.html
  └─ child webview "web-browser-content" (below)       → web-content.html
```

Handles Chrome-131 UA injection, stealth script, cookies save → AddTask flow, and URL-change polling for SPA sites.

## 4. Target Architecture

```
Main window "main"
  ├─ main Vue app webview (existing: sidebar + subnav + content)
  ├─ child webview "web-panel-toolbar"  (on toggle)  → web-toolbar.html
  └─ child webview "web-panel-content"  (on toggle)  → web-content.html
```

The two child webviews are positioned over the right portion of the main window. Vue's main app reserves equivalent CSS space so content doesn't render underneath.

## 5. Lifecycle & State

### Rust-side state

```rust
struct WebPanelState(Mutex<WebPanelInner>);

struct WebPanelInner {
    created: bool,    // have the two child webviews been built?
    visible: bool,    // on-screen vs off-screen?
    width: f64,       // logical px (source of truth for current width)
}
```

Registered via `app.manage(WebPanelState(Mutex::new(WebPanelInner::default())))`. A single `Mutex` is simpler than per-field atomics and matches the existing pattern where state transitions are always combined (`created` + `visible` together).

### Transitions

| Trigger | Transition | Rust action |
|---|---|---|
| First open (`created=false`) | `created=true, visible=true` | `add_child` both webviews, position on right |
| Close (`visible=true`) | `visible=false` | `set_position(-20000, -20000)` both webviews |
| Reopen (`visible=false`) | `visible=true` | `set_position` back to right panel coords |
| Width change while open | — | recompute coords, `set_size` + `set_position` both |
| Main window resized | — | if `visible`, recompute right-panel coords |
| Main window closed / app exit | `created=false, visible=false` | Tauri auto-destroys children with parent |

**Why hide instead of destroy**: preserves login sessions, cookies, localStorage, and in-progress video playback between toggles. Matches Feishu behavior. Trade-off accepted: hidden webviews keep ~30–80MB RAM + continue audio playback.

## 6. Rust API

### New command

```rust
#[tauri::command]
async fn toggle_web_panel(
    app: AppHandle,
    state: State<'_, WebPanelState>,
    open: Option<bool>,    // None = toggle current visibility
    width: Option<f64>,    // present on first open & when width prefs change
) -> Result<(), String>
```

**Semantics**:
- `open=Some(true)` → ensure created + visible
- `open=Some(false)` → ensure visible=false (does not destroy)
- `open=None` → toggle visibility (create on first call)
- `width=Some(w)` → update state.width; if visible, recompute positions

### Emit events

After every state change, emit to the main window:

```
event: "web-panel-state-changed"
payload: { open: bool }
```

### Removed / renamed

- ❌ `open_web_browser` — deleted; functionality merged into `toggle_web_panel`
- 🔄 `web_browser_navigate` — kept; internally switches label from `web-browser-content` → `web-panel-content`
- 🔄 `save_cookies_and_trigger_download` — kept; same label rename
- 🔄 `spawn_url_watcher` — kept; polls `web-panel-content` instead
- 🔄 `install_hooks` resize handler — kept; recomputes right-panel coords for both children

## 7. Coordinate Math

Logical dimensions; `toolbar_height = 48.0`.

```rust
// Window bounds
let window_size = main_window.inner_size().to_logical::<f64>(scale);
let W = window_size.width;
let H = window_size.height;

// Effective panel width — reserve 320px for main content when possible.
// If window is too narrow (< 640px) the panel shrinks rather than clipping content.
let effective = (W - 320.0).max(0.0).min(config_width);

// On-screen positions
let toolbar_pos = LogicalPosition::new(W - effective, 0.0);
let toolbar_sz  = LogicalSize::new(effective, 48.0);

let content_pos = LogicalPosition::new(W - effective, 48.0);
let content_sz  = LogicalSize::new(effective, (H - 48.0).max(0.0));

// Off-screen (hide)
let hidden_pos = LogicalPosition::new(-20000.0, -20000.0);
```

Clamp rationale: if the user manually shrinks the window below `effective + 320`, the panel auto-shrinks rather than clipping the main content's sidebar/subnav.

## 8. Frontend Changes

### `shared/types.ts`
- Add `webPanelWidth: number` to `AppConfig`.

### `shared/constants.ts`
- `DEFAULT_APP_CONFIG.webPanelWidth = 960`.

### `shared/configKeys.ts`
- Add `webPanelWidth` to `userKeys`.

### `stores/app.ts`
- Add `webPanelOpen: Ref<boolean>` (default `false`).

### `components/layout/AsideBar.vue`
- Replace `openWebBrowser()`:
  ```ts
  async function toggleWebPanel() {
    await invoke('toggle_web_panel', {
      open: !appStore.webPanelOpen,
      width: preferenceStore.config.webPanelWidth,
    })
  }
  ```
- Button gets `:class="{ active: appStore.webPanelOpen }"` for visual toggle state.

### `layouts/MainLayout.vue`
- Subscribe to `web-panel-state-changed` on mount; update `appStore.webPanelOpen` from payload.
- Template: append placeholder div after `<main class="content">`:
  ```vue
  <div
    v-if="appStore.webPanelOpen"
    class="web-panel-placeholder"
    :style="{ width: `${effectivePanelWidth}px` }"
  />
  ```
- `effectivePanelWidth = Math.max(0, Math.min(config.webPanelWidth, containerWidth - 320))`. Kept in sync with Rust formula so placeholder matches webview.
- Watch `preferenceStore.config.webPanelWidth` → if panel is open, re-invoke `toggle_web_panel({ width })` so Rust updates child webview sizes.

### `web/toolbar/WebToolbar.vue`
- Add close `×` button after download button:
  ```vue
  <button class="btn btn-close" aria-label="关闭" @click="emit('close')">×</button>
  ```
- Emit new event `close`.

### `web/toolbar/WebToolbarApp.vue`
- Handle `@close` → `invoke('toggle_web_panel', { open: false })`.

## 9. Sidecar Webview Behavior Preserved

All existing behaviors carry over unchanged, only the webview labels change:

| Feature | Where | Label change |
|---|---|---|
| Chrome-131 UA | `WebviewBuilder.user_agent()` | content webview |
| Stealth init script | `.initialization_script()` | content webview |
| `on_page_load` → toolbar URL sync | content webview builder | content webview |
| SPA URL watcher (400ms poll) | `spawn_url_watcher` | content webview |
| Download cookies save | `save_cookies_and_trigger_download` | content webview |
| `add-task-from-web` emit → MainLayout | Rust emit + Vue listen | unchanged (same event name) |

## 10. Edge Cases

| Case | Handling |
|---|---|
| Window minimized | Tauri auto-hides children with parent; state unchanged |
| Fullscreen toggle | `Resized` event fires → recompute coords |
| Multi-monitor drag (DPI change) | `Resized` includes scale change → recompute |
| Window < 640px width | `effective` clamps to minimum, panel still shows |
| `webPanelWidth` pref < 320 | preferenceStore validates to 960 on load |
| `toggle_web_panel` create failure | Return error → Vue `message.error`, `appStore.webPanelOpen` not set |
| User changes preferences while closed | Just updates state; next open picks new width |
| App quit / main window close | Children auto-destroyed with parent window |

## 11. Testing Strategy

**Rust side**:
- `cargo check` + `cargo clippy` pass
- Manual verification: toggle on/off, resize window with panel open, width change via edit-config

**Frontend side**:
- `vue-tsc --noEmit` passes
- `vitest` — add unit tests for `toggleWebPanel` emit wiring, preference watcher
- Manual: side panel shows on click, × button closes, YouTube login persists across toggle, resize maintains layout

**UI verification** (灵哥 to verify via `pnpm tauri dev`):
- First click opens panel on right; main content shrinks
- Second click hides panel; main content reclaims space
- Video playing in panel → toggle off → toggle on → still playing from same spot
- Window resize with panel open → panel stays anchored right
- Close × in toolbar → panel hidden, sidebar button de-highlights

## 12. Migration Notes

- No config migration needed — `webPanelWidth` is a pure additive field; legacy `config.json` files without it just get the default via `DEFAULT_APP_CONFIG` merge.
- No DB migration.
- i18n: add `app.web-panel-open` / `app.web-panel-close` across 26 locales via Python batch script (per AGENTS.md Section D).

## 13. Out-of-scope Follow-ups

Possible future tickets, not part of this spec:
- Drag-to-resize divider on panel's left edge
- Settings UI for panel width
- Optional: pause video when hiding panel (driven by a preference)
- Optional: panel-left position toggle
- Open panel to a user-specified URL (integrate with deep links)
