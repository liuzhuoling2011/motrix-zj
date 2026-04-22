//! On-disk cookie store: one Netscape cookies.txt per domain scope.
//!
//! Layout:
//!   <base_dir>/
//!     youtube.com.txt      (cookie API strips leading dot; file key = domain())
//!     google.com.txt
//!     accounts.google.com.txt
//!
//! Filenames mirror the value returned by `Cookie::domain()` — which always
//! strips the leading dot per cookie crate 0.18 design. Lookup tries the
//! priority list from `cookies::domain::candidates_for_url`, which also
//! includes the no-dot forms so they match correctly.

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

    /// Groups cookies by `domain()`, serialises each group, writes one file
    /// per domain. Returns the list of written domain keys for logging.
    ///
    /// Note: `cookie::Cookie::domain()` (v0.18) always strips any leading dot,
    /// so file names will never have a leading dot. The `netscape::serialise`
    /// call receives the same stripped key as the domain argument.
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
            let content = netscape::serialise(&d, &jar);
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

    /// Build a test cookie.  `cookie::Cookie::domain()` (v0.18) strips any
    /// leading dot, so the grouping key stored in the file name is always
    /// the dot-free form regardless of what we pass to `.domain()`.
    fn cookie(name: &str, value: &str, domain: &str) -> Cookie<'static> {
        Cookie::build((name.to_string(), value.to_string()))
            .domain(domain.to_string())
            .path("/".to_string())
            .build()
    }

    fn tmp_store() -> (CookieStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        (CookieStore::new(dir.path()), dir)
    }

    #[test]
    fn saves_one_file_per_domain() {
        let (store, _guard) = tmp_store();
        // cookie 0.18: domain() strips leading dot, so ".youtube.com" → "youtube.com"
        let cookies = vec![
            cookie("a", "1", ".youtube.com"),
            cookie("b", "2", ".youtube.com"),
            cookie("c", "3", ".google.com"),
        ];
        let written = store.save_from_webview(cookies).expect("save");
        assert_eq!(written.len(), 2);
        // Files are keyed by domain() output (no leading dot)
        assert!(store.base_dir().join("youtube.com.txt").exists());
        assert!(store.base_dir().join("google.com.txt").exists());
    }

    #[test]
    fn resolve_prefers_exact_host_over_parent() {
        let (store, _guard) = tmp_store();
        // "www.youtube.com" → domain() → "www.youtube.com" → www.youtube.com.txt
        // ".youtube.com"    → domain() → "youtube.com"     → youtube.com.txt
        store
            .save_from_webview(vec![
                cookie("a", "1", "www.youtube.com"),
                cookie("b", "2", ".youtube.com"),
            ])
            .expect("save");
        // candidates_for_url produces: ".www.youtube.com", "www.youtube.com", ".youtube.com", "youtube.com"
        // First existing file wins; "www.youtube.com.txt" exists → hits before "youtube.com.txt"
        let hit = store
            .resolve_for_url("https://www.youtube.com/watch?v=x")
            .expect("hit");
        assert!(hit.to_string_lossy().ends_with("www.youtube.com.txt"));
    }

    #[test]
    fn resolve_falls_back_to_parent_domain() {
        let (store, _guard) = tmp_store();
        // ".youtube.com" → domain() → "youtube.com" → youtube.com.txt
        store
            .save_from_webview(vec![cookie("b", "2", ".youtube.com")])
            .expect("save");
        // candidates: ".www.youtube.com", "www.youtube.com", ".youtube.com", "youtube.com"
        // only "youtube.com.txt" exists → falls back to it
        let hit = store
            .resolve_for_url("https://www.youtube.com/watch?v=x")
            .expect("hit");
        assert!(hit.to_string_lossy().ends_with("youtube.com.txt"));
    }

    #[test]
    fn resolve_returns_none_when_nothing_matches() {
        let (store, _guard) = tmp_store();
        assert!(store.resolve_for_url("https://example.com/").is_none());
    }
}
