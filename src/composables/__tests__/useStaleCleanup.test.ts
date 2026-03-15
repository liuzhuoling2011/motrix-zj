/** @fileoverview TDD tests for runStaleRecordCleanup — the orchestration function
 * that connects the history store to file existence checks.
 *
 * Tests written BEFORE implementation per TDD Iron Law.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExists = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => mockExists(...args),
  remove: vi.fn(),
}))

// Mock Tauri path — join uses OS-native separator, mock with /
vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}))

const { runStaleRecordCleanup } = await import('../useStaleCleanup')

describe('runStaleRecordCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes records whose files no longer exist', async () => {
    // 3 records: file1 exists, file2 gone, file3 gone
    mockExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false)

    const records = [
      { gid: 'g1', name: 'exists.zip', dir: '/dl', status: 'complete' },
      { gid: 'g2', name: 'gone.zip', dir: '/dl', status: 'complete' },
      { gid: 'g3', name: 'deleted.zip', dir: '/dl', status: 'complete' },
    ]

    const mockRemoveStale = vi.fn().mockResolvedValue(undefined)
    const result = await runStaleRecordCleanup(records, mockRemoveStale)

    expect(result.scanned).toBe(3)
    expect(result.removed).toBe(2)
    expect(mockRemoveStale).toHaveBeenCalledWith(['g2', 'g3'])
  })

  it('does nothing when all files exist', async () => {
    mockExists.mockResolvedValue(true)

    const records = [{ gid: 'g1', name: 'a.zip', dir: '/dl', status: 'complete' }]

    const mockRemoveStale = vi.fn()
    const result = await runStaleRecordCleanup(records, mockRemoveStale)

    expect(result.scanned).toBe(1)
    expect(result.removed).toBe(0)
    expect(mockRemoveStale).not.toHaveBeenCalled()
  })

  it('does nothing with empty records', async () => {
    const mockRemoveStale = vi.fn()
    const result = await runStaleRecordCleanup([], mockRemoveStale)

    expect(result.scanned).toBe(0)
    expect(result.removed).toBe(0)
    expect(mockRemoveStale).not.toHaveBeenCalled()
  })

  it('handles errors gracefully without throwing', async () => {
    mockExists.mockRejectedValue(new Error('fs error'))

    const records = [{ gid: 'g1', name: 'a.zip', dir: '/dl', status: 'complete' }]

    const mockRemoveStale = vi.fn().mockResolvedValue(undefined)
    // Should not throw — errors mean file doesn't exist, so mark stale
    const result = await runStaleRecordCleanup(records, mockRemoveStale)
    expect(result.removed).toBe(1)
  })
})
