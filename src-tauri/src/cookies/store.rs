//! On-disk cookie store: one Netscape cookies.txt per registrable domain.
//!
//! Layout:
//!   <base_dir>/
//!     .bilibili.com.txt     (all *.bilibili.com cookies merged)
//!     .youtube.com.txt
//!     .google.com.txt
//!
//! All cookies under the same registrable domain (e.g. `bilibili.com`,
//! `www.bilibili.com`, `api.bilibili.com`) are **merged into a single
//! file** keyed by the registrable domain. Each record's `include_subdomains`
//! column is `TRUE` so yt-dlp forwards the cookies to any subdomain it
//! queries — this is the whole point: otherwise yt-dlp hits `api.bilibili.com`
//! with no auth because the login cookies live on `.bilibili.com`.
//!
//! Pre-existing per-subdomain leftover files (e.g. `www.bilibili.com.txt`)
//! within the same registrable domain are deleted on save to prevent stale
//! shadowing of the merged file.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::webview::Cookie;

use crate::cookies::{domain, netscape};

pub struct CookieStore {
    base_dir: PathBuf,
}

impl CookieStore {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Groups cookies by registrable domain (last two labels), serialises
    /// each group with a leading-dot domain column (include_subdomains=TRUE),
    /// writes one file `.<reg>.txt` per group, and evicts stale leftovers
    /// within the same registrable domain.
    ///
    /// Returns the list of written `.<reg>` keys.
    pub fn save_from_webview(&self, cookies: Vec<Cookie>) -> std::io::Result<Vec<String>> {
        fs::create_dir_all(&self.base_dir)?;

        let mut groups: HashMap<String, Vec<Cookie>> = HashMap::new();
        for c in cookies {
            let Some(d) = c.domain() else { continue };
            let Some(reg) = domain::registrable_domain(d) else {
                continue;
            };
            groups.entry(reg).or_default().push(c);
        }

        // Evict legacy / subdomain files that fall under any registrable
        // domain we're about to rewrite. Keeps the merged `.reg.txt` the
        // sole match for resolve_for_url.
        let affected: HashSet<&str> = groups.keys().map(String::as_str).collect();
        if let Ok(entries) = fs::read_dir(&self.base_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("txt") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let file_reg = domain::registrable_domain(stem).unwrap_or_default();
                if affected.contains(file_reg.as_str()) {
                    let _ = fs::remove_file(&path);
                }
            }
        }

        let mut written = Vec::with_capacity(groups.len());
        for (reg, jar) in groups {
            let scoped = format!(".{reg}");
            let final_path = self.base_dir.join(format!("{scoped}.txt"));
            let tmp_path = self.base_dir.join(format!("{scoped}.txt.tmp"));
            let content = netscape::serialise(&scoped, &jar);
            fs::write(&tmp_path, content)?;
            fs::rename(&tmp_path, &final_path)?;
            written.push(scoped);
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

    /// Build a test cookie. `cookie::Cookie::domain()` strips a leading dot,
    /// so tests pass the dot-free form directly for clarity.
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
    fn merges_subdomains_into_registrable_file() {
        let (store, _guard) = tmp_store();
        let cookies = vec![
            cookie("SESSDATA", "login", "bilibili.com"),
            cookie("X-TOKEN", "x", "www.bilibili.com"),
            cookie("API-JAR", "j", "api.bilibili.com"),
        ];
        let written = store.save_from_webview(cookies).expect("save");
        assert_eq!(written, vec![".bilibili.com"]);
        let path = store.base_dir().join(".bilibili.com.txt");
        assert!(path.exists());
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("SESSDATA\tlogin"));
        assert!(content.contains("X-TOKEN\tx"));
        assert!(content.contains("API-JAR\tj"));
        // Every row should be domain-wide (TRUE include_subdomains)
        for line in content
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
        {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(cols.len(), 7);
            assert_eq!(cols[0], ".bilibili.com");
            assert_eq!(cols[1], "TRUE");
        }
    }

    #[test]
    fn separate_registrable_domains_get_separate_files() {
        let (store, _guard) = tmp_store();
        let cookies = vec![
            cookie("a", "1", "youtube.com"),
            cookie("b", "2", "google.com"),
        ];
        let written = store.save_from_webview(cookies).expect("save");
        assert_eq!(written.len(), 2);
        assert!(store.base_dir().join(".youtube.com.txt").exists());
        assert!(store.base_dir().join(".google.com.txt").exists());
    }

    #[test]
    fn resolve_finds_registrable_file_for_subdomain_url() {
        let (store, _guard) = tmp_store();
        store
            .save_from_webview(vec![cookie("x", "1", "bilibili.com")])
            .expect("save");
        let hit = store
            .resolve_for_url("https://api.bilibili.com/x/space/acc/info")
            .expect("hit");
        assert!(hit.to_string_lossy().ends_with(".bilibili.com.txt"));
    }

    #[test]
    fn resolve_returns_none_when_nothing_matches() {
        let (store, _guard) = tmp_store();
        assert!(store.resolve_for_url("https://example.com/").is_none());
    }

    #[test]
    fn save_evicts_legacy_subdomain_files() {
        let (store, _guard) = tmp_store();
        // Seed legacy dotless + per-subdomain files
        fs::create_dir_all(store.base_dir()).unwrap();
        fs::write(store.base_dir().join("bilibili.com.txt"), "# old\n").unwrap();
        fs::write(store.base_dir().join("www.bilibili.com.txt"), "# old\n").unwrap();
        // Fresh save for bilibili.com
        store
            .save_from_webview(vec![cookie("SESSDATA", "new", "bilibili.com")])
            .expect("save");
        assert!(!store.base_dir().join("bilibili.com.txt").exists());
        assert!(!store.base_dir().join("www.bilibili.com.txt").exists());
        assert!(store.base_dir().join(".bilibili.com.txt").exists());
    }

    #[test]
    fn saved_file_starts_with_netscape_header() {
        let (store, _guard) = tmp_store();
        store
            .save_from_webview(vec![cookie("a", "1", "youtube.com")])
            .expect("save");
        let content = fs::read_to_string(store.base_dir().join(".youtube.com.txt")).expect("read");
        assert!(content.starts_with("# Netscape HTTP Cookie File"));
    }
}
