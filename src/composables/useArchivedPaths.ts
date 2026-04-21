/**
 * @fileoverview Runtime lookup table for auto-archived file paths.
 *
 * After auto-archive moves a completed download to a category directory,
 * aria2's `tellStopped` still reports the original download path in
 * `task.files[0].path`.  This module provides a session-scoped Map that
 * stores the post-move path so that all path-consuming code (file-missing
 * badge, open file, show in folder) resolves to the correct location.
 *
 * Cross-session persistence is handled separately by updating the
 * HistoryRecord's `meta.files[].path` in the SQLite database (see
 * `updateHistoryFilePath` in useTaskLifecycle.ts).
 *
 * Design rationale — plain Map instead of Pinia store:
 *   - Data is ephemeral (current session only)
 *   - No Vue reactivity needed (consumers poll via setTimeout, not watch)
 *   - No serialization / devtools requirements
 *   - Minimal footprint — one module-level Map, four exported functions
 */

import type { Aria2Task } from '@shared/types'

/** gid → normalized forward-slash path after archive move. */
const archivedPaths = new Map<string, string>()

/**
 * Register the post-archive file path for a task.
 * Called once in the MainLayout `onTaskComplete` handler after `move_file` succeeds.
 */
export function setArchivedPath(gid: string, newPath: string): void {
  archivedPaths.set(gid, newPath)
}

/**
 * Retrieve the archived path for a task, if one exists.
 * Returns `undefined` when the task was not archived in this session.
 */
export function getArchivedPath(gid: string): string | undefined {
  return archivedPaths.get(gid)
}

/**
 * Remove the archived path entry for a task.
 * Called when the task is deleted from the UI to prevent unbounded Map growth.
 */
export function clearArchivedPath(gid: string): void {
  archivedPaths.delete(gid)
}

/**
 * Unified file path resolver for a completed/stopped task.
 *
 * All code that needs "the file path for this task" MUST go through this
 * function instead of reading `task.files[0].path` directly.
 *
 * Resolution order:
 *   1. Archived path (session Map) — set after auto-archive move
 *   2. task.files[0].path — aria2 original or history-reconstructed path
 *
 * Returns `null` when no file path is available (e.g. metadata-only task).
 */
export function resolveTaskFilePath(task: Aria2Task): string | null {
  const archived = archivedPaths.get(task.gid)
  if (archived) return archived

  const files = task.files
  if (!files || files.length === 0) return null

  const selected = files.filter((f) => f.selected === 'true')
  return (selected.length > 0 ? selected[0] : files[0])?.path ?? null
}
