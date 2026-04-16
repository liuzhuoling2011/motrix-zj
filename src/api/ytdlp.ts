import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ParseResult, YtdlpProgress } from '@shared/types'

/** Parses a URL with yt-dlp to detect video/playlist content. */
export async function parseUrl(url: string): Promise<ParseResult> {
  return invoke<ParseResult>('ytdlp_parse_url', { url })
}

/** Downloads a video through aria2 (for direct-link formats). */
export async function downloadViaAria2(params: {
  url: string
  formatId: string
  options: Record<string, string>
}): Promise<string> {
  return invoke<string>('ytdlp_download_via_aria2', {
    url: params.url,
    formatId: params.formatId,
    options: params.options,
  })
}

/** Downloads a video directly with yt-dlp (HLS/DASH fallback). */
export async function downloadDirect(params: {
  url: string
  formatId: string
  title: string
  meta: Record<string, unknown>
  options: Record<string, string>
}): Promise<string> {
  return invoke<string>('ytdlp_download_direct', {
    url: params.url,
    formatId: params.formatId,
    title: params.title,
    meta: params.meta,
    options: params.options,
  })
}

/** Cancels an active yt-dlp direct download. */
export async function cancelDownload(taskId: string): Promise<void> {
  return invoke<void>('ytdlp_cancel_download', { taskId })
}

/** Subscribes to yt-dlp download progress events. Returns an unlisten function. */
export async function onProgress(callback: (progress: YtdlpProgress) => void): Promise<() => void> {
  return listen<YtdlpProgress>('ytdlp-progress', (event) => {
    callback(event.payload)
  })
}
