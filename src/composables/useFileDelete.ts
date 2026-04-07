/** @fileoverview Composable for deleting download task files and associated artifacts from disk.
 *
 * All user-facing file deletions go through `trashPath()` which moves files to
 * the OS trash / recycle bin via the Rust `trash_file` command.  This provides
 * a recoverable delete experience across all three platforms:
 * - macOS:  NSFileManager.trashItemAtURL
 * - Windows: IFileOperation + FOFX_RECYCLEONDELETE
 * - Linux:  FreeDesktop Trash spec (XDG_DATA_HOME/Trash)
 *
 * Folder detection reuses the existing `resolveOpenTarget` + `check_path_is_dir`
 * infrastructure so folder downloads are trashed in a single OS call (one sound).
 */
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
import { resolveOpenTarget } from '@shared/utils'
import { cleanupTorrentMetadataFiles } from '@/composables/useDownloadCleanup'
import type { Aria2Task } from '@shared/types'

/**
 * Move a file or directory to the OS trash / recycle bin.
 *
 * Silent no-op when the path is empty, doesn't exist, or the operation fails.
 * Returns `true` if the item was successfully trashed.
 */
export async function trashPath(path: string): Promise<boolean> {
  if (!path) return false
  try {
    const exists = await invoke<boolean>('check_path_exists', { path })
    if (!exists) return false
    await invoke('trash_file', { path })
    return true
  } catch (e) {
    logger.debug('trashPath', `Failed to trash ${path}: ${e}`)
    return false
  }
}

/**
 * Moves all files associated with a download task to the OS trash.
 *
 * Uses `resolveOpenTarget()` to determine the primary target path, then
 * `check_path_is_dir` to detect whether it's a folder or single file:
 *
 * - **Folder download** (BT multi-file): trashes the entire directory in one
 *   OS call — eliminates the N×2 individual trash calls that caused multiple
 *   delete sounds on macOS.  Also trashes the external `.aria2` control file
 *   that sits alongside the directory.
 *
 * - **Single-file download** (HTTP/BT single): trashes the file and its
 *   companion `.aria2` control file.
 *
 * - **Fallback** (no resolvable target): trashes files individually.
 *
 * For BT tasks, also cleans up the hex40-named `.torrent` metadata file that
 * aria2 saves via `rpc-save-upload-metadata` / `bt-save-metadata`.
 *
 * Safety: the download directory itself is NEVER trashed — `resolveOpenTarget`
 * returns `dir` only as a fallback, and that case delegates to per-file trash.
 */
export async function deleteTaskFiles(task: Aria2Task): Promise<void> {
  const target = await resolveOpenTarget(task)

  // Fallback: resolveOpenTarget returned the bare download directory,
  // meaning no specific file/folder could be resolved — trash individually.
  if (!target || target === task.dir) {
    await trashFilesIndividually(task)
    return
  }

  const isDir = await invoke<boolean>('check_path_is_dir', { path: target })
  if (isDir) {
    // Folder task: trash the entire directory in a single OS call
    await trashPath(target)
    // External .aria2 control file sits alongside the folder (e.g., "My Torrent.aria2")
    await trashPath(target + '.aria2')
  } else {
    // Single-file task: trash the file + companion .aria2 control file
    await trashPath(target)
    await trashPath(target + '.aria2')
  }

  // BT tasks: clean up the hex40-named .torrent metadata file in the download dir
  if (task.dir && task.infoHash) {
    await cleanupTorrentMetadataFiles(task.dir, task.infoHash)
  }
}

/**
 * Fallback: trash files one by one.
 * Used when `resolveOpenTarget` cannot determine a specific target
 * (e.g., magnet still resolving metadata, or task with empty file list).
 */
async function trashFilesIndividually(task: Aria2Task): Promise<void> {
  for (const f of task.files || []) {
    if (!f.path) continue
    await trashPath(f.path)
    await trashPath(f.path + '.aria2')
  }
}
