# WebView Cookie Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app browser that lets users log into video sites and automatically injects the resulting cookies into yt-dlp on subsequent downloads, bypassing Chrome ABE on Windows.

**Architecture:** A dedicated Tauri `Window` labelled `web-browser` with two child `Webview`s — `web-browser-toolbar` (48 px toolbar) and `web-browser-content` (site area). "下载视频" button harvests cookies via `Webview::cookies()`, serialises them as Netscape cookies.txt files under `$APP_DATA/cookies/<domain>.txt`, then emits `add-task-from-web` so the main window reopens AddTask with the URL pre-filled. The yt-dlp client auto-attaches `--cookies <path>` when a matching file exists for the target URL's host.

**Tech Stack:** Rust 2024 edition · Tauri 2.10 with `unstable` feature (for multi-webview) · Vue 3 + Vite multi-entry · Naive UI · yt-dlp sidecar.

---

## File Structure

### New Rust files
- `src-tauri/src/cookies/mod.rs` — module root, re-exports
- `src-tauri/src/cookies/netscape.rs` — Netscape cookies.txt serialiser
- `src-tauri/src/cookies/match.rs` — URL→domain-file matching
- `src-tauri/src/cookies/store.rs` — `CookieStore` (save/resolve)
- `src-tauri/src/commands/web_browser.rs` — Tauri commands & window creation

### New front-end files
- `web-toolbar.html` — second Vite entry for toolbar webview
- `web-content.html` — third Vite entry for content webview's home page
- `src/web/toolbar/main.ts` — toolbar entry bootstrap
- `src/web/toolbar/WebToolbarApp.vue` — toolbar app root
- `src/web/content/main.ts` — content entry bootstrap
- `src/web/content/WebContentApp.vue` — content app root (host of SiteGrid)
- `src/web/content/SiteGrid.vue` — navigation page (6 site cards)
- `src/web/content/sites.ts` — site list
- `src/assets/sites/{bilibili,youku,iqiyi,tencent,mgtv,youtube}.svg` — site icons
- `src-tauri/capabilities/web-browser.json` — capabilities for the web-browser window

### Modified files
- `src-tauri/Cargo.toml` — enable `unstable` feature on tauri
- `src-tauri/src/commands/mod.rs` — register `web_browser` module
- `src-tauri/src/lib.rs` — register new commands + manage `CookieStore`
- `src-tauri/src/ytdlp/client.rs` — add auto-`--cookies` branch in `resolve_args`
- `vite.config.ts` — declare the two extra HTML entries
- `src/components/layout/AsideBar.vue` — add Web icon button
- `src/layouts/MainLayout.vue` — listen for `add-task-from-web`
- `src/components/task/AddTask.vue` — expose URL-prefill path + cookie-expired banner

---

## Task 1: Netscape cookies.txt Serialiser

**Files:**
- Create: `src-tauri/src/cookies/mod.rs`
- Create: `src-tauri/src/cookies/netscape.rs`
- Test: `src-tauri/src/cookies/netscape.rs` (`#[cfg(test)]`)

Reference spec: Netscape cookies.txt is a TAB-separated 7-column format: `domain` · `include_subdomains` (`TRUE`/`FALSE`) · `path` · `secure` (`TRUE`/`FALSE`) · `expiration` (unix seconds, `0` = session) · `name` · `value`. Lines starting with `#` are comments.

- [ ] **Step 1: Create `src-tauri/src/cookies/mod.rs` with placeholder only**

```rust
//! Cookie persistence for the in-app browser login flow.
//!
//! `netscape`  — serialises cookies as yt-dlp-compatible cookies.txt files.
//! `domain`    — URL→domain matching rules for on-disk lookup.
//! `store`     — `CookieStore` writes/reads per-domain files under app data.

pub mod domain;
pub mod netscape;
pub mod store;

pub use store::CookieStore;
```

Create the file with the content above. Note this references `domain` and `store` which don't exist yet — Task 2 and Task 3 create them.

- [ ] **Step 2: Wire the module into the crate**

Edit `src-tauri/src/lib.rs` and add `mod cookies;` alongside the other top-level `mod ...` declarations (around line 1-14 where `mod aria2; mod commands; …` live).

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/cookies/netscape.rs` with the following content:

```rust
//! Netscape cookies.txt serialiser (https://curl.se/docs/http-cookies.html).

use tauri::webview::Cookie;

/// Serialises cookies for a single domain into Netscape cookies.txt format.
///
/// The `domain` argument is the key used to group cookies; each record
/// emitted here must belong to that domain (leading-dot form is accepted,
/// e.g. `.youtube.com`). Session cookies (no expiration) get `0`.
pub fn serialise(cookies: &[Cookie]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n# Written by Motrix ZJ\n\n");
    for c in cookies {
        let domain = c.domain().unwrap_or("");
        let include_sub = if domain.starts_with('.') { "TRUE" } else { "FALSE" };
        let path = c.path().unwrap_or("/");
        let secure = if c.secure().unwrap_or(false) { "TRUE" } else { "FALSE" };
        let expires = c
            .expires_datetime()
            .map(|dt| dt.unix_timestamp())
            .unwrap_or(0);
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            domain,
            include_sub,
            path,
            secure,
            expires,
            c.name(),
            c.value(),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::Cookie;

    fn build(name: &str, value: &str, domain: &str, path: &str, secure: bool, expires: i64) -> Cookie {
        let mut b = Cookie::build((name.to_string(), value.to_string()))
            .domain(domain.to_string())
            .path(path.to_string())
            .secure(secure);
        if expires > 0 {
            b = b.expires(time::OffsetDateTime::from_unix_timestamp(expires).unwrap());
        }
        b.build()
    }

    #[test]
    fn serialises_single_cookie_with_leading_dot_domain() {
        let c = build("SID", "abc", ".youtube.com", "/", true, 1_800_000_000);
        let out = serialise(&[c]);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc"));
    }

    #[test]
    fn session_cookie_expires_zero() {
        let c = build("tmp", "v", "example.com", "/", false, 0);
        let out = serialise(&[c]);
        assert!(out.contains("example.com\tFALSE\t/\tFALSE\t0\ttmp\tv"));
    }

    #[test]
    fn emits_header_comment() {
        let out = serialise(&[]);
        assert!(out.starts_with("# Netscape HTTP Cookie File"));
    }
}
```

- [ ] **Step 4: Verify the test fails**

Run: `cd src-tauri && cargo test --lib cookies::netscape 2>&1 | tail -20`
Expected: compile errors about unresolved `cookies::domain` / `cookies::store` modules referenced from `mod.rs`. That's acceptable — leave it; Task 2 and Task 3 resolve them.

If you want green tests between tasks, temporarily stub `domain.rs` and `store.rs` with empty files containing only `// stub` so the crate compiles. Delete the stubs when Task 2/3 land real code.

- [ ] **Step 5: Make the test pass**

If you added stubs, now confirm:
Run: `cd src-tauri && cargo test --lib cookies::netscape -- --nocapture 2>&1 | tail -20`
Expected: `3 passed`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/cookies/
git commit -m "feat(cookies): netscape cookies.txt serialiser"
```

---

## Task 2: URL → Domain File Matching

**Files:**
- Create: `src-tauri/src/cookies/domain.rs`
- Test: same file (`#[cfg(test)]`)

Spec requirement: given a URL, locate the matching cookies file. Match order: exact host → strip leftmost subdomain until 2-part TLD+SLD; `.X` and `X` treated as equivalent filenames.

- [ ] **Step 1: Write the failing tests**

Overwrite the stub at `src-tauri/src/cookies/domain.rs` with:

```rust
//! Maps an arbitrary URL to the ordered list of candidate cookie filenames
//! to look up on disk.
//!
//! `.youtube.com.txt` and `youtube.com.txt` are treated as equivalent — the
//! lookup tries both forms. The first form matches what most browsers write
//! (cookies scoped to a whole domain include the leading dot).

use url::Url;

/// Returns candidate filenames (without `.txt` suffix) in priority order for
/// the given URL's host. The caller probes each in turn on disk.
///
/// Example: `https://www.youtube.com/watch?v=X` →
///   [".www.youtube.com", "www.youtube.com", ".youtube.com", "youtube.com"]
pub fn candidates_for_url(url: &str) -> Vec<String> {
    let Ok(parsed) = Url::parse(url) else { return Vec::new() };
    let Some(host) = parsed.host_str() else { return Vec::new() };
    candidates_for_host(host)
}

fn candidates_for_host(host: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: &str = host;
    loop {
        out.push(format!(".{current}"));
        out.push(current.to_string());
        // Strip leftmost subdomain; stop once only two labels remain.
        if current.matches('.').count() <= 1 {
            break;
        }
        if let Some((_, rest)) = current.split_once('.') {
            current = rest;
        } else {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_exact_then_parent_forms() {
        let v = candidates_for_url("https://www.youtube.com/watch?v=xxx");
        assert_eq!(
            v,
            vec![".www.youtube.com", "www.youtube.com", ".youtube.com", "youtube.com"]
        );
    }

    #[test]
    fn two_label_host_stops_after_itself() {
        let v = candidates_for_url("https://bilibili.com/");
        assert_eq!(v, vec![".bilibili.com", "bilibili.com"]);
    }

    #[test]
    fn invalid_url_returns_empty() {
        assert!(candidates_for_url("not a url").is_empty());
    }

    #[test]
    fn deep_subdomain_walks_up() {
        let v = candidates_for_url("https://a.b.c.example.com/");
        // every intermediate level probed
        assert!(v.contains(&"a.b.c.example.com".to_string()));
        assert!(v.contains(&"b.c.example.com".to_string()));
        assert!(v.contains(&"c.example.com".to_string()));
        assert!(v.contains(&"example.com".to_string()));
    }
}
```

Verify Cargo already has the `url` dependency:
Run: `grep '^url' src-tauri/Cargo.toml`
Expected: a line containing `url = "..."`. If missing, add `url = "2"` to `[dependencies]`.

- [ ] **Step 2: Verify the test fails**

Run: `cd src-tauri && cargo test --lib cookies::domain 2>&1 | tail -20`
Expected: compile errors about missing functions (they now exist in your draft, so tests should compile). If they compile, they should pass immediately since the implementation is inline.

- [ ] **Step 3: Confirm tests pass**

Run: `cd src-tauri && cargo test --lib cookies::domain -- --nocapture 2>&1 | tail -20`
Expected: `4 passed`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cookies/domain.rs
git commit -m "feat(cookies): URL→domain filename candidates"
```

---

## Task 3: `CookieStore` Persistence

**Files:**
- Create: `src-tauri/src/cookies/store.rs`
- Test: same file

- [ ] **Step 1: Write the failing tests and implementation together**

Overwrite the stub at `src-tauri/src/cookies/store.rs` with:

```rust
//! On-disk cookie store: one Netscape cookies.txt per domain scope.
//!
//! Layout:
//!   <base_dir>/
//!     .youtube.com.txt
//!     .google.com.txt
//!     accounts.google.com.txt
//!
//! Filenames mirror each cookie's `domain` field verbatim (including any
//! leading dot). Lookup then tries a priority list derived from the target
//! URL's host — see `cookies::domain::candidates_for_url`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::webview::Cookie;

use crate::cookies::{domain, netscape};

pub struct CookieStore {
    base_dir: PathBuf,
}

impl CookieStore {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self { base_dir: base_dir.into() }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Groups cookies by `domain`, serialises each group, writes one file
    /// per domain. Returns the list of written domains for logging.
    pub fn save_from_webview(&self, cookies: Vec<Cookie>) -> std::io::Result<Vec<String>> {
        fs::create_dir_all(&self.base_dir)?;
        let mut groups: HashMap<String, Vec<Cookie>> = HashMap::new();
        for c in cookies {
            let Some(d) = c.domain() else { continue };
            groups.entry(d.to_string()).or_default().push(c);
        }
        let mut written = Vec::with_capacity(groups.len());
        for (d, jar) in groups {
            let path = self.base_dir.join(format!("{d}.txt"));
            let content = netscape::serialise(&jar);
            fs::write(&path, content)?;
            written.push(d);
        }
        Ok(written)
    }

    /// Locates the best-matching cookies file for the given URL. Tries each
    /// candidate filename in priority order; returns the first that exists.
    pub fn resolve_for_url(&self, url: &str) -> Option<PathBuf> {
        for cand in domain::candidates_for_url(url) {
            let path = self.base_dir.join(format!("{cand}.txt"));
            if path.exists() {
                return Some(path);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::Cookie;

    fn cookie(name: &str, value: &str, domain: &str) -> Cookie {
        Cookie::build((name.to_string(), value.to_string()))
            .domain(domain.to_string())
            .path("/".to_string())
            .build()
    }

    fn tmp_store() -> (CookieStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (CookieStore::new(dir.path()), dir)
    }

    #[test]
    fn saves_one_file_per_domain() {
        let (store, _guard) = tmp_store();
        let cookies = vec![
            cookie("a", "1", ".youtube.com"),
            cookie("b", "2", ".youtube.com"),
            cookie("c", "3", ".google.com"),
        ];
        let written = store.save_from_webview(cookies).unwrap();
        assert_eq!(written.len(), 2);
        assert!(store.base_dir().join(".youtube.com.txt").exists());
        assert!(store.base_dir().join(".google.com.txt").exists());
    }

    #[test]
    fn resolve_prefers_exact_host_over_parent() {
        let (store, _guard) = tmp_store();
        store.save_from_webview(vec![
            cookie("a", "1", "www.youtube.com"),
            cookie("b", "2", ".youtube.com"),
        ]).unwrap();
        let hit = store.resolve_for_url("https://www.youtube.com/watch?v=x").unwrap();
        assert!(hit.to_string_lossy().ends_with("www.youtube.com.txt"));
    }

    #[test]
    fn resolve_falls_back_to_parent_domain() {
        let (store, _guard) = tmp_store();
        store.save_from_webview(vec![cookie("b", "2", ".youtube.com")]).unwrap();
        let hit = store.resolve_for_url("https://www.youtube.com/watch?v=x").unwrap();
        assert!(hit.to_string_lossy().ends_with(".youtube.com.txt"));
    }

    #[test]
    fn resolve_returns_none_when_nothing_matches() {
        let (store, _guard) = tmp_store();
        assert!(store.resolve_for_url("https://example.com/").is_none());
    }
}
```

Verify `tempfile` is available as a dev dep:
Run: `grep -E '^\[dev-dependencies\]|^tempfile' src-tauri/Cargo.toml`
Expected: a `[dev-dependencies]` section with `tempfile = "..."`. If missing, add:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib cookies::store -- --nocapture 2>&1 | tail -30`
Expected: `4 passed`.

- [ ] **Step 3: Run the full cookies module**

Run: `cd src-tauri && cargo test --lib cookies 2>&1 | tail -20`
Expected: all cookies tests pass (11 total across three files).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cookies/store.rs src-tauri/Cargo.toml
git commit -m "feat(cookies): per-domain on-disk store with URL resolution"
```

---

## Task 4: yt-dlp `--cookies` Auto-Injection

**Files:**
- Modify: `src-tauri/src/ytdlp/client.rs` (`YtdlpHeaders::resolve_args`, roughly lines 45-90)
- Modify: `src-tauri/src/lib.rs` (manage `CookieStore` as Tauri State)

Reference spec §"yt-dlp 端自动注入": new branch after `cookies_from_browser` and `cookie`, consulting `CookieStore::resolve_for_url`.

- [ ] **Step 1: Add `CookieStore` to managed state**

Edit `src-tauri/src/lib.rs`. Inside `setup_app`, after the aria2 state is managed (search for `aria2::client::Aria2Client::new`), add:

```rust
    // On-disk cookie jar for the in-app browser.
    let cookies_dir = handle.path().app_data_dir()?.join("cookies");
    app.manage(cookies::CookieStore::new(cookies_dir));
```

Because we added `mod cookies;` in Task 1, the use path is `cookies::CookieStore`.

- [ ] **Step 2: Extend `YtdlpHeaders::resolve_args` to consult the store**

In `src-tauri/src/ytdlp/client.rs`, find the block:

```rust
        } else if let Some(cookie) = self.cookie.as_ref().filter(|s| !s.trim().is_empty()) {
            let path = write_cookies_file(app, target_url, cookie).await?;
            args.push("--cookies".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
```

Replace the closing `}` with a new fallback branch:

```rust
        } else if let Some(cookie) = self.cookie.as_ref().filter(|s| !s.trim().is_empty()) {
            let path = write_cookies_file(app, target_url, cookie).await?;
            args.push("--cookies".to_string());
            args.push(path.to_string_lossy().into_owned());
        } else if let Some(store) = app.try_state::<crate::cookies::CookieStore>() {
            if let Some(path) = store.resolve_for_url(target_url) {
                log::info!("ytdlp: auto-attaching cookies from {}", path.display());
                args.push("--cookies".to_string());
                args.push(path.to_string_lossy().into_owned());
            }
        }
```

- [ ] **Step 3: Add a focused unit test**

Append to `src-tauri/src/ytdlp/client.rs`:

```rust
#[cfg(test)]
mod cookies_fallback_tests {
    use super::super::super::cookies::CookieStore;
    use std::fs;

    #[test]
    fn resolve_for_url_hits_written_domain() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".youtube.com.txt"), "# header\n").unwrap();
        let store = CookieStore::new(dir.path());
        let p = store.resolve_for_url("https://www.youtube.com/watch?v=x").unwrap();
        assert!(p.ends_with(".youtube.com.txt"));
    }
}
```

(The logic itself is the store's, already covered. This test guards against the user-visible contract: "I see cookies dir, should get a path.")

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -30`
Expected: all green, including the new cookies_fallback_tests.

- [ ] **Step 5: Verify the crate still compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: `Finished … target(s) in …`. A lone `is_streaming` warning is pre-existing; ignore.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ytdlp/client.rs src-tauri/src/lib.rs
git commit -m "feat(ytdlp): auto-attach cookies from CookieStore when available"
```

---

## Task 5: Enable Tauri `unstable` + Vite Multi-Entry

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `vite.config.ts`
- Create: `web-toolbar.html`
- Create: `web-content.html`

Multi-webview lives behind Tauri's `unstable` feature.

- [ ] **Step 1: Enable `unstable`**

Edit `src-tauri/Cargo.toml`. Change the `tauri` line to include `unstable`:

```toml
tauri = { version = "2", features = ["macos-private-api", "tray-icon", "image-png", "unstable"] }
```

- [ ] **Step 2: Verify still builds**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: rebuild succeeds (may take a moment; rebuilding tauri crate).

- [ ] **Step 3: Add Vite entries**

Create `web-toolbar.html` at repo root:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Motrix ZJ – Browser Toolbar</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/web/toolbar/main.ts"></script>
  </body>
</html>
```

Create `web-content.html` at repo root:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Motrix ZJ – Browser Home</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/web/content/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Declare the extra entries in Vite**

Edit `vite.config.ts`. In the `build.rollupOptions.input` object (add `rollupOptions` if absent), list all three:

```ts
import { resolve } from 'node:path'

export default defineConfig({
  // ... existing config ...
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        webToolbar: resolve(__dirname, 'web-toolbar.html'),
        webContent: resolve(__dirname, 'web-content.html'),
      },
    },
  },
})
```

If the file already has a partial `build` block, merge; do not delete existing options. Read the current `vite.config.ts` first.

- [ ] **Step 5: Verify build still works (TS entries don't exist yet — comment them out temporarily)**

Temporarily comment out `/* import script in web-toolbar.html and web-content.html */` or leave the `main.ts` imports in place and create placeholder files so Vite succeeds. Quickest:

```bash
mkdir -p src/web/toolbar src/web/content
printf "console.log('toolbar stub')\n" > src/web/toolbar/main.ts
printf "console.log('content stub')\n" > src/web/content/main.ts
```

Run: `pnpm vite build 2>&1 | tail -10`
Expected: `✓ built in …`. Three entry chunks in `dist/assets/`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml vite.config.ts web-toolbar.html web-content.html \
        src/web/toolbar/main.ts src/web/content/main.ts
git commit -m "build: enable tauri unstable feature and add web-browser vite entries"
```

---

## Task 6: SiteGrid Component

**Files:**
- Create: `src/web/content/sites.ts`
- Create: `src/web/content/SiteGrid.vue`
- Create: `src/assets/sites/bilibili.svg`, `youku.svg`, `iqiyi.svg`, `tencent.svg`, `mgtv.svg`, `youtube.svg`
- Test: `src/web/content/__tests__/SiteGrid.test.ts`

- [ ] **Step 1: Write the site list**

Create `src/web/content/sites.ts`:

```ts
import bilibili from '@/assets/sites/bilibili.svg'
import youku from '@/assets/sites/youku.svg'
import iqiyi from '@/assets/sites/iqiyi.svg'
import tencent from '@/assets/sites/tencent.svg'
import mgtv from '@/assets/sites/mgtv.svg'
import youtube from '@/assets/sites/youtube.svg'

export interface Site {
  id: string
  name: string
  url: string
  icon: string
}

export const SITES: Site[] = [
  { id: 'bilibili', name: 'Bilibili', url: 'https://www.bilibili.com', icon: bilibili },
  { id: 'youku', name: '优酷', url: 'https://www.youku.com', icon: youku },
  { id: 'iqiyi', name: '爱奇艺', url: 'https://www.iqiyi.com', icon: iqiyi },
  { id: 'tencent', name: '腾讯视频', url: 'https://v.qq.com', icon: tencent },
  { id: 'mgtv', name: '芒果TV', url: 'https://www.mgtv.com', icon: mgtv },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', icon: youtube },
]
```

- [ ] **Step 2: Add placeholder SVG icons (color-coded circles)**

For each of the 6 sites, write a minimal coloured circle as placeholder. Example for `src/assets/sites/bilibili.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="#00A1D6"/>
  <text x="32" y="40" text-anchor="middle" fill="white" font-family="sans-serif" font-size="14" font-weight="700">B</text>
</svg>
```

Color/letter suggestions:
- `bilibili.svg` → #00A1D6 / "B"
- `youku.svg` → #1E9FFF / "优"
- `iqiyi.svg` → #00BE06 / "爱"
- `tencent.svg` → #FF6022 / "腾"
- `mgtv.svg` → #FF5A00 / "芒"
- `youtube.svg` → #FF0000 / "▶"

- [ ] **Step 3: Write the failing component test**

Create `src/web/content/__tests__/SiteGrid.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SiteGrid from '../SiteGrid.vue'

describe('SiteGrid', () => {
  it('renders all six sites', () => {
    const wrapper = mount(SiteGrid)
    expect(wrapper.findAll('.site-card')).toHaveLength(6)
  })

  it('emits navigate with the site URL when a card is clicked', async () => {
    const wrapper = mount(SiteGrid)
    await wrapper.findAll('.site-card')[0].trigger('click')
    expect(wrapper.emitted('navigate')?.[0]).toEqual(['https://www.bilibili.com'])
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run src/web/content/__tests__/SiteGrid.test.ts 2>&1 | tail -20`
Expected: `Cannot find module '../SiteGrid.vue'`.

- [ ] **Step 5: Implement the component**

Create `src/web/content/SiteGrid.vue`:

```vue
<script setup lang="ts">
import { SITES } from './sites'

const emit = defineEmits<{ navigate: [url: string] }>()
</script>

<template>
  <div class="site-grid">
    <button
      v-for="site in SITES"
      :key="site.id"
      class="site-card"
      type="button"
      @click="emit('navigate', site.url)"
    >
      <img :src="site.icon" :alt="site.name" width="56" height="56" />
      <span class="site-name">{{ site.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.site-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
  max-width: 720px;
  margin: 80px auto;
  padding: 0 24px;
}
.site-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 12px;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: white;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.site-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}
.site-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}
</style>
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/web/content/__tests__/SiteGrid.test.ts 2>&1 | tail -20`
Expected: `2 passed`.

- [ ] **Step 7: Commit**

```bash
git add src/web/content/ src/assets/sites/
git commit -m "feat(web): SiteGrid navigation page with six preset sites"
```

---

## Task 7: WebToolbar Component

**Files:**
- Create: `src/web/toolbar/WebToolbar.vue`
- Test: `src/web/toolbar/__tests__/WebToolbar.test.ts`

Behaviour: back / forward / reload / home buttons + URL input (enter-to-navigate) + main-CTA "下载视频" button. Button-enabled states reflect props.

- [ ] **Step 1: Write the failing test**

Create `src/web/toolbar/__tests__/WebToolbar.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WebToolbar from '../WebToolbar.vue'

const base = { currentUrl: 'https://example.com/', canGoBack: true, canGoForward: false }

describe('WebToolbar', () => {
  it('disables "下载视频" until currentUrl is http(s)', () => {
    const w = mount(WebToolbar, { props: { ...base, currentUrl: '' } })
    expect(w.find('.btn-download').attributes('disabled')).toBeDefined()
  })

  it('enables "下载视频" for http(s) URLs', () => {
    const w = mount(WebToolbar, { props: base })
    expect(w.find('.btn-download').attributes('disabled')).toBeUndefined()
  })

  it('emits navigate on ENTER in the URL input', async () => {
    const w = mount(WebToolbar, { props: base })
    const input = w.find<HTMLInputElement>('input[type="text"]')
    await input.setValue('https://new.example.com/x')
    await input.trigger('keydown.enter')
    expect(w.emitted('navigate')?.[0]).toEqual(['https://new.example.com/x'])
  })

  it('emits back/forward/reload/home/download on button clicks', async () => {
    const w = mount(WebToolbar, { props: base })
    await w.find('.btn-back').trigger('click')
    await w.find('.btn-forward').trigger('click') // should emit even if disabled prop wasn't set; disabled handled by DOM
    await w.find('.btn-reload').trigger('click')
    await w.find('.btn-home').trigger('click')
    await w.find('.btn-download').trigger('click')
    expect(w.emitted('back')).toBeTruthy()
    expect(w.emitted('reload')).toBeTruthy()
    expect(w.emitted('home')).toBeTruthy()
    expect(w.emitted('download')?.[0]).toEqual(['https://example.com/'])
  })

  it('reflects canGoForward in forward button disabled state', () => {
    const w = mount(WebToolbar, { props: base })
    expect(w.find('.btn-forward').attributes('disabled')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify fails**

Run: `pnpm vitest run src/web/toolbar/__tests__/WebToolbar.test.ts 2>&1 | tail -10`
Expected: `Cannot find module '../WebToolbar.vue'`.

- [ ] **Step 3: Implement**

Create `src/web/toolbar/WebToolbar.vue`:

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
}>()

const input = ref(props.currentUrl)
watch(() => props.currentUrl, (u) => { input.value = u })

const isDownloadable = () => /^https?:\/\//i.test(props.currentUrl)

function onEnter() {
  const v = input.value.trim()
  if (v) emit('navigate', v)
}
</script>

<template>
  <div class="web-toolbar">
    <button class="btn btn-back" :disabled="!canGoBack" @click="emit('back')" aria-label="后退">←</button>
    <button class="btn btn-forward" :disabled="!canGoForward" @click="emit('forward')" aria-label="前进">→</button>
    <button class="btn btn-reload" @click="emit('reload')" aria-label="刷新">↻</button>
    <button class="btn btn-home" @click="emit('home')" aria-label="首页">🏠</button>
    <input type="text" class="url-input" v-model="input" @keydown.enter="onEnter" placeholder="输入网址或粘贴视频页链接" />
    <button class="btn btn-download" :disabled="!isDownloadable()" @click="emit('download', currentUrl)">
      下载视频
    </button>
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
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-download {
  margin-left: 4px;
  padding: 0 14px;
  background: #15803d;
  color: white;
  border-color: #15803d;
  font-weight: 600;
}
.btn-download:hover:not(:disabled) { background: #166534; }
.url-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  font-size: 13px;
}
.url-input:focus { outline: none; border-color: #15803d; }
</style>
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/web/toolbar/__tests__/WebToolbar.test.ts 2>&1 | tail -10`
Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/web/toolbar/
git commit -m "feat(web): WebToolbar component with navigation + download CTA"
```

---

## Task 8: Content Webview Entry

**Files:**
- Replace (was stub): `src/web/content/main.ts`
- Create: `src/web/content/WebContentApp.vue`

- [ ] **Step 1: Write the root app**

Create `src/web/content/WebContentApp.vue`:

```vue
<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { onMounted, onBeforeUnmount } from 'vue'
import SiteGrid from './SiteGrid.vue'

let stop: (() => void) | null = null

function navigate(url: string) {
  window.location.href = url
}

onMounted(async () => {
  stop = await listen<{ url: string }>('web-browser-navigate', (evt) => {
    navigate(evt.payload.url)
  })
})
onBeforeUnmount(() => { if (stop) stop() })
</script>

<template>
  <SiteGrid @navigate="navigate" />
</template>
```

Replace the stub `src/web/content/main.ts`:

```ts
import { createApp } from 'vue'
import WebContentApp from './WebContentApp.vue'

createApp(WebContentApp).mount('#app')
```

- [ ] **Step 2: Build to verify compile**

Run: `pnpm vite build 2>&1 | tail -10`
Expected: `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add src/web/content/main.ts src/web/content/WebContentApp.vue
git commit -m "feat(web): content webview entry and navigation handler"
```

---

## Task 9: Toolbar Webview Entry

**Files:**
- Replace (was stub): `src/web/toolbar/main.ts`
- Create: `src/web/toolbar/WebToolbarApp.vue`

- [ ] **Step 1: Write the root app**

Create `src/web/toolbar/WebToolbarApp.vue`:

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
    }
  )
})
onBeforeUnmount(() => { if (stop) stop() })

function nav(action: string, url?: string) {
  invoke('web_browser_navigate', { action, url: url ?? null })
}
function download(url: string) {
  invoke('save_cookies_and_trigger_download', { url })
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
  />
</template>
```

Replace `src/web/toolbar/main.ts`:

```ts
import { createApp } from 'vue'
import WebToolbarApp from './WebToolbarApp.vue'

createApp(WebToolbarApp).mount('#app')
```

- [ ] **Step 2: Build to verify compile**

Run: `pnpm vite build 2>&1 | tail -10`
Expected: `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add src/web/toolbar/main.ts src/web/toolbar/WebToolbarApp.vue
git commit -m "feat(web): toolbar webview entry wired to backend commands"
```

---

## Task 10: Rust — `open_web_browser` Command

**Files:**
- Create: `src-tauri/src/commands/web_browser.rs`
- Modify: `src-tauri/src/commands/mod.rs` (register module)
- Modify: `src-tauri/src/lib.rs` (register command in `invoke_handler!`)

Creates the `web-browser` Window with two child Webviews using the `unstable` `add_child` API. **Must be an async command** (Windows deadlock warning).

- [ ] **Step 1: Create the file**

Create `src-tauri/src/commands/web_browser.rs`:

```rust
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
```

- [ ] **Step 2: Register the module**

Edit `src-tauri/src/commands/mod.rs`:

```rust
// add alongside others:
pub mod web_browser;
// and:
pub use web_browser::*;
```

Edit `src-tauri/src/lib.rs` `invoke_handler!` to add:

```rust
            commands::open_web_browser,
```

(Place it next to other "open" commands or after the sidecar version line.)

- [ ] **Step 3: Verify compile**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: compiles clean. If `add_child` errors out as "feature-gated", double-check Task 5's Cargo.toml edit landed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/web_browser.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(web-browser): open_web_browser command with multi-webview layout"
```

---

## Task 11: Rust — Navigation + URL-Change Bridge

**Files:**
- Modify: `src-tauri/src/commands/web_browser.rs`
- Modify: `src-tauri/src/lib.rs` (register command)

Adds the toolbar→content bridge (`web_browser_navigate`) plus a background hook emitting `web-browser-url-changed` whenever the content webview navigates.

- [ ] **Step 1: Add the navigate command and URL-watch hook**

Append to `src-tauri/src/commands/web_browser.rs`:

```rust
use serde::Deserialize;
use tauri::{Emitter, Url};

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
        NavAction::Forward => content.eval("history.forward()").map_err(|e| e.to_string())?,
        NavAction::Reload => content.eval("location.reload()").map_err(|e| e.to_string())?,
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

/// Installs an on_navigation callback on the content webview that re-emits
/// URL changes to the toolbar webview. Call once, right after
/// `open_web_browser` has created the webviews.
pub fn install_url_watch(app: &AppHandle) -> Result<(), String> {
    let content = app
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "content webview not available".to_string())?;
    let app2 = app.clone();
    content.on_navigation(move |url| {
        let payload = serde_json::json!({
            "url": url.as_str(),
            "canGoBack": true,  // simplified: wry history API is limited
            "canGoForward": true,
        });
        let _ = app2.emit_to(TOOLBAR_LABEL, "web-browser-url-changed", payload);
        true
    });
    Ok(())
}
```

At the bottom of `open_web_browser`, right before `Ok(())`, add:

```rust
    install_url_watch(&app)?;
```

- [ ] **Step 2: Register `web_browser_navigate`**

In `src-tauri/src/lib.rs` `invoke_handler!`, next to `open_web_browser`:

```rust
            commands::web_browser_navigate,
```

- [ ] **Step 3: Compile check**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: compiles. If `on_navigation` doesn't exist on `Webview`, replace with `content.on_page_load(...)` and read the url from the `PageLoadPayload`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/web_browser.rs src-tauri/src/lib.rs
git commit -m "feat(web-browser): navigation bridge and URL-change event"
```

---

## Task 12: Rust — `save_cookies_and_trigger_download`

**Files:**
- Modify: `src-tauri/src/commands/web_browser.rs`
- Modify: `src-tauri/src/lib.rs` (register command)

Reads content webview cookies, groups by domain, writes Netscape files via `CookieStore`, emits `add-task-from-web` to the main window.

- [ ] **Step 1: Append the command**

In `src-tauri/src/commands/web_browser.rs` append:

```rust
use crate::cookies::CookieStore;
use tauri::State;

#[tauri::command]
pub async fn save_cookies_and_trigger_download(
    app: AppHandle,
    store: State<'_, CookieStore>,
    url: String,
) -> Result<(), String> {
    let content = app
        .get_webview(CONTENT_LABEL)
        .ok_or_else(|| "content webview not available".to_string())?;
    let cookies = content.cookies().map_err(|e| format!("cookies read failed: {e}"))?;
    let written = store
        .save_from_webview(cookies)
        .map_err(|e| format!("cookies write failed: {e}"))?;
    log::info!("saved cookies for {} domain(s): {:?}", written.len(), written);

    app.emit("add-task-from-web", serde_json::json!({ "url": url }))
        .map_err(|e| format!("emit failed: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: Register**

Add `commands::save_cookies_and_trigger_download,` to `invoke_handler!` in `lib.rs`.

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/web_browser.rs src-tauri/src/lib.rs
git commit -m "feat(web-browser): save_cookies_and_trigger_download command"
```

---

## Task 13: Capabilities for `web-browser` Window

**Files:**
- Create: `src-tauri/capabilities/web-browser.json`

- [ ] **Step 1: Create the file**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "web-browser",
  "description": "Capability for the in-app browser window and its child webviews",
  "windows": ["web-browser"],
  "webviews": ["web-browser-toolbar", "web-browser-content"],
  "permissions": [
    "core:default",
    "core:webview:allow-webview-close",
    "core:event:default",
    "core:event:allow-emit",
    "core:event:allow-listen"
  ]
}
```

- [ ] **Step 2: Smoke-test the capability gets picked up**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: clean. Tauri codegen auto-discovers files under `capabilities/`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/web-browser.json
git commit -m "chore(web-browser): capabilities for in-app browser window"
```

---

## Task 14: AsideBar — Web Icon Button

**Files:**
- Modify: `src/components/layout/AsideBar.vue`

- [ ] **Step 1: Read the AddTask icon button block for style reference**

Open `src/components/layout/AsideBar.vue`. Locate the "new task" `<li>` entry (search for `AddCircleOutline` or the keyboard-shortcut button that opens AddTask). Study its template/style so the Web button visually matches.

- [ ] **Step 2: Add the button**

After the new-task `<li>`, insert:

```vue
<li>
  <MTooltip placement="right">
    <template #trigger>
      <button
        type="button"
        class="menu-btn"
        aria-label="打开浏览器登录"
        @click="openWebBrowser"
      >
        <NIcon :size="20"><GlobeOutline /></NIcon>
      </button>
    </template>
    打开浏览器登录
  </MTooltip>
</li>
```

Add to the `<script setup>` section:

```ts
import { GlobeOutline } from '@vicons/ionicons5'
import { invoke } from '@tauri-apps/api/core'

async function openWebBrowser() {
  try {
    await invoke('open_web_browser')
  } catch (e) {
    logger.warn('AsideBar', `open_web_browser failed: ${e}`)
  }
}
```

Adjust `NIcon`, `MTooltip`, and `logger` imports to match the file's existing imports (only add what's missing).

- [ ] **Step 3: Type-check**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/AsideBar.vue
git commit -m "feat(aside): add web-browser entry button below new-task"
```

---

## Task 15: MainLayout — Listen for `add-task-from-web`

**Files:**
- Modify: `src/layouts/MainLayout.vue`

- [ ] **Step 1: Add the listener**

In `src/layouts/MainLayout.vue`, inside the existing `onMounted` or a nearby `setup` block where other `listen()` hooks live, add:

```ts
import { getCurrentWindow } from '@tauri-apps/api/window'

const unlistenAddFromWeb = await listen<{ url: string }>('add-task-from-web', async ({ payload }) => {
  const win = getCurrentWindow()
  try {
    await win.show()
    await win.setFocus()
  } catch (e) {
    logger.debug('MainLayout.show', e)
  }
  addTaskDialogRef.value?.open({ url: payload.url })
})
registerCleanup(unlistenAddFromWeb)
```

Adapt to the file's existing patterns — if it uses `useAppEvents`-style registration, wire it there instead, and make sure the cleanup path matches.

- [ ] **Step 2: Type-check**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -10`
Expected: no errors. If `addTaskDialogRef.value?.open({ url })` errors because `open` doesn't accept an object, proceed to Task 16 which adds that overload.

- [ ] **Step 3: Commit**

```bash
git add src/layouts/MainLayout.vue
git commit -m "feat(main): listen add-task-from-web and reopen AddTask with URL"
```

---

## Task 16: AddTask — Accept Pre-Filled URL + Cookie-Expired Banner

**Files:**
- Modify: `src/components/task/AddTask.vue`

- [ ] **Step 1: Read the file to find `defineExpose` / `open()`**

Search in `AddTask.vue` for `defineExpose` to see the public `open()` signature. Add an optional `{ url?: string }` argument if missing.

- [ ] **Step 2: Accept a URL in `open`**

Replace the exposed `open()` with:

```ts
function open(opts?: { url?: string }) {
  showDialog.value = true
  if (opts?.url) {
    form.value.url = opts.url
  }
}
defineExpose({ open })
```

(Match existing field name; the `url` textarea model may be called `form.url` or `form.urls`. Check and adapt.)

- [ ] **Step 3: Add the cookie-expired banner**

Find the error-message region in the template (where parse errors are shown). Add near it:

```vue
<div v-if="cookieExpired" class="cookie-expired-banner">
  <span>登录可能已过期，请重新打开浏览器登录：</span>
  <button class="link-btn" type="button" @click="openWebBrowser">打开浏览器</button>
</div>
```

```ts
import { invoke } from '@tauri-apps/api/core'

const cookieExpired = ref(false)
async function openWebBrowser() {
  try { await invoke('open_web_browser') } catch {}
}
```

In the catch block of the parse / download invocation, set `cookieExpired.value = true` whenever the error message contains any of: `cookies`, `login`, `unable to extract`, `authentication required` (case-insensitive).

```ts
const msg = String(err ?? '').toLowerCase()
if (/cookies|login|authentication required|unable to extract/.test(msg)) {
  cookieExpired.value = true
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/task/AddTask.vue
git commit -m "feat(add-task): pre-fill URL from web, cookie-expired banner"
```

---

## Task 17: End-to-End Manual Smoke Test

No files to write — acceptance criteria. If any step fails, create a follow-up task with an exact reproducer.

- [ ] **Step 1: Fresh build**

```bash
pnpm vite build
pnpm fetch-sidecars
```

Expected: both green. Sidecars present in `src-tauri/binaries/` for the host triple.

- [ ] **Step 2: Launch dev app**

```bash
pnpm tauri dev
```

Wait for main window to appear.

- [ ] **Step 3: Open the browser window**

Click the new globe icon in the AsideBar (below the "+" new-task button). The Motrix ZJ – 内置浏览器 window should open with a grid of six site cards.

- [ ] **Step 4: Test navigation**

Click YouTube card. Wait for page load. Click **back** — should return to SiteGrid. Click **forward** — should go back to YouTube. Type `https://www.google.com` into the URL bar + Enter — should navigate to Google.

- [ ] **Step 5: Login + download flow**

Click Bilibili card. Log in with a real account. Navigate to any video page (e.g. `bilibili.com/video/BV...`). Click **下载视频**:
- Main window should raise/focus automatically.
- AddTask dialog should open with the video URL pre-filled.
- Submit the task — it should download successfully, proving cookies landed on disk and yt-dlp consumed them.

Verify disk:

```bash
ls -la "$(find ~/Library/Application\ Support -name 'motrix.next' -type d 2>/dev/null | head -1)/cookies/"
```

Expected: at least one `.bilibili.com.txt` (and likely `.hdslb.com.txt`).

- [ ] **Step 6: Cookie-expired banner**

Force-delete the cookies dir:

```bash
rm -rf "$(find ~/Library/Application\ Support -name 'motrix.next' -type d 2>/dev/null | head -1)/cookies/"
```

Try adding a Bilibili task that requires login. On parse error, AddTask should show the **登录可能已过期** banner with a working "打开浏览器" button.

- [ ] **Step 7: Final commit**

```bash
git commit --allow-empty -m "chore(web-browser): MVP manual smoke test passed"
```

---

## Risks & Open Questions

1. **`unstable` feature churn** — `window.add_child` signature may shift between tauri 2.x releases. If compile breaks at Task 10, consult `docs.rs/tauri/<current-version>/tauri/window/struct.Window.html` for the live signature.
2. **`Webview::cookies()` platform parity** — works on macOS/Windows/Linux per Tauri 2.8+. Verify locally before depending on it in CI. Linux (WebKitGTK) historically had the loosest coverage.
3. **`on_navigation` signature** — Tauri's exact callback shape may differ (`Url` vs `&str`). Fall back to `on_page_load` if needed; the event payload should still expose the URL.
4. **`canGoBack` / `canGoForward` accuracy** — wry's history API is thin; the plan emits naive `true` values. If this causes UX issues, wire a JS-side history-length pref from content webview to toolbar via an extra custom event.
5. **Windows ABE parity** — once the core flow works on macOS, test on Windows to confirm we actually solve the original cookie problem for Chrome-shaped sites.

---

## Self-Review Notes

Spec coverage check:
- Six-site grid → Tasks 6 + 8 ✓
- Multi-webview → Tasks 10 + 13 ✓
- Cookie store + Netscape serialisation → Tasks 1, 2, 3 ✓
- Automatic `--cookies` attach → Task 4 ✓
- Toolbar↔content URL bridge → Tasks 7, 9, 11 ✓
- "下载视频" → AddTask flow → Tasks 12, 15, 16 ✓
- AsideBar entry → Task 14 ✓
- Capabilities → Task 13 ✓
- Cookie-expired banner → Task 16 ✓
- Manual verification → Task 17 ✓

No placeholder steps; every code block contains real content.
