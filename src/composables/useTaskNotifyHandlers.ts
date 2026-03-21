/**
 * @fileoverview Extracted notification handlers for task lifecycle events.
 *
 * These handlers are registered by TaskView as callbacks on TaskStore.
 * Extracted here as pure functions for independent unit testing —
 * following the same pattern as useTaskLifecycle.ts.
 *
 * Each handler sends both an in-app toast (via Naive UI message) and
 * an OS-level notification (via tauri-plugin-notification), gated
 * by the user's taskNotification preference.
 */
import type { Aria2Task } from '@shared/types'
import { getTaskDisplayName } from '@shared/utils'
import { isMetadataTask } from '@/composables/useTaskLifecycle'
import { notifyOs } from '@/composables/useOsNotification'

/** Dependency interface for testability. */
export interface NotifyDeps {
  messageSuccess: (content: string) => void
  messageError: (content: string, options?: Record<string, unknown>) => void
  t: (key: string, params?: Record<string, unknown>) => string
  taskNotification: boolean
}

/**
 * Handle a completed HTTP/FTP download.
 * Sends in-app toast + OS notification unless gated or metadata task.
 */
export function handleTaskComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (isMetadataTask(task)) return
  if (!deps.taskNotification) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.download-complete-message', { taskName })
  deps.messageSuccess(body)
  notifyOs('MotrixNext', body)
}

/**
 * Handle a BT download entering seeding state (download phase complete).
 * Sends in-app toast + OS notification unless gated.
 */
export function handleBtComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (!deps.taskNotification) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.bt-download-complete-message', { taskName })
  deps.messageSuccess(body)
  notifyOs('MotrixNext', body)
}

/**
 * Handle a download error — send OS notification for the error text.
 * The in-app error toast is already handled by the caller in TaskView.
 */
export function handleTaskError(_task: Aria2Task, errorText: string, deps: NotifyDeps): void {
  if (!deps.taskNotification) return
  notifyOs('MotrixNext', errorText)
}
