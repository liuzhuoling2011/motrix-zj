//! Encoding-tolerant decoder for yt-dlp sidecar output on Windows.
//!
//! `motrixnext-ytdlp.exe` is a PyInstaller bundle. Even with
//! `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, certain output paths
//! (e.g. `[download] Destination: <Chinese filename>` lines, ffmpeg
//! sub-process logs, etc.) still emit bytes encoded with the system
//! ANSI code page (CP936/GBK on Chinese-locale Windows). When we feed
//! those bytes through `String::from_utf8_lossy` they show up in the
//! task-detail Logs tab as `���` replacement characters.
//!
//! This helper attempts UTF-8 first (the common, fully-correct case)
//! and only falls back to a GBK decode when UTF-8 produced replacement
//! characters AND GBK decodes cleanly. If both fail it returns the
//! lossy UTF-8 result so the line is at least visible.

use encoding_rs::GBK;

/// Decodes a single line of yt-dlp / ffmpeg subprocess stdout/stderr.
///
/// Strategy:
/// 1. If `bytes` is valid UTF-8, return that (zero-allocation).
/// 2. Try GBK; if it decodes without errors, prefer it (covers the
///    Chinese Windows mojibake case).
/// 3. Fall back to lossy UTF-8 so the user sees something rather than
///    nothing.
pub fn decode_subprocess_line(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    let (decoded, _, had_errors) = GBK.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }

    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passes_through() {
        assert_eq!(decode_subprocess_line(b"hello world"), "hello world");
    }

    #[test]
    fn utf8_chinese_passes_through() {
        let s = "[download] Destination: 探秘.mp4";
        assert_eq!(decode_subprocess_line(s.as_bytes()), s);
    }

    #[test]
    fn gbk_chinese_is_recovered() {
        // "下载" encoded in GBK is 0xCF 0xC2 0xD4 0xD8 — invalid as UTF-8.
        let bytes = [0xCF, 0xC2, 0xD4, 0xD8];
        assert_eq!(decode_subprocess_line(&bytes), "下载");
    }

    #[test]
    fn realistic_destination_line_in_gbk() {
        // "[download] Destination: 探秘.mp4" with the Chinese substring
        // re-encoded as GBK.
        let prefix = b"[download] Destination: ";
        let title_gbk = [
            0xCC, 0xBD, // 探
            0xC3, 0xD8, // 秘
            b'.', b'm', b'p', b'4',
        ];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(prefix);
        bytes.extend_from_slice(&title_gbk);

        assert_eq!(
            decode_subprocess_line(&bytes),
            "[download] Destination: 探秘.mp4"
        );
    }

    #[test]
    fn invalid_in_both_encodings_falls_back_lossy() {
        // 0xFE 0xFE is invalid in both UTF-8 and GBK; we just want the
        // function to return *something* rather than panic.
        let bytes = [b'a', 0xFE, 0xFE, b'b'];
        let out = decode_subprocess_line(&bytes);
        assert!(out.starts_with('a'));
        assert!(out.ends_with('b'));
    }
}
