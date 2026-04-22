/**
 * @fileoverview Extracted notification handlers for task lifecycle events.
 *
 * These handlers are registered by MainLayout as callbacks on the lifecycle
 * service. Extracted here as pure functions for independent unit testing —
 * following the same pattern as useTaskLifecycle.ts.
 *
 * **Notification architecture:**
 * - In-app toast (Naive UI message) — always fires for immediate feedback.
 * - OS-level notification (tauri-plugin-notification) — gated by the
 *   user's `taskNotification` preference.
 *
 * When `onOpenFile` / `onShowInFolder` callbacks are provided in deps,
 * the in-app toast renders inline action buttons so the user can open
 * the downloaded file or reveal it in the system file manager directly
 * from the notification — without navigating through the task list.
 */
import type { VNodeChild } from 'vue'
import type { Aria2Task } from '@shared/types'
import { getTaskDisplayName } from '@shared/utils'
import { logger } from '@shared/logger'
import { isMetadataTask } from '@/composables/useTaskLifecycle'
import { notifyOs } from '@/composables/useOsNotification'
import { renderCompletionToast } from '@/composables/useNotificationToast'

/** Dependency interface for testability. */
export interface NotifyDeps {
  messageSuccess: (content: string | (() => VNodeChild)) => void
  messageError: (content: string, options?: Record<string, unknown>) => void
  t: (key: string, params?: Record<string, unknown>) => string
  taskNotification: boolean
  /** Optional: open the downloaded file with the default application. */
  onOpenFile?: (task: Aria2Task) => void
  /** Optional: reveal the downloaded file in the system file manager. */
  onShowInFolder?: (task: Aria2Task) => void
}

/**
 * Handle a completed HTTP/FTP download.
 * Always sends in-app toast; OS notification gated by `taskNotification`.
 *
 * When action callbacks are provided, the toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleTaskComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (isMetadataTask(task)) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.download-complete-message', { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: deps.onOpenFile ? () => deps.onOpenFile!(task) : undefined,
    onShowInFolder: deps.onShowInFolder ? () => deps.onShowInFolder!(task) : undefined,
  })
  deps.messageSuccess(toastContent)
  if (deps.taskNotification) {
    notifyOs('MotrixNext', body)
  }
  logger.info('TaskNotify.complete', `gid=${task.gid} name="${taskName}"`)
}

/**
 * Handle a BT download entering seeding state (download phase complete).
 * Always sends in-app toast; OS notification gated by `taskNotification`.
 *
 * When action callbacks are provided, the toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleBtComplete(task: Aria2Task, deps: NotifyDeps): void {
  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.bt-download-complete-message', { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: deps.onOpenFile ? () => deps.onOpenFile!(task) : undefined,
    onShowInFolder: deps.onShowInFolder ? () => deps.onShowInFolder!(task) : undefined,
  })
  deps.messageSuccess(toastContent)
  if (deps.taskNotification) {
    notifyOs('MotrixNext', body)
  }
  logger.info('TaskNotify.btComplete', `gid=${task.gid} name="${taskName}" → seeding`)
}

/**
 * Handle a download error — send OS notification for the error text.
 * The in-app error toast is already handled by the caller in MainLayout.
 * OS notification gated by `taskNotification`.
 */
export function handleTaskError(_task: Aria2Task, errorText: string, deps: NotifyDeps): void {
  if (deps.taskNotification) {
    notifyOs('MotrixNext', errorText)
  }
  logger.warn('TaskNotify.error', `gid=${_task.gid} error="${errorText}"`)
}

// ── Download-start notification ─────────────────────────────────────

/** Dependency interface for start notification — minimal subset. */
export interface StartNotifyDeps {
  messageInfo: (content: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
  taskNotification: boolean
}

/**
 * Handle download submission success — send start notification.
 *
 * For single tasks:  "Started downloading movie.mp4"
 * For batch tasks:   "Started downloading movie.mp4 and 2 other task(s)"
 *
 * Toast always fires; OS notification gated by `taskNotification`.
 */
export function handleTaskStart(taskNames: string[], deps: StartNotifyDeps): void {
  if (taskNames.length === 0) return

  const firstName = taskNames[0]
  const body =
    taskNames.length === 1
      ? deps.t('task.download-start-message', { taskName: firstName })
      : deps.t('task.download-batch-start-message', {
          taskName: firstName,
          count: taskNames.length - 1,
        })

  deps.messageInfo(body)
  if (deps.taskNotification) {
    notifyOs('MotrixNext', body)
  }
  logger.info('TaskNotify.start', `count=${taskNames.length} first="${firstName}"`)
}
