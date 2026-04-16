import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STAT_BASE_INTERVAL, STAT_MAX_INTERVAL, STAT_MIN_INTERVAL } from '@shared/timing'

// ── Mocks ───────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'macos'),
}))

import { useAppStore } from '../app'
import { createBatchItem, resetBatchIdCounter } from '@shared/utils/batchHelpers'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

  // ── enqueueBatch ────────────────────────────────────────────────

  it('enqueueBatch deduplicates against items already in pendingBatch', () => {
    const store = useAppStore()

    store.pendingBatch = [createBatchItem('uri', 'magnet:?xt=urn:btih:existing')]

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:existing'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:new'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:existing', 'magnet:?xt=urn:btih:new'])
  })

  it('enqueueBatch deduplicates duplicates within the same incoming batch', () => {
    const store = useAppStore()

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:other'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:dup', 'magnet:?xt=urn:btih:other'])
  })

  it('enqueueBatch returns 0 and opens dialog when given empty array', () => {
    const store = useAppStore()
    const skipped = store.enqueueBatch([])
    expect(skipped).toBe(0)
    expect(store.pendingBatch).toEqual([])
  })

  it('enqueueBatch opens addTaskDialog on non-empty input', () => {
    const store = useAppStore()
    expect(store.addTaskVisible).toBe(false)
    store.enqueueBatch([createBatchItem('uri', 'https://example.com/file')])
    expect(store.addTaskVisible).toBe(true)
  })

  // ── Interval Management ─────────────────────────────────────────

  describe('interval management', () => {
    it('updateInterval sets interval within bounds', () => {
      const store = useAppStore()
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('updateInterval clamps to STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(99999)
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })

    it('updateInterval clamps to STAT_MIN_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(1)
      expect(store.interval).toBe(STAT_MIN_INTERVAL)
    })

    it('updateInterval no-ops when value equals current', () => {
      const store = useAppStore()
      store.interval = 2000
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('increaseInterval increments by 100ms by default', () => {
      const store = useAppStore()
      const before = store.interval
      store.increaseInterval()
      expect(store.interval).toBe(before + 100)
    })

    it('increaseInterval does not exceed STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.interval = STAT_MAX_INTERVAL
      store.increaseInterval()
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })

    it('decreaseInterval decrements by 100ms by default', () => {
      const store = useAppStore()
      store.interval = 2000
      store.decreaseInterval()
      expect(store.interval).toBe(1900)
    })

    it('decreaseInterval does not go below STAT_MIN_INTERVAL', () => {
      const store = useAppStore()
      store.interval = STAT_MIN_INTERVAL
      store.decreaseInterval()
      expect(store.interval).toBe(STAT_MIN_INTERVAL)
    })

    it('resetInterval restores to STAT_BASE_INTERVAL', () => {
      const store = useAppStore()
      store.interval = 9999
      store.resetInterval()
      expect(store.interval).toBe(STAT_BASE_INTERVAL)
    })
  })

  // ── Dialog State ────────────────────────────────────────────────

  describe('dialog state', () => {
    it('showAddTaskDialog sets addTaskVisible to true', () => {
      const store = useAppStore()
      expect(store.addTaskVisible).toBe(false)
      store.showAddTaskDialog()
      expect(store.addTaskVisible).toBe(true)
    })

    it('hideAddTaskDialog sets addTaskVisible to false and clears pendingBatch', () => {
      const store = useAppStore()
      store.addTaskVisible = true
      store.pendingBatch = [createBatchItem('uri', 'https://example.com')]
      store.hideAddTaskDialog()
      expect(store.addTaskVisible).toBe(false)
      expect(store.pendingBatch).toEqual([])
    })
  })

  // ── updateAddTaskOptions ────────────────────────────────────────

  describe('updateAddTaskOptions', () => {
    it('replaces addTaskOptions with provided options', () => {
      const store = useAppStore()
      store.updateAddTaskOptions({ dir: '/tmp/downloads', split: '4' } as never)
      expect(store.addTaskOptions).toEqual({ dir: '/tmp/downloads', split: '4' })
    })

    it('defaults to empty object when called with no arguments', () => {
      const store = useAppStore()
      store.addTaskOptions = { dir: '/old' } as never
      store.updateAddTaskOptions()
      expect(store.addTaskOptions).toEqual({})
    })
  })

  // ── fetchGlobalStat (one-shot initializer) ───────────────────────

  describe('fetchGlobalStat', () => {
    it('parses numeric stat values from string response', async () => {
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '102400',
          uploadSpeed: '51200',
          numActive: '2',
          numWaiting: '1',
          numStopped: '5',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.stat.downloadSpeed).toBe(102400)
      expect(store.stat.uploadSpeed).toBe(51200)
      expect(store.stat.numActive).toBe(2)
    })

    it('decreases interval when active tasks exist', async () => {
      const store = useAppStore()
      store.interval = STAT_BASE_INTERVAL
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '1000',
          uploadSpeed: '0',
          numActive: '3',
          numWaiting: '0',
          numStopped: '0',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.interval).toBeLessThanOrEqual(STAT_BASE_INTERVAL)
    })

    it('increases interval when no active tasks', async () => {
      const store = useAppStore()
      const before = store.interval
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '0',
          uploadSpeed: '0',
          numActive: '0',
          numWaiting: '0',
          numStopped: '3',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.interval).toBeGreaterThanOrEqual(before)
      expect(store.stat.downloadSpeed).toBe(0)
    })

    it('survives API error without crashing', async () => {
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockRejectedValue(new Error('network')),
      }
      await expect(store.fetchGlobalStat(api)).resolves.toBeUndefined()
    })

    it('does NOT invoke tray/dock/progress commands (Rust handles those)', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '1048576',
          uploadSpeed: '0',
          numActive: '1',
          numWaiting: '0',
          numStopped: '0',
        }),
      }
      await store.fetchGlobalStat(api)
      // After the architectural migration, fetchGlobalStat is a pure data
      // initializer — it must not invoke any tray/dock/progress commands.
      const uiCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
        ['update_tray_title', 'update_dock_badge', 'update_progress_bar'].includes(c[0] as string),
      )
      expect(uiCalls).toHaveLength(0)
    })
  })

  // ── handleStatEvent (Rust event → reactive state) ───────────────

  describe('handleStatEvent', () => {
    it('updates stat values from event payload', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 204800,
        uploadSpeed: 10240,
        numActive: 2,
        numWaiting: 1,
        numStopped: 5,
        numStoppedTotal: 10,
      })
      expect(store.stat.downloadSpeed).toBe(204800)
      expect(store.stat.uploadSpeed).toBe(10240)
      expect(store.stat.numActive).toBe(2)
      expect(store.stat.numWaiting).toBe(1)
      expect(store.stat.numStopped).toBe(5)
    })

    it('decreases interval when active tasks are present', () => {
      const store = useAppStore()
      store.interval = STAT_BASE_INTERVAL
      store.handleStatEvent({
        downloadSpeed: 1000,
        uploadSpeed: 0,
        numActive: 3,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.interval).toBeLessThanOrEqual(STAT_BASE_INTERVAL)
    })

    it('increases interval when idle (numActive = 0)', () => {
      const store = useAppStore()
      const before = store.interval
      store.handleStatEvent({
        downloadSpeed: 0,
        uploadSpeed: 0,
        numActive: 0,
        numWaiting: 0,
        numStopped: 3,
        numStoppedTotal: 5,
      })
      expect(store.interval).toBeGreaterThanOrEqual(before)
    })

    it('zeros downloadSpeed when no active tasks', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 999,
        uploadSpeed: 100,
        numActive: 0,
        numWaiting: 0,
        numStopped: 1,
        numStoppedTotal: 1,
      })
      // downloadSpeed is forced to 0 when numActive === 0
      // (matches fetchGlobalStat behavior and Rust's expectation)
      expect(store.stat.downloadSpeed).toBe(0)
      expect(store.stat.uploadSpeed).toBe(100)
    })

    it('preserves downloadSpeed when tasks are active', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 512000,
        uploadSpeed: 0,
        numActive: 1,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.stat.downloadSpeed).toBe(512000)
    })
  })

  // ── fetchEngineInfo ─────────────────────────────────────────────

  describe('fetchEngineInfo', () => {
    it('stores engine version and features', async () => {
      const store = useAppStore()
      const api = {
        getVersion: vi.fn().mockResolvedValue({ version: '1.37.0', enabledFeatures: ['BitTorrent', 'GZip'] }),
      }
      await store.fetchEngineInfo(api)
      expect(store.engineInfo.version).toBe('1.37.0')
      expect(store.engineInfo.enabledFeatures).toContain('BitTorrent')
    })
  })

  // ── fetchEngineOptions ──────────────────────────────────────────

  describe('fetchEngineOptions', () => {
    it('stores global engine options and returns data', async () => {
      const store = useAppStore()
      const api = {
        getGlobalOption: vi.fn().mockResolvedValue({ dir: '/downloads', split: '5' }),
      }
      const result = await store.fetchEngineOptions(api)
      expect(store.engineOptions).toMatchObject({ dir: '/downloads', split: '5' })
      expect(result).toEqual({ dir: '/downloads', split: '5' })
    })
  })

  // ── handleDeepLinkUrls ──────────────────────────────────────────

  describe('handleDeepLinkUrls', () => {
    it('detects remote .torrent and .metalink URLs with correct kind', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([
        'https://example.com/linux.torrent',
        'https://example.com/bundle.meta4',
        'ftp://example.com/archive.metalink',
      ])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'https://example.com/linux.torrent' },
        { kind: 'metalink', source: 'https://example.com/bundle.meta4' },
        { kind: 'metalink', source: 'ftp://example.com/archive.metalink' },
      ])
    })

    it('keeps local file:// torrent and metalink references as file items', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///Users/test/Downloads/a.torrent', 'file:///Users/test/Downloads/b.meta4'])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: '/Users/test/Downloads/a.torrent' },
        { kind: 'metalink', source: '/Users/test/Downloads/b.meta4' },
      ])
    })

    it('normalizes Windows file URIs without leaving a leading slash before the drive letter', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///C:/Users/test/Downloads/Space%20Name.torrent'])

      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'C:/Users/test/Downloads/Space Name.torrent' },
      ])
    })

    it('handles magnet links', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['magnet:?xt=urn:btih:abc123'])
      expect(store.pendingBatch[0].kind).toBe('uri')
      expect(store.pendingBatch[0].source).toBe('magnet:?xt=urn:btih:abc123')
    })

    it('no-ops for empty or null-ish input', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([])
      expect(store.pendingBatch).toEqual([])
    })

    it('handles mixed protocol URLs', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([
        'https://example.com/file.zip',
        'magnet:?xt=urn:btih:hash',
        'file:///local/path.torrent',
      ])
      expect(store.pendingBatch).toHaveLength(3)
    })
  })
})
