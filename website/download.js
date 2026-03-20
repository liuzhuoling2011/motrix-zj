/**
 * @fileoverview Download resolution logic for the Motrix Next website.
 *
 * Provides pure functions for:
 * - Building CDN URLs for website channel JSON files
 * - Resolving platform-specific download URLs from release asset data
 * - Determining the correct channel JSON filename
 *
 * This module has zero DOM dependencies and is fully testable in Node/Vitest.
 */

/** Base URL for static assets hosted on the permanent `updater` GitHub Release tag. */
export const UPDATER_BASE_URL =
  'https://github.com/AnInsomniacy/motrix-next/releases/download/updater'

/**
 * Platform definitions used to match GitHub Release asset filenames
 * to platform-specific download keys.
 *
 * Each entry has:
 * - `key`   — stable identifier used to look up resolved URLs
 * - `os`    — display name for the operating system
 * - `arch`  — display name for the architecture
 * - `fmt`   — file extension label
 * - `match` — predicate that tests whether a GitHub Release asset filename belongs to this platform
 */
export const PLATFORMS = [
  {
    key: 'dmg-arm',
    os: 'macOS',
    arch: 'Apple Silicon',
    fmt: '.dmg',
    match: (n) => n.includes('aarch64') && n.endsWith('.dmg'),
  },
  {
    key: 'dmg-x64',
    os: 'macOS',
    arch: 'Intel',
    fmt: '.dmg',
    match: (n) => n.includes('x64') && n.endsWith('.dmg'),
  },
  {
    key: 'exe-x64',
    os: 'Windows',
    arch: 'x64',
    fmt: '.exe',
    match: (n) => n.includes('x64') && n.endsWith('-setup.exe'),
  },
  {
    key: 'exe-arm',
    os: 'Windows',
    arch: 'ARM64',
    fmt: '.exe',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('-setup.exe'),
  },
  {
    key: 'appimage-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.AppImage',
    match: (n) => n.includes('amd64') && n.endsWith('.AppImage'),
  },
  {
    key: 'deb-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.deb',
    match: (n) => n.includes('amd64') && n.endsWith('.deb'),
  },
  {
    key: 'appimage-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.AppImage',
    match: (n) => n.includes('aarch64') && n.endsWith('.AppImage'),
  },
  {
    key: 'deb-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.deb',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('.deb'),
  },
  {
    key: 'rpm-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.rpm',
    match: (n) => n.includes('x86_64') && n.endsWith('.rpm'),
  },
  {
    key: 'rpm-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.rpm',
    match: (n) => n.includes('aarch64') && n.endsWith('.rpm'),
  },
]

// --- Functions ---

/**
 * Returns the CDN URL for the channel-specific website JSON file.
 *
 * @param {string} channel — `'stable'` or `'beta'`; anything else falls back to stable.
 * @returns {string} Full URL to the JSON asset on the `updater` Release tag.
 */
export function channelJsonUrl(channel) {
  const file = channel === 'beta' ? 'website-beta.json' : 'website-stable.json'
  return `${UPDATER_BASE_URL}/${file}`
}

/**
 * Resolves platform-specific download URLs from a list of release assets.
 *
 * Iterates all PLATFORMS and finds the first matching asset for each,
 * building a `{ [platformKey]: downloadUrl }` map.
 *
 * @param {Array<{name: string, url: string}>} assets — release asset objects
 * @returns {Record<string, string>} Map of platform keys to download URLs.
 */
export function resolveDownloadUrls(assets) {
  const urls = {}
  for (const p of PLATFORMS) {
    const asset = assets.find((a) => p.match(a.name))
    if (asset) urls[p.key] = asset.url
  }
  return urls
}
