//! Netscape cookies.txt serialiser (https://curl.se/docs/http-cookies.html).

use tauri::webview::Cookie;

/// Serialises `cookies` into Netscape cookies.txt format.
///
/// `domain` controls the first column of every emitted record and the
/// derived `include_subdomains` flag (column 2).  Pass the domain with a
/// leading dot (e.g. `.youtube.com`) to signal that the cookies should be
/// sent to all sub-domains; pass without dot (e.g. `example.com`) to restrict
/// to the exact host.
///
/// Session cookies (no expiration set) get expiration `0`.
pub fn serialise(domain: &str, cookies: &[Cookie]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n# Written by Motrix ZJ\n\n");
    let include_sub = if domain.starts_with('.') { "TRUE" } else { "FALSE" };
    for c in cookies {
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
    use cookie::time::OffsetDateTime;
    use tauri::webview::Cookie;

    fn build(name: &str, value: &str, path: &str, secure: bool, expires: i64) -> Cookie<'static> {
        let mut b = Cookie::build((name.to_string(), value.to_string()))
            .path(path.to_string())
            .secure(secure);
        if expires > 0 {
            b = b.expires(OffsetDateTime::from_unix_timestamp(expires).expect("valid timestamp"));
        }
        b.build()
    }

    #[test]
    fn serialises_single_cookie_with_leading_dot_domain() {
        let c = build("SID", "abc", "/", true, 1_800_000_000);
        let out = serialise(".youtube.com", &[c]);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc"));
    }

    #[test]
    fn session_cookie_expires_zero() {
        let c = build("tmp", "v", "/", false, 0);
        let out = serialise("example.com", &[c]);
        assert!(out.contains("example.com\tFALSE\t/\tFALSE\t0\ttmp\tv"));
    }

    #[test]
    fn emits_header_comment() {
        let out = serialise("example.com", &[]);
        assert!(out.starts_with("# Netscape HTTP Cookie File"));
    }
}
