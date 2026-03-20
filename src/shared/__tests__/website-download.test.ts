/**
 * @fileoverview Tests for website download resolution logic.
 *
 * Written BEFORE implementation (TDD RED phase).
 * Tests cover:
 * - Channel JSON URL construction
 * - Download URL resolution from asset data
 * - Platform matching against real filenames
 * - Edge cases: missing assets, empty data, unknown formats
 */
import { describe, expect, it } from 'vitest'

import { channelJsonUrl, PLATFORMS, resolveDownloadUrls, UPDATER_BASE_URL } from '@website/download.js'

// ─── channelJsonUrl ──────────────────────────────────────────────────────────

describe('channelJsonUrl', () => {
  it('returns website-stable.json URL for the stable channel', () => {
    const url = channelJsonUrl('stable')
    expect(url).toBe(`${UPDATER_BASE_URL}/website-stable.json`)
  })

  it('returns website-beta.json URL for the beta channel', () => {
    const url = channelJsonUrl('beta')
    expect(url).toBe(`${UPDATER_BASE_URL}/website-beta.json`)
  })

  it('defaults to stable for unknown channel names', () => {
    const url = channelJsonUrl('nightly')
    expect(url).toBe(`${UPDATER_BASE_URL}/website-stable.json`)
  })

  it('defaults to stable for empty string', () => {
    const url = channelJsonUrl('')
    expect(url).toBe(`${UPDATER_BASE_URL}/website-stable.json`)
  })
})

// ─── resolveDownloadUrls ─────────────────────────────────────────────────────

/** Realistic asset data matching a v3.4.6 release. */
const MOCK_ASSETS = [
  {
    name: 'MotrixNext_aarch64.dmg',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_aarch64.dmg',
  },
  {
    name: 'MotrixNext_x64.dmg',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_x64.dmg',
  },
  {
    name: 'MotrixNext_3.4.6_x64-setup.exe',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_x64-setup.exe',
  },
  {
    name: 'MotrixNext_3.4.6_arm64-setup.exe',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_arm64-setup.exe',
  },
  {
    name: 'MotrixNext_3.4.6_amd64.AppImage',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_amd64.AppImage',
  },
  {
    name: 'MotrixNext_3.4.6_aarch64.AppImage',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_aarch64.AppImage',
  },
  {
    name: 'MotrixNext_3.4.6_amd64.deb',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_amd64.deb',
  },
  {
    name: 'MotrixNext_3.4.6_arm64.deb',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_arm64.deb',
  },
  {
    name: 'MotrixNext_3.4.6_x86_64.rpm',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_x86_64.rpm',
  },
  {
    name: 'MotrixNext_3.4.6_aarch64.rpm',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_aarch64.rpm',
  },
  // Non-installer assets that should be ignored
  {
    name: 'MotrixNext_aarch64.app.tar.gz',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_aarch64.app.tar.gz',
  },
  {
    name: 'MotrixNext_aarch64.app.tar.gz.sig',
    url: 'https://github.com/example/releases/download/v3.4.6/MotrixNext_aarch64.app.tar.gz.sig',
  },
]

describe('resolveDownloadUrls', () => {
  it('resolves all 10 platform download URLs from a full asset list', () => {
    const urls = resolveDownloadUrls(MOCK_ASSETS)

    expect(urls['dmg-arm']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_aarch64.dmg')
    expect(urls['dmg-x64']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_x64.dmg')
    expect(urls['exe-x64']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_x64-setup.exe')
    expect(urls['exe-arm']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_arm64-setup.exe')
    expect(urls['appimage-x64']).toBe(
      'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_amd64.AppImage',
    )
    expect(urls['appimage-arm']).toBe(
      'https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_aarch64.AppImage',
    )
    expect(urls['deb-x64']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_amd64.deb')
    expect(urls['deb-arm']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_arm64.deb')
    expect(urls['rpm-x64']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_x86_64.rpm')
    expect(urls['rpm-arm']).toBe('https://github.com/example/releases/download/v3.4.6/MotrixNext_3.4.6_aarch64.rpm')
  })

  it('returns an empty object when the asset list is empty', () => {
    const urls = resolveDownloadUrls([])
    expect(urls).toEqual({})
  })

  it('ignores non-installer assets like .tar.gz and .sig files', () => {
    const sigOnly = [
      {
        name: 'MotrixNext_aarch64.app.tar.gz',
        url: 'https://example.com/tar.gz',
      },
      {
        name: 'MotrixNext_aarch64.app.tar.gz.sig',
        url: 'https://example.com/sig',
      },
    ]
    const urls = resolveDownloadUrls(sigOnly)
    expect(Object.keys(urls)).toHaveLength(0)
  })

  it('handles partial asset lists gracefully', () => {
    const macOnly = [
      {
        name: 'MotrixNext_aarch64.dmg',
        url: 'https://example.com/aarch64.dmg',
      },
    ]
    const urls = resolveDownloadUrls(macOnly)
    expect(urls['dmg-arm']).toBe('https://example.com/aarch64.dmg')
    expect(urls['dmg-x64']).toBeUndefined()
    expect(urls['exe-x64']).toBeUndefined()
  })

  it('picks the first matching asset when duplicates exist', () => {
    const duplicates = [
      { name: 'MotrixNext_aarch64.dmg', url: 'https://example.com/first.dmg' },
      {
        name: 'MotrixNext_aarch64.dmg',
        url: 'https://example.com/second.dmg',
      },
    ]
    const urls = resolveDownloadUrls(duplicates)
    expect(urls['dmg-arm']).toBe('https://example.com/first.dmg')
  })
})

// ─── PLATFORMS matchers ──────────────────────────────────────────────────────

describe('PLATFORMS matchers', () => {
  it('has exactly 10 platform entries', () => {
    expect(PLATFORMS).toHaveLength(10)
  })

  it('each platform has required properties', () => {
    for (const p of PLATFORMS) {
      expect(p).toHaveProperty('key')
      expect(p).toHaveProperty('os')
      expect(p).toHaveProperty('arch')
      expect(p).toHaveProperty('fmt')
      expect(p).toHaveProperty('match')
      expect(typeof p.match).toBe('function')
    }
  })

  it('all platform keys are unique', () => {
    const keys = PLATFORMS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // Individual matcher correctness
  const matchCases = [
    ['dmg-arm', 'MotrixNext_aarch64.dmg', true],
    ['dmg-arm', 'MotrixNext_x64.dmg', false],
    ['dmg-x64', 'MotrixNext_x64.dmg', true],
    ['dmg-x64', 'MotrixNext_aarch64.dmg', false],
    ['exe-x64', 'MotrixNext_3.4.6_x64-setup.exe', true],
    ['exe-x64', 'MotrixNext_3.4.6_arm64-setup.exe', false],
    ['exe-arm', 'MotrixNext_3.4.6_arm64-setup.exe', true],
    ['exe-arm', 'MotrixNext_3.4.6_aarch64-setup.exe', true],
    ['appimage-x64', 'MotrixNext_3.4.6_amd64.AppImage', true],
    ['appimage-x64', 'MotrixNext_3.4.6_aarch64.AppImage', false],
    ['deb-x64', 'MotrixNext_3.4.6_amd64.deb', true],
    ['deb-x64', 'MotrixNext_3.4.6_amd64.AppImage', false],
    ['deb-arm', 'MotrixNext_3.4.6_arm64.deb', true],
    ['deb-arm', 'MotrixNext_3.4.6_aarch64.deb', true],
    ['rpm-x64', 'MotrixNext_3.4.6_x86_64.rpm', true],
    ['rpm-x64', 'MotrixNext_3.4.6_aarch64.rpm', false],
    ['rpm-arm', 'MotrixNext_3.4.6_aarch64.rpm', true],
    ['rpm-arm', 'MotrixNext_3.4.6_x86_64.rpm', false],
  ]

  it.each(matchCases)('platform %s matcher returns %s for filename "%s"', (key, filename, expected) => {
    const platform = PLATFORMS.find((p) => p.key === key)
    expect(platform).toBeDefined()
    expect(platform.match(filename)).toBe(expected)
  })
})
