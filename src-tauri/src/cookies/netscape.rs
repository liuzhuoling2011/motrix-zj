//! Netscape cookies.txt serialiser (https://curl.se/docs/http-cookies.html).

use std::borrow::Cow;

use tauri::webview::Cookie;

fn sanitize(s: &str) -> Cow<'_, str> {
    if s.contains(['\t', '\n', '\r']) {
        Cow::Owned(
            s.replace('\t', "%09")
                .replace('\n', "%0A")
                .replace('\r', "%0D"),
        )
    } else {
        Cow::Borrowed(s)
    }
}

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
    let mut out = String::from("# Netscape HTTP Cookie File\n# Written by motrix-next\n\n");
    let include_sub = if domain.starts_with('.') { "TRUE" } else { "FALSE" };
    for c in cookies {
        #[cfg(debug_assertions)]
        {
            if let Some(d) = c.domain() {
                debug_assert!(
                    d == domain || d == domain.trim_start_matches('.'),
                    "cookie domain {d:?} doesn't match group key {domain:?}"
                );
            }
        }
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
            sanitize(c.name()),
            sanitize(c.value()),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use cookie::time::OffsetDateTime;
    use tauri::webview::Cookie;

    fn make_cookie(name: &str, value: &str, path: &str, secure: bool, expires: i64) -> Cookie<'static> {
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
        let c = make_cookie("SID", "abc", "/", true, 1_800_000_000);
        let out = serialise(".youtube.com", &[c]);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc"));
    }

    #[test]
    fn session_cookie_expires_zero() {
        let c = make_cookie("tmp", "v", "/", false, 0);
        let out = serialise("example.com", &[c]);
        assert!(out.contains("example.com\tFALSE\t/\tFALSE\t0\ttmp\tv"));
    }

    #[test]
    fn emits_header_comment() {
        let out = serialise("example.com", &[]);
        assert!(out.starts_with("# Netscape HTTP Cookie File"));
    }

    #[test]
    fn escapes_tabs_and_newlines_in_value() {
        let c = make_cookie("weird", "line1\tline2\npart", "/", false, 0);
        let out = serialise("example.com", &[c]);
        // Must not contain literal tab or newline inside the value column.
        assert!(out.contains("weird\tline1%09line2%0Apart"));
        // The whole record is still one line (single `\n` at the record end).
        let record_lines = out.lines().filter(|l| l.contains("\tweird\t")).count();
        assert_eq!(record_lines, 1);
    }
}
