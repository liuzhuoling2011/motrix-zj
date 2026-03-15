/** @fileoverview TDD tests for useTaskLifecycle — pure functions bridging
 * task events to download history and cleanup actions.
 *
 * Tests written BEFORE implementation per TDD Iron Law.
 * Mocks are used only for external Tauri APIs (unavoidable).
 */
import { describe, it, expect, vi } from 'vitest'
import type { Aria2Task } from '@shared/types'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
}))

const { buildHistoryRecord, shouldRunStaleCleanup } = await import('../useTaskLifecycle')

// ── Test data factories ──────────────────────────────────────────────

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: 'complete',
    totalLength: '1048576',
    completedLength: '1048576',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/test.zip',
        length: '1048576',
        selected: 'true',
        uris: [{ uri: 'https://example.com/test.zip', status: 'used' }],
      },
    ],
    ...overrides,
  } as unknown as Aria2Task
}

// ── buildHistoryRecord ───────────────────────────────────────────────

describe('buildHistoryRecord', () => {
  it('extracts gid, name, dir, status from Aria2Task', () => {
    const task = makeTask({ gid: 'g1', status: 'complete', dir: '/dl' })
    const record = buildHistoryRecord(task)

    expect(record.gid).toBe('g1')
    expect(record.status).toBe('complete')
    expect(record.dir).toBe('/dl')
  })

  it('extracts name from first file path basename', () => {
    const task = makeTask({
      files: [
        { index: '1', path: '/dl/big-file.iso', length: '999', completedLength: '999', selected: 'true', uris: [] },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('big-file.iso')
  })

  it('extracts name from Windows backslash path', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: 'C:\\Users\\foo\\Downloads\\setup.exe',
          length: '999',
          completedLength: '999',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('setup.exe')
  })

  it('uses bittorrent info name if available', () => {
    const task = makeTask({
      bittorrent: { info: { name: 'Ubuntu 24.04' } },
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('Ubuntu 24.04')
  })

  it('falls back to "Unknown" when no name source available', () => {
    const task = makeTask({ files: [], bittorrent: undefined })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('Unknown')
  })

  it('sets total_length from totalLength', () => {
    const task = makeTask({ totalLength: '2097152' })
    const record = buildHistoryRecord(task)
    expect(record.total_length).toBe(2097152)
  })

  it('extracts URI from first file uris array', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/dl/f.zip',
          length: '100',
          completedLength: '100',
          selected: 'true',
          uris: [{ uri: 'https://dl.example.com/f.zip', status: 'used' }],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.uri).toBe('https://dl.example.com/f.zip')
  })

  it('sets task_type to "bt" for bittorrent tasks', () => {
    const task = makeTask({ bittorrent: { info: { name: 'torrent' } } })
    const record = buildHistoryRecord(task)
    expect(record.task_type).toBe('bt')
  })

  it('sets task_type to "uri" for regular downloads', () => {
    const task = makeTask({ bittorrent: undefined })
    const record = buildHistoryRecord(task)
    expect(record.task_type).toBe('uri')
  })

  it('sets completed_at to ISO string', () => {
    const task = makeTask()
    const record = buildHistoryRecord(task)
    expect(record.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// ── shouldRunStaleCleanup ────────────────────────────────────────────

describe('shouldRunStaleCleanup', () => {
  it('returns true when autoDeleteStaleRecords is true', () => {
    expect(shouldRunStaleCleanup({ autoDeleteStaleRecords: true })).toBe(true)
  })

  it('returns false when autoDeleteStaleRecords is false', () => {
    expect(shouldRunStaleCleanup({ autoDeleteStaleRecords: false })).toBe(false)
  })

  it('returns false when config is undefined', () => {
    expect(shouldRunStaleCleanup(undefined)).toBe(false)
  })

  it('returns false when autoDeleteStaleRecords is missing', () => {
    expect(shouldRunStaleCleanup({})).toBe(false)
  })
})
