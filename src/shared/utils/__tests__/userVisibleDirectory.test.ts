import { describe, expect, it, vi } from 'vitest'
import { resolveUserVisibleDownloadDir, type UserVisibleDirectoryDeps } from '../userVisibleDirectory'

function deps(overrides: Partial<UserVisibleDirectoryDeps> = {}): UserVisibleDirectoryDeps {
  return {
    downloadDir: vi.fn(async () => '/home/parallels/'),
    homeDir: vi.fn(async () => '/home/parallels'),
    appDataDir: vi.fn(async () => '/home/parallels/.local/share/com.motrix.next'),
    exists: vi.fn(async (path: string) => path === '/home/parallels/Downloads'),
    join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
    ...overrides,
  }
}

describe('resolveUserVisibleDownloadDir', () => {
  it('uses an existing configured directory before probing OS defaults', async () => {
    const d = deps({
      exists: vi.fn(async (path: string) => path === '/data/downloads'),
    })

    const result = await resolveUserVisibleDownloadDir({ configuredDir: '/data/downloads', deps: d })

    expect(result).toEqual({ path: '/data/downloads', source: 'configured', usedFallback: false })
    expect(d.downloadDir).not.toHaveBeenCalled()
  })

  it('uses ~/Downloads when Linux XDG resolves Downloads to home but ~/Downloads exists', async () => {
    const d = deps()

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels/Downloads', source: 'home-downloads', usedFallback: true })
  })

  it('uses the OS download directory when it is distinct from home', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => '/home/parallels/Downloads'),
      exists: vi.fn(async (path: string) => path === '/home/parallels/Downloads'),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels/Downloads', source: 'system-downloads', usedFallback: false })
  })

  it('falls back to home when Downloads does not exist', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => '/home/parallels/'),
      exists: vi.fn(async () => false),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels', source: 'home', usedFallback: true })
  })

  it('falls back to app data when all user directory probes fail', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => {
        throw new Error('unknown path')
      }),
      homeDir: vi.fn(async () => {
        throw new Error('home missing')
      }),
      exists: vi.fn(async () => false),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({
      path: '/home/parallels/.local/share/com.motrix.next',
      source: 'app-data',
      usedFallback: true,
    })
  })
})
