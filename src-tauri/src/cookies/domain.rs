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
        assert!(v.contains(&"a.b.c.example.com".to_string()));
        assert!(v.contains(&"b.c.example.com".to_string()));
        assert!(v.contains(&"c.example.com".to_string()));
        assert!(v.contains(&"example.com".to_string()));
    }
}
