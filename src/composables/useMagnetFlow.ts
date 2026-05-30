/** @fileoverview Pure utility functions for the magnet URI file selection flow.
 *
 * Extracted as pure functions for testability:
 * - Detect magnet URIs
 * - Build metadata-only aria2 options
 * - Parse aria2 file list into UI-friendly selection items
 * - Build the select-file option string
 */
import type { Aria2File, Aria2EngineOptions, Aria2Task } from '@shared/types'

/** Check if a URI is a magnet link. */
export function isMagnetUri(uri: string): boolean {
  return uri.toLowerCase().startsWith('magnet:')
}

/** Augment engine options to download metadata only (no actual files). */
export function buildMetadataOnlyOptions(baseOptions: Aria2EngineOptions): Aria2EngineOptions {
  return {
    ...baseOptions,
    'pause-metadata': 'true',
  }
}

/** A file entry parsed for the selection UI. */
export interface MagnetFileItem {
  index: number
  name: string
  path: string
  length: number
}

/** Convert raw Aria2File array into UI-friendly selection items. */
export function parseFilesForSelection(files: Aria2File[]): MagnetFileItem[] {
  return files.map((f) => {
    const parts = f.path.split(/[/\\]/)
    return {
      index: Number(f.index),
      name: parts[parts.length - 1],
      path: f.path,
      length: Number(f.length),
    }
  })
}

/** Build the aria2 select-file option string from selected indices. */
export function buildSelectFileOption(indices: number[]): string {
  if (indices.length === 0) return ''
  return [...indices].sort((a, b) => a - b).join(',')
}

/**
 * Determines whether the file selection dialog should be shown for a magnet download.
 *
 * When pauseMetadata=true (btAutoDownloadContent unchecked), aria2 pauses the
 * follow-up download after metadata resolves — giving the UI a chance to show
 * the file selection dialog.
 *
 * When pauseMetadata=false (btAutoDownloadContent checked), aria2 starts the
 * follow-up download immediately — no file selection needed.
 *
 * Defaults to true (show dialog) when the config value is missing,
 * aligning with the industry standard of giving users control over file selection.
 */
export function shouldShowFileSelection(config: { pauseMetadata?: boolean | string }): boolean {
  return config.pauseMetadata !== false && config.pauseMetadata !== 'false'
}

export function getPendingMagnetSelectionGids(tasks: Aria2Task[]): string[] {
  return tasks
    .map((task) => {
      if (!task.bittorrent || task.status !== 'paused') return false
      if (!task.bittorrent.info?.name) return false
      if (!task.following) return false
      if (!task.files.some((file) => Number(file.length) > 0)) return false
      return task.following
    })
    .filter((gid): gid is string => typeof gid === 'string' && gid.length > 0)
}

export interface MagnetSelectionResolution {
  metadataGid: string
  downloadGid: string
}

export function getResolvedMagnetSelection(task: Aria2Task): MagnetSelectionResolution | null {
  const downloadGid = task.followedBy?.find((gid) => gid.trim().length > 0)
  if (!downloadGid) return null
  return {
    metadataGid: task.gid,
    downloadGid,
  }
}

/** Actions needed to apply file selection to a download based on its current status. */
export interface ConfirmAction {
  /** Whether the task must be resumed after applying options. */
  needsResume: boolean
}

/**
 * Determines the correct pause/resume actions for applying file selection
 * to a magnet download based on its current aria2 task status.
 *
 * - paused:   standard case with pause-metadata=true — just resume
 * - waiting:  queued task — just resume
 * - active:   engine failed to honor pause-metadata — do not race pause/unpause
 * - complete/removed/error: terminal states — no action needed
 * - undefined: safe fallback — treat as resumable
 */
export function buildStatusAwareConfirmAction(status: string | undefined): ConfirmAction {
  switch (status) {
    case 'paused':
    case 'waiting':
    case undefined:
      return { needsResume: true }
    case 'active':
    case 'complete':
    case 'removed':
    case 'error':
    default:
      return { needsResume: false }
  }
}
