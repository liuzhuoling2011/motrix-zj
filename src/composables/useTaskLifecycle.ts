/** @fileoverview Pure utility functions for task lifecycle events.
 *
 * Bridges aria2 task state changes to download history records
 * and cleanup logic. All functions are pure for testability.
 */
import type { Aria2Task, HistoryRecord } from '@shared/types'

/** Extract a HistoryRecord from an aria2 task for persistence. */
export function buildHistoryRecord(task: Aria2Task): HistoryRecord {
  const btName = task.bittorrent?.info?.name
  const firstFile = task.files?.[0]
  const pathName = firstFile?.path?.split(/[/\\]/).pop()
  const name = btName || pathName || 'Unknown'

  const uri = firstFile?.uris?.[0]?.uri
  const taskType = task.bittorrent ? 'bt' : 'uri'

  return {
    gid: task.gid,
    name,
    uri: uri ?? undefined,
    dir: task.dir ?? undefined,
    total_length: task.totalLength ? Number(task.totalLength) : undefined,
    status: task.status,
    task_type: taskType,
    completed_at: new Date().toISOString(),
  }
}

/** Determine if stale record cleanup should run based on user config. */
export function shouldRunStaleCleanup(config: Partial<{ autoDeleteStaleRecords: boolean }> | undefined): boolean {
  return config?.autoDeleteStaleRecords === true
}
