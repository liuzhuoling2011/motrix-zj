/** @fileoverview Utilities for download cleanup: stale record detection and torrent file removal.
 *
 * Pure, testable functions — side effects (FS access) are injected via imports.
 */
import { exists, remove } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { logger } from '@shared/logger'

/** Record shape needed for stale detection (not the full HistoryRecord). */
export interface StaleCheckItem {
  gid: string
  dir: string
  name: string
}

/** Identify records whose downloaded files no longer exist on disk.
 *  Returns the GIDs of stale records. */
export async function findStaleRecords(records: StaleCheckItem[]): Promise<string[]> {
  const staleGids: string[] = []

  for (const record of records) {
    if (!record.dir || !record.name) {
      staleGids.push(record.gid)
      continue
    }

    try {
      const filePath = await join(record.dir, record.name)
      const fileExists = await exists(filePath)
      if (!fileExists) {
        staleGids.push(record.gid)
      }
    } catch {
      staleGids.push(record.gid)
    }
  }

  return staleGids
}

/** Delete a torrent source file. Returns true on success, false otherwise. */
export async function deleteTorrentFile(path: string): Promise<boolean> {
  if (!path) return false

  try {
    const fileExists = await exists(path)
    if (!fileExists) return false

    await remove(path)
    return true
  } catch (e) {
    logger.warn('deleteTorrentFile', `Failed to delete ${path}: ${e}`)
    return false
  }
}

/** Check whether the "delete torrent after complete" setting is enabled. */
export function shouldDeleteTorrent(config: Partial<{ deleteTorrentAfterComplete: boolean }>): boolean {
  return config.deleteTorrentAfterComplete === true
}
