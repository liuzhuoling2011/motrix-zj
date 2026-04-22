//! Cookie persistence for the in-app browser login flow.
//!
//! `netscape`  — serialises cookies as yt-dlp-compatible cookies.txt files.
//! `domain`    — URL→domain matching rules for on-disk lookup.
//! `store`     — `CookieStore` writes/reads per-domain files under app data.

pub mod domain;
pub mod netscape;
pub mod store;

pub use store::CookieStore;
