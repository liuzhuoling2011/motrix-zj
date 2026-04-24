/**
 * @fileoverview Extracted restartTask logic — re-submits stopped/errored/completed
 * downloads with rollback on partial failure.
 *
 * This module is a pure async function with explicit dependency injection,
 * making it independently testable without Pinia or Vue reactivity.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, getRestartDescriptors } from '@shared/utils'
import { shouldShowFileSelection } from '@/composables/useMagnetFlow'
import { logger } from '@shared/logger'
import * as ytdlpApi from '@/api/ytdlp'
import { useHistoryStore } from '@/stores/history'
import type { Aria2Task } from '@shared/types'

/** Minimal API surface needed by restartTask. */
export interface RestartTaskApi {
  addUriAtomic: (params: { uris: string[]; options: Record<string, string> }) => Promise<string>
  getOption: (params: { gid: string }) => Promise<Record<string, string>>
  removeTask: (params: { gid: string }) => Promise<string>
  removeTaskRecord: (params: { gid: string }) => Promise<string>
  fetchList: () => Promise<unknown>
  saveSession: () => Promise<string>
}

/** Minimal history API needed for cleanup. */
export interface RestartHistoryApi {
  removeRecord: (gid: string) => Promise<void>
}

/** Keys that aria2 rejects on addUri — read-only or non-portable. */
const NON_PORTABLE_KEYS = new Set(['followTorrent', 'followMetalink', 'pauseMetadata', 'gid'])

/** Re-invoke `ytdlp_download_direct` for a previously-submitted yt-dlp task.
 *
 *  The persisted meta JSON carries the original `format_id` + `ext` +
 *  optional `cookies_from_browser`, so we can replay the download without
 *  asking the user to re-parse the video. yt-dlp's default `--continue`
 *  will pick up from any leftover `<name>.part` in the same dir.
 *
 *  Throws when the record is missing the URL or format_id (shouldn't happen
 *  for records created after the meta-format_id migration, but older rows
 *  exist — the caller surfaces the message as a toast).
 */
async function restartYtdlpTask(task: Aria2Task, historyApi: RestartHistoryApi): Promise<void> {
  const historyStore = useHistoryStore()
  const record = await historyStore.getRecordByGid(task.gid)
  if (!record) {
    throw new Error('找不到 yt-dlp 历史记录，无法重试')
  }
  const url = record.uri ?? ''
  if (!url) {
    throw new Error('yt-dlp 任务缺少来源链接，无法重试')
  }
  let meta: Record<string, unknown> = {}
  if (record.meta) {
    try {
      meta = JSON.parse(record.meta) as Record<string, unknown>
    } catch (e) {
      logger.debug('restartTask.ytdlp.parseMeta', e)
    }
  }
  const formatId = typeof meta.format_id === 'string' ? meta.format_id : ''
  if (!formatId) {
    throw new Error('yt-dlp 任务缺少 format_id（旧记录），请在浏览器面板重新添加下载')
  }
  const ext = typeof meta.ext === 'string' ? meta.ext : 'mp4'
  const cookiesFromBrowser = typeof meta.cookies_from_browser === 'string' ? meta.cookies_from_browser : undefined
  const dir = record.dir ?? ''
  if (!dir) {
    throw new Error('yt-dlp 任务缺少下载目录，无法重试')
  }
  const title = record.name ? record.name.replace(/\.[^./\\]+$/, '') : 'video'

  await ytdlpApi.downloadDirect({
    url,
    formatId,
    title,
    ext,
    meta,
    options: { dir },
    cookiesFromBrowser,
  })
  // Drop the old error record — the new download has a fresh gid
  // (ytdlp-{bootTs}-{N}) and appears in the list on its own.
  try {
    await historyApi.removeRecord(task.gid)
  } catch (e) {
    logger.debug('restartTask.ytdlp.removeOldRecord', e)
  }
}

/**
 * Restarts a stopped/errored/completed task by re-submitting its URI(s).
 *
 * - For BT tasks: rebuilds the magnet link → single addUri call.
 * - For multi-file HTTP/FTP tasks: submits each file URI separately.
 * - Uses rollback on partial failure: if any URI fails, all previously
 *   created downloads are removed so no orphan tasks remain.
 * - The old stopped record is only deleted after ALL new downloads succeed.
 */
export async function restartTask(task: Aria2Task, api: RestartTaskApi, historyApi: RestartHistoryApi): Promise<void> {
  const { status, gid, dir } = task
  const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
  if (status !== ERROR && status !== COMPLETE && status !== REMOVED) return

  // yt-dlp direct downloads can't be restarted via aria2 — the source URL
  // is a video page (html), not a direct download link. Handing it to
  // aria2.addUri would download the page's HTML instead of the video.
  // Instead re-invoke ytdlp_download_direct with the persisted format_id
  // (yt-dlp's --continue flag will resume from any leftover .part file
  // in the same dir).
  if (gid.startsWith('ytdlp-')) {
    await restartYtdlpTask(task, historyApi)
    await api.fetchList()
    return
  }

  const descriptors = getRestartDescriptors(task, true) // include trackers for BT
  if (descriptors.length === 0) {
    throw new Error('Cannot restart: no download URIs found for this task')
  }

  // Preserve original per-task options (headers, proxy, auth, out, select-file, etc.).
  const options: Record<string, string> = {}
  try {
    const orig = await api.getOption({ gid })
    for (const [k, v] of Object.entries(orig)) {
      if (!NON_PORTABLE_KEYS.has(k) && v !== '') {
        options[k] = v
      }
    }
  } catch (e) {
    logger.warn('restartTask', `getOption gid=${gid} failed, using dir-only fallback: ${e}`)
    // Fallback: at minimum preserve download directory
    if (dir) options.dir = dir
  }

  // Submit each file as a separate download with ALL its mirror URIs,
  // tracking created GIDs for rollback.
  const isBT = checkTaskIsBT(task)
  const createdGids: string[] = []
  try {
    for (const mirrorGroup of descriptors) {
      const newGid = await api.addUriAtomic({ uris: mirrorGroup, options })
      createdGids.push(newGid)
      // BT restarts produce magnet URIs — register with the metadata poller
      // only when pause-metadata is enabled (file selection mode).
      if (isBT) {
        const { usePreferenceStore } = await import('@/stores/preference')
        const preferenceStore = usePreferenceStore()
        if (shouldShowFileSelection(preferenceStore.config)) {
          const { useAppStore } = await import('@/stores/app')
          const appStore = useAppStore()
          appStore.pendingMagnetGids = [...appStore.pendingMagnetGids, newGid]
        }
      }
    }
  } catch (e) {
    // Rollback: remove any partially created tasks
    for (const newGid of createdGids) {
      try {
        await api.removeTask({ gid: newGid })
      } catch (e) {
        logger.debug('restartTask', `rollback removeTask gid=${newGid} skipped: ${e}`)
      }
    }
    throw e // propagate original error to caller
  }

  // All new downloads succeeded — remove old record from both sources
  try {
    await api.removeTaskRecord({ gid })
  } catch (e) {
    logger.debug('restartTask.removeRecord', e)
  }
  try {
    await historyApi.removeRecord(gid)
  } catch (e) {
    logger.debug('restartTask.removeHistoryRecord', e)
  }

  await api.fetchList()
  await api.saveSession()
}
