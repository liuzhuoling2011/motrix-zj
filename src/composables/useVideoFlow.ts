import { ref, computed } from 'vue'
import type { ParseResult, VideoInfo, VideoFormat, PlaylistInfo, PlaylistItem, FormatPreset } from '@shared/types'
import * as ytdlpApi from '@/api/ytdlp'

export function useVideoFlow() {
  const isParsing = ref(false)
  const parseResult = ref<ParseResult | null>(null)
  const parseError = ref<string | null>(null)

  /** Selected format ID for single video download */
  const selectedFormatId = ref<string>('')

  /** Selected playlist item indices for batch download */
  const selectedPlaylistItems = ref<Set<number>>(new Set())

  /** Whether to show the full format list (vs presets only) */
  const showAllFormats = ref(false)

  const isVideo = computed(() => parseResult.value?.type === 'Video')
  const isPlaylist = computed(() => parseResult.value?.type === 'Playlist')
  const isNotMedia = computed(() => parseResult.value === null || parseResult.value?.type === 'NotMedia')

  const videoInfo = computed<VideoInfo | null>(() => {
    if (parseResult.value?.type === 'Video') {
      return parseResult.value as unknown as VideoInfo
    }
    return null
  })

  const playlistInfo = computed<PlaylistInfo | null>(() => {
    if (parseResult.value?.type === 'Playlist') {
      return parseResult.value as unknown as PlaylistInfo
    }
    return null
  })

  /** Generates simplified format presets from the full format list. */
  const formatPresets = computed<FormatPreset[]>(() => {
    const info = videoInfo.value
    if (!info) return []

    const videoFormats = info.formats.filter((f: VideoFormat) => f.vcodec && f.vcodec !== 'none')
    const presets: FormatPreset[] = []

    // Best quality
    const best = videoFormats[videoFormats.length - 1]
    if (best) {
      presets.push({
        label: '最高画质',
        formatId: 'bestvideo+bestaudio/best',
        estimatedSize: best.filesize ?? best.filesizeApprox,
      })
    }

    // 1080p
    const f1080 = videoFormats.find((f: VideoFormat) => f.height === 1080)
    if (f1080) {
      presets.push({
        label: '1080p',
        formatId: f1080.formatId,
        estimatedSize: f1080.filesize ?? f1080.filesizeApprox,
      })
    }

    // 720p
    const f720 = videoFormats.find((f: VideoFormat) => f.height === 720)
    if (f720) {
      presets.push({
        label: '720p',
        formatId: f720.formatId,
        estimatedSize: f720.filesize ?? f720.filesizeApprox,
      })
    }

    // Audio only
    const audioOnly = info.formats.find(
      (f: VideoFormat) => (f.vcodec === 'none' || !f.vcodec) && f.acodec && f.acodec !== 'none',
    )
    if (audioOnly) {
      presets.push({
        label: '仅音频',
        formatId: 'bestaudio/best',
        estimatedSize: audioOnly.filesize ?? audioOnly.filesizeApprox,
      })
    }

    return presets
  })

  /** Attempts to parse a URL. Returns true if it's a video/playlist.
   *  `cookie`, `userAgent`, and `cookiesFromBrowser` are forwarded to yt-dlp
   *  to bypass bot detection. */
  async function tryParseUrl(
    url: string,
    cookie?: string,
    userAgent?: string,
    cookiesFromBrowser?: string,
  ): Promise<boolean> {
    if (!url.trim()) return false

    isParsing.value = true
    parseError.value = null
    parseResult.value = null
    selectedFormatId.value = ''
    selectedPlaylistItems.value = new Set()
    showAllFormats.value = false

    try {
      const result = await ytdlpApi.parseUrl(url, cookie, userAgent, cookiesFromBrowser)
      parseResult.value = result

      if (result.type === 'Video') {
        selectedFormatId.value = 'bestvideo+bestaudio/best'
        return true
      }
      if (result.type === 'Playlist') {
        const pl = result as unknown as PlaylistInfo
        selectedPlaylistItems.value = new Set(pl.entries.map((_entry: PlaylistItem, i: number) => i))
        return true
      }
      return false
    } catch (err: unknown) {
      // Capture the error so UI can distinguish "real parse failure"
      // (anti-bot, unsupported site, network) from "not a video URL".
      // The aria2 flow can still handle the URL — this is just a hint.
      let raw: string
      if (typeof err === 'object' && err !== null) {
        const e = err as Record<string, unknown>
        if (typeof e.YtdlpParse === 'string') raw = e.YtdlpParse
        else if (typeof e.YtdlpTimeout === 'string' || 'YtdlpTimeout' in e) raw = '解析超时'
        else raw = err instanceof Error ? err.message : String(err)
      } else {
        raw = err instanceof Error ? err.message : String(err)
      }
      parseError.value = raw.trim() || '视频解析失败'
      parseResult.value = { type: 'NotMedia' }
      return false
    } finally {
      isParsing.value = false
    }
  }

  /** Determines whether the selected format needs yt-dlp direct download. */
  function needsDirectDownload(formatId: string): boolean {
    const info = videoInfo.value
    if (!info) return false

    // Composite format IDs like "bestvideo+bestaudio/best" always need yt-dlp
    if (formatId.includes('+') || formatId.includes('/')) return true

    const format = info.formats.find((f: VideoFormat) => f.formatId === formatId)
    if (!format) return true

    return format.protocol !== 'https' && format.protocol !== 'http'
  }

  /** Submits a single video download using the provided aria2 options.
   *  `cookiesFromBrowser` is yt-dlp-only and bypasses pasted cookies. */
  async function submitVideoDownload(options: Record<string, string>, cookiesFromBrowser?: string): Promise<string> {
    const fmtId = selectedFormatId.value
    const info = videoInfo.value
    if (!info) throw new Error('no video info')

    if (needsDirectDownload(fmtId)) {
      const format = info.formats.find((f: VideoFormat) => f.formatId === fmtId)
      // Composite selectors (e.g. "bestvideo+bestaudio/best") merge into mp4
      // by default. For a single-format selection, use that format's ext.
      const ext = format?.ext ?? 'mp4'
      const meta = {
        video_title: info.title,
        extractor: info.extractor,
        thumbnail: info.thumbnail,
        duration: info.duration,
        resolution: format?.resolution,
        filesize: format?.filesize,
        filesizeApprox: format?.filesizeApprox,
        download_mode: 'ytdlp_direct',
      }
      return ytdlpApi.downloadDirect({
        url: info.url,
        formatId: fmtId,
        title: info.title,
        ext,
        meta,
        options,
        cookiesFromBrowser,
      })
    }
    return ytdlpApi.downloadViaAria2({
      url: info.url,
      formatId: fmtId,
      options,
      cookiesFromBrowser,
    })
  }

  /** Resets all video flow state. */
  function reset() {
    isParsing.value = false
    parseResult.value = null
    parseError.value = null
    selectedFormatId.value = ''
    selectedPlaylistItems.value = new Set()
    showAllFormats.value = false
  }

  /** Toggles selection of a playlist item by index. */
  function togglePlaylistItem(index: number) {
    const items = new Set(selectedPlaylistItems.value)
    if (items.has(index)) {
      items.delete(index)
    } else {
      items.add(index)
    }
    selectedPlaylistItems.value = items
  }

  /** Selects or deselects all playlist items. */
  function toggleSelectAll() {
    const pl = playlistInfo.value
    if (!pl) return
    if (selectedPlaylistItems.value.size === pl.entries.length) {
      selectedPlaylistItems.value = new Set()
    } else {
      selectedPlaylistItems.value = new Set(pl.entries.map((_entry: PlaylistItem, i: number) => i))
    }
  }

  return {
    isParsing,
    parseResult,
    parseError,
    selectedFormatId,
    selectedPlaylistItems,
    showAllFormats,
    isVideo,
    isPlaylist,
    isNotMedia,
    videoInfo,
    playlistInfo,
    formatPresets,
    tryParseUrl,
    needsDirectDownload,
    submitVideoDownload,
    reset,
    togglePlaylistItem,
    toggleSelectAll,
  }
}
