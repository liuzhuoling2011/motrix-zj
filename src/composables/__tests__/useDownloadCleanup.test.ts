/** @fileoverview TDD tests for stale record detection and torrent cleanup utilities. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExists = vi.fn()
const mockRemove = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => mockExists(...args),
  remove: (...args: unknown[]) => mockRemove(...args),
}))

// Mock Tauri path — join uses OS-native separator, mock with /
vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}))

const { findStaleRecords, deleteTorrentFile, shouldDeleteTorrent } = await import('../useDownloadCleanup')

describe('useDownloadCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── findStaleRecords ────────────────────────────────────────────

  describe('findStaleRecords', () => {
    it('returns GIDs of records whose files do not exist', async () => {
      mockExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false)

      const records = [
        { gid: 'g1', dir: '/dl', name: 'exists.zip' },
        { gid: 'g2', dir: '/dl', name: 'gone.zip' },
        { gid: 'g3', dir: '/dl', name: 'deleted.zip' },
      ]

      const stale = await findStaleRecords(records)
      expect(stale).toEqual(['g2', 'g3'])
    })

    it('returns empty array when all files exist', async () => {
      mockExists.mockResolvedValue(true)

      const records = [
        { gid: 'g1', dir: '/dl', name: 'a.zip' },
        { gid: 'g2', dir: '/dl', name: 'b.zip' },
      ]

      const stale = await findStaleRecords(records)
      expect(stale).toEqual([])
    })

    it('handles empty input', async () => {
      const stale = await findStaleRecords([])
      expect(stale).toEqual([])
    })

    it('skips records with missing dir or name', async () => {
      mockExists.mockResolvedValue(true)

      const records = [
        { gid: 'g1', dir: '', name: 'a.zip' },
        { gid: 'g2', dir: '/dl', name: '' },
        { gid: 'g3', dir: '/dl', name: 'valid.zip' },
      ]

      const stale = await findStaleRecords(records)
      // g1 and g2 should be treated as stale (can't verify file existence)
      expect(stale).toContain('g1')
      expect(stale).toContain('g2')
      expect(stale).not.toContain('g3')
    })
  })

  // ── deleteTorrentFile ───────────────────────────────────────────

  describe('deleteTorrentFile', () => {
    it('deletes a torrent file that exists', async () => {
      mockExists.mockResolvedValue(true)
      mockRemove.mockResolvedValue(undefined)

      const result = await deleteTorrentFile('/downloads/movie.torrent')
      expect(result).toBe(true)
      expect(mockRemove).toHaveBeenCalledWith('/downloads/movie.torrent')
    })

    it('returns false when file does not exist', async () => {
      mockExists.mockResolvedValue(false)

      const result = await deleteTorrentFile('/downloads/gone.torrent')
      expect(result).toBe(false)
      expect(mockRemove).not.toHaveBeenCalled()
    })

    it('returns false on error and does not throw', async () => {
      mockExists.mockResolvedValue(true)
      mockRemove.mockRejectedValue(new Error('perm denied'))

      const result = await deleteTorrentFile('/downloads/locked.torrent')
      expect(result).toBe(false)
    })

    it('returns false for empty path', async () => {
      const result = await deleteTorrentFile('')
      expect(result).toBe(false)
    })
  })

  // ── shouldDeleteTorrent ─────────────────────────────────────────

  describe('shouldDeleteTorrent', () => {
    it('returns true when setting is enabled', () => {
      expect(shouldDeleteTorrent({ deleteTorrentAfterComplete: true })).toBe(true)
    })

    it('returns false when setting is disabled', () => {
      expect(shouldDeleteTorrent({ deleteTorrentAfterComplete: false })).toBe(false)
    })

    it('returns false when setting is undefined', () => {
      expect(shouldDeleteTorrent({})).toBe(false)
    })
  })
})
