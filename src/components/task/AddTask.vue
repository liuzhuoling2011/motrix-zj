<script setup lang="ts">
/** @fileoverview Add task dialog: dual-tab layout (URI / Torrent) with AutoAnimate list transitions. */
import { ref, computed, watch, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE, ENGINE_MAX_CONNECTION_PER_SERVER } from '@shared/constants'
import { detectResource, bytesToSize } from '@shared/utils'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { mergeUriLines, normalizeUriLines, extractDecodedFilename } from '@shared/utils/batchHelpers'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  isGlobalProxyConfigured,
  isGlobalDownloadProxyActive,
} from '@/composables/useAddTaskSubmit'
import { isValidAria2ProxyUrl } from '@/composables/useAdvancedPreference'
import { handleTaskStart } from '@/composables/useTaskNotifyHandlers'
import { isMagnetUri } from '@/composables/useMagnetFlow'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { logger } from '@shared/logger'

import { resolveUnresolvedItems, chooseTorrentFile as chooseTorrentFileImpl } from '@/composables/useAddTaskFileOps'
import { useVideoFlow } from '@/composables/useVideoFlow'
import * as ytdlpApi from '@/api/ytdlp'
import VideoInfoPanel from './VideoInfoPanel.vue'
import PlaylistPanel from './PlaylistPanel.vue'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NIcon,
  NInputGroup,
  NDataTable,
  NTag,
  NEllipsis,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import type { DataTableColumns } from 'naive-ui'
import type { BatchItem } from '@shared/types'
import { FolderOpenOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { vAutoAnimate } from '@formkit/auto-animate'
import AdvancedOptions from './addtask/AdvancedOptions.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
/** Tracks whether the user manually edited the download directory in this session. */
const dirUserModified = ref(false)

const activeTab = ref(ADD_TASK_TYPE.URI)
const showAdvanced = ref(false)
const submitting = ref(false)
const selectedBatchIndex = ref(0)

const videoFlow = useVideoFlow()
const activeMediaParseKeys = new Set<string>()

/** True when the dialog was triggered from the embedded web panel's
 *  download button — drives a simplified UI that hides URL/rename/split/dir
 *  inputs, auto-runs the media parser, and pre-expands the format table. */
const isFromWebPanel = computed(() => appStore.addTaskFromWebPanel)

// ── Cookie-expired banner ─────────────────────────────────────────────────────
const cookieExpired = ref(false)

function checkCookieExpired(err: unknown): void {
  const msg = String(err ?? '').toLowerCase()
  if (/cookies|login|authentication required|unable to extract|sign in to confirm/i.test(msg)) {
    cookieExpired.value = true
  }
}

async function openWebBrowser() {
  try {
    await invoke('toggle_web_panel', {
      open: true,
      width: preferenceStore.config.webPanelWidth,
    })
  } catch {
    /* ignore */
  }
}

// Watch videoFlow.parseError to also catch cookie errors from the parse path
watch(
  () => videoFlow.parseError.value,
  (err) => {
    if (err) checkCookieExpired(err)
  },
)

const form = ref({
  uris: '',
  out: '',
  dir: preferenceStore.config.dir || '',
  split: preferenceStore.config.split || 16,
  userAgent: '',
  authorization: '',
  referer: '',
  cookie: '',
  cookiesFromBrowser: '',
  proxyMode: (isGlobalDownloadProxyActive(preferenceStore.config.proxy) ? 'global' : 'none') as
    | 'none'
    | 'global'
    | 'custom',
  customProxy: '',
})

const lastWebPanelAutoParseKey = ref('')

/**
 * Whether a usable global proxy is configured in Settings → Advanced.
 * Must read through preferenceStore.config (not a cached local) because
 * the store replaces the entire config ref on save, which would break
 * reactivity for any local alias.
 */
const globalProxyAvailable = computed(() => isGlobalProxyConfigured(preferenceStore.config.proxy))

/** The global proxy server address for display in the radio hint. */
const globalProxyServer = computed(() => preferenceStore.config.proxy?.server ?? '')

// Sync proxyMode when the global proxy config changes (e.g. disabled in
// settings, or config loads after component mount).  Without this, a stale
// 'global' mode would leave the proxy-hint visible with no matching radio.
watch(globalProxyAvailable, (available) => {
  if (!available && form.value.proxyMode === 'global') {
    form.value.proxyMode = 'none'
  }
})

// Reset video parse state whenever the URL changes so a stale result from
// a previous URL doesn't linger under the Parse Media button. Skip the
// reset while a parse is in flight — otherwise the explicit auto-parse
// kicked off in the visible-watcher gets its `isParsing` flipped back to
// false here, the parse-media + submit buttons drop their loading state
// mid-flight, and a transient parseError leaks into the UI before the
// first parse finishes.
watch(
  () => form.value.uris,
  () => {
    if (videoFlow.isParsing.value) return
    lastWebPanelAutoParseKey.value = ''
    videoFlow.reset()
  },
)

watch(
  () => appStore.pendingReferer,
  (referer) => {
    if (referer) {
      form.value.referer = referer
    }
  },
)

watch(
  () => appStore.pendingCookie,
  (cookie) => {
    if (cookie) {
      form.value.cookie = cookie
    }
  },
)

// Auto-parse when the dialog opens from the embedded web panel: the URL is
// already known (injected via `add-task-from-web` deep-link flow) and the
// user expects to be looking at format choices immediately.  The full
// format table is pre-expanded so any non-preset option is one click away.
watch(
  () =>
    [
      props.show,
      isFromWebPanel.value,
      form.value.uris,
      form.value.cookie,
      form.value.referer,
      videoFlow.isParsing.value,
    ] as const,
  ([visible, fromPanel, uris, cookie, referer, parsing]) => {
    if (!visible || !fromPanel) return
    const trimmed = uris.trim()
    if (!trimmed) return
    if (parsing || videoFlow.isVideo.value || videoFlow.isPlaylist.value) return
    const parseKey = `${trimmed}\n${cookie}\n${referer}`
    if (parseKey === lastWebPanelAutoParseKey.value) return
    lastWebPanelAutoParseKey.value = parseKey
    videoFlow.showAllFormats.value = true
    void handleParseMedia()
  },
  { immediate: false },
)

/** Explicit user-triggered parse — wired to the "Parse Media" button inside
 *  the advanced options panel. Unlike the previous auto-parse-on-paste,
 *  this only fires when the user clicks, so pasting a plain download URL
 *  never incurs yt-dlp latency. */
async function handleParseMedia() {
  const trimmed = form.value.uris.trim()
  if (!trimmed || trimmed.includes('\n') || !/^https?:\/\//i.test(trimmed)) {
    message.warning(t('task.video-parse-needs-single-url') || '请先填入一个以 http/https 开头的视频链接', {
      closable: true,
    })
    return
  }
  // Reset cookie-expired state on each new parse attempt
  cookieExpired.value = false
  const cookie = form.value.cookie || appStore.pendingCookie
  if (cookie && !form.value.cookie) {
    form.value.cookie = cookie
  }
  const parseKey = [trimmed, cookie, form.value.userAgent, form.value.cookiesFromBrowser, form.value.referer].join('\n')
  if (activeMediaParseKeys.has(parseKey)) return
  activeMediaParseKeys.add(parseKey)
  try {
    await videoFlow.tryParseUrl(
      trimmed,
      cookie,
      form.value.userAgent,
      form.value.cookiesFromBrowser,
      form.value.referer,
    )
  } finally {
    activeMediaParseKeys.delete(parseKey)
  }
}

const maxSplit = ENGINE_MAX_CONNECTION_PER_SERVER

// Real-time tracking: NInputNumber only commits v-model on blur,
// so we capture the native `input` event via bubbling from the inner
// <input> element. The watch covers +/− button clicks (immediate update).
const splitAtLimit = ref(form.value.split > maxSplit)

function onSplitRawInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const val = Number(raw)
  splitAtLimit.value = raw !== '' && !isNaN(val) && val > maxSplit
}

watch(
  () => form.value.split,
  (v) => {
    splitAtLimit.value = v > maxSplit
  },
)

const fileColumns = computed<DataTableColumns>(() => {
  const data = (selectedItem.value?.torrentMeta?.files ?? []) as Array<{ idx: number; length: number; path: string }>
  return [
    { type: 'selection' },
    {
      title: t('task.file-index'),
      key: 'idx',
      width: calcColumnWidth({
        title: t('task.file-index'),
        values: data.map((r) => String(r.idx)),
      }),
    },
    { title: t('task.file-name'), key: 'path', ellipsis: { tooltip: true } },
    {
      title: t('task.file-size'),
      key: 'length',
      width: calcColumnWidth({
        title: t('task.file-size'),
        values: data.map((r) => bytesToSize(r.length)),
        sortable: true,
      }),
      sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => (a.length as number) - (b.length as number),
      render(row: Record<string, unknown>) {
        return bytesToSize(row.length as number)
      },
    },
  ]
})

// ── Computed batch accessors ────────────────────────────────────────

const batch = computed(() => appStore.pendingBatch)
const hasBatch = computed(() => batch.value.length > 0)
const fileItems = computed(() => batch.value.filter((i) => i.kind !== 'uri'))
const selectedItem = computed(() => fileItems.value[selectedBatchIndex.value] || null)

// Sync download dir and split with latest preference every time the dialog
// opens. AddTask is kept mounted (`:show` not `v-if`), so form values would
// otherwise be stale if the user changes defaults in preferences.
watch(
  () => props.show,
  (visible) => {
    if (visible) {
      // When classification is enabled, clear the dir so user sees it's optional;
      // otherwise sync from preferences as usual.
      if (preferenceStore.config.fileCategoryEnabled) {
        form.value.dir = ''
      } else {
        form.value.dir = preferenceStore.config.dir || form.value.dir
      }
      // Sync split from the user's Basic preference value
      form.value.split = preferenceStore.config.split ?? form.value.split
      // Reset the manual-override flag each time the dialog opens
      dirUserModified.value = false

      // Pre-fill referer and cookie from browser extension deep-link.
      // These are extracted by handleDeepLinkUrls() and stored as pending
      // values. Without this, the manual-submit path silently discards
      // them — causing cookie-gated CDNs (Quark, Baidu) to return 412.
      if (appStore.pendingReferer) {
        form.value.referer = appStore.pendingReferer
      }
      if (appStore.pendingCookie) {
        form.value.cookie = appStore.pendingCookie
      }
    }
  },
)

const checkedRowKeys = computed({
  get: () => selectedItem.value?.selectedFileIndices || [],
  set: (keys: number[]) => {
    const item = selectedItem.value
    if (item) item.selectedFileIndices = keys
  },
})

const submitLabel = computed(() => {
  // While the web-panel auto-parse is still running, surface that state on
  // the primary action so users understand why submit has stalled — the
  // small parse-media button by itself is easy to miss.
  if (isFromWebPanel.value && videoFlow.isParsing.value) {
    return '正在解析...'
  }
  const pending = batch.value.filter((i) => i.status === 'pending').length
  const failed = batch.value.filter((i) => i.status === 'failed').length
  const count = pending + failed
  if (count > 1) return `${t('app.submit')} (${count})`
  return t('app.submit')
})

/** Resolves when `videoFlow.isParsing` next transitions to `false`. Used by
 *  the web-panel submit branch to wait for the in-flight auto-parse instead
 *  of starting a duplicate one or treating the URL as not-a-video. */
function waitForParseDone(): Promise<void> {
  if (!videoFlow.isParsing.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(
      () => videoFlow.isParsing.value,
      (parsing) => {
        if (!parsing) {
          stop()
          resolve()
        }
      },
    )
  })
}

/** Whether file classification is currently enabled in preferences. */
const categoryEnabled = computed(() => preferenceStore.config.fileCategoryEnabled)

/** Dynamic label: switches between original 'Save to' and 'Custom Path' based on classification state. */
const dirLabel = computed(() => (categoryEnabled.value ? t('task.task-custom-dir') : t('task.task-dir')))

/** The resolved hint text key: changes based on whether user manually overrode the path. */
const categoryHintKey = computed(() =>
  dirUserModified.value ? 'task.category-hint-overridden' : 'task.category-hint-active',
)

/** Handles user manually editing the dir field. */
function onDirInput(value: string) {
  form.value.dir = value
  // Empty = user hasn't specified a custom path (auto-classification will handle it).
  // Non-empty = explicit user override, classification rules will be skipped.
  dirUserModified.value = value.trim().length > 0
}

// ── Lifecycle ───────────────────────────────────────────────────────

onMounted(async () => {
  if (!form.value.dir) {
    try {
      form.value.dir = await downloadDir()
    } catch (e) {
      logger.debug('AddTask.dir', e)
      form.value.dir = '~/Downloads'
    }
  }
})

// When dialog opens: resolve file items, flush URIs into textarea, auto-select tab
watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    selectedBatchIndex.value = 0

    if (hasBatch.value) {
      // Resolve file-based items
      await localResolveUnresolvedItems()
      // Flush URI batch items into the editable textarea via normalized merge
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        const incomingUris = uriItems.map((i) => i.payload)
        form.value.uris = isFromWebPanel.value ? incomingUris.join('\n') : mergeUriLines(form.value.uris, incomingUris)
        appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
      }
      // Auto-switch to Torrent tab when file items are present
      if (fileItems.value.length > 0) {
        activeTab.value = ADD_TASK_TYPE.TORRENT
      } else {
        activeTab.value = ADD_TASK_TYPE.URI
      }

      // Explicit auto-parse for the web-panel flow. Relying on the
      // multi-source watcher is racy: by the time `form.value.uris`
      // settles, the watcher may already have read the empty value
      // earlier and recorded a `lastWebPanelAutoParseKey` that prevents
      // a re-fire. Calling handleParseMedia here is deterministic — the
      // user sees the parse button enter loading state immediately.
      if (isFromWebPanel.value && form.value.uris.trim() && !form.value.uris.includes('\n')) {
        videoFlow.showAllFormats.value = true
        const parseKey = `${form.value.uris.trim()}\n${form.value.cookie}\n${form.value.referer}`
        if (lastWebPanelAutoParseKey.value !== parseKey) {
          lastWebPanelAutoParseKey.value = parseKey
          void handleParseMedia()
        }
      }
    } else {
      activeTab.value = ADD_TASK_TYPE.URI
      if (isFromWebPanel.value) return
      // No batch — check clipboard for URIs
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = await readText()
        if (text && detectResource(text, preferenceStore.config.clipboard)) {
          form.value.uris = text.trim()
        }
      } catch (e) {
        logger.debug('AddTask.readClipboard', e)
      }
    }
  },
)

// Watch for new batch items added while dialog is already open (drag-drop, deep link)
watch(
  () => batch.value.length,
  async (newLen, oldLen) => {
    if (!props.show || newLen <= oldLen) return
    // Flush any newly added URI items via normalized merge (dedup against existing)
    const uriItems = batch.value.filter((i) => i.kind === 'uri')
    if (uriItems.length > 0) {
      const incomingUris = uriItems.map((i) => i.payload)
      form.value.uris = isFromWebPanel.value ? incomingUris.join('\n') : mergeUriLines(form.value.uris, incomingUris)
      appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
    }
    await localResolveUnresolvedItems()
    // Auto-switch to Torrent tab when file items arrive
    if (fileItems.value.length > 0) {
      activeTab.value = ADD_TASK_TYPE.TORRENT
    }
  },
)

// ── File resolution (delegated to useAddTaskFileOps) ────────────────

async function localResolveUnresolvedItems() {
  await resolveUnresolvedItems(batch.value, t)
}

async function chooseTorrentFile() {
  await chooseTorrentFileImpl({
    t,
    batch,
    fileItems,
    selectedBatchIndex,
    setPendingBatch: (items) => {
      appStore.pendingBatch = items
    },
    showWarning: (msg) => message.warning(msg),
  })
}

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true })
    if (typeof selected === 'string') {
      form.value.dir = selected
      // Only mark as user-override when classification is active
      dirUserModified.value = categoryEnabled.value && selected.trim().length > 0
    }
  } catch (e) {
    logger.debug('AddTask.chooseDirectory', e)
  }
}

function removeBatchItem(item: BatchItem) {
  appStore.pendingBatch = batch.value.filter((i) => i !== item)
  selectedBatchIndex.value = Math.min(selectedBatchIndex.value, Math.max(0, fileItems.value.length - 1))
}

// ── Submit ───────────────────────────────────────────────────────────

function handleClose() {
  emit('close')
  Object.assign(form.value, {
    uris: '',
    out: '',
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    cookiesFromBrowser: '',
    proxyMode: isGlobalDownloadProxyActive(preferenceStore.config.proxy) ? 'global' : 'none',
    customProxy: '',
  })
  submitting.value = false
  selectedBatchIndex.value = 0
  cookieExpired.value = false
  videoFlow.reset()
}

/** Submits the yt-dlp video/playlist branch. Returns true if handled. */
async function submitVideoBranch(
  effectiveForm: typeof form.value & { globalProxyServer: string },
  options: ReturnType<typeof buildEngineOptions>,
): Promise<boolean> {
  if (!videoFlow.isVideo.value && !videoFlow.isPlaylist.value) return false

  // Flatten Aria2EngineOptions to Record<string, string> for yt-dlp bridge
  const videoOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined) continue
    videoOptions[k] = Array.isArray(v) ? v.join('\n') : v
  }
  if (!videoOptions.dir) videoOptions.dir = effectiveForm.dir

  let successCount = 0
  try {
    if (videoFlow.isVideo.value) {
      await videoFlow.submitVideoDownload(videoOptions, form.value.cookiesFromBrowser)
      successCount = 1
    } else if (videoFlow.isPlaylist.value && videoFlow.playlistInfo.value) {
      const pl = videoFlow.playlistInfo.value
      const indices = Array.from(videoFlow.selectedPlaylistItems.value).sort((a, b) => a - b)
      for (const i of indices) {
        const entry = pl.entries[i]
        if (!entry) continue
        try {
          await ytdlpApi.downloadDirect({
            url: entry.url,
            formatId: videoFlow.selectedFormatId.value || 'bestvideo+bestaudio/best',
            title: entry.title || entry.url,
            ext: 'mp4',
            meta: {
              video_title: entry.title,
              thumbnail: entry.thumbnail,
              duration: entry.duration,
              playlist_title: pl.title,
              download_mode: 'ytdlp_direct',
            },
            options: videoOptions,
            cookiesFromBrowser: form.value.cookiesFromBrowser,
          })
          successCount += 1
        } catch (err) {
          logger.error('AddTask.playlistItemDownload', { title: entry.title, err })
        }
      }
    }
    await taskStore.fetchList()
    if (successCount > 0) {
      const msg =
        successCount === 1 ? '任务已添加成功，请稍后查看下载进度' : `已添加 ${successCount} 个任务，请稍后查看下载进度`
      message.success(msg, { closable: true })
    }
    handleClose()
    if (preferenceStore.config.newTaskShowDownloading !== false) {
      router.push({ path: '/task/all' }).catch(() => {})
    }
    return true
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error('AddTask.videoSubmit', err)
    checkCookieExpired(errMsg)
    message.error(errMsg, { closable: true })
    submitting.value = false
    return true
  }
}

/** Submits normal aria2 batch/URI branch and shows notifications. */
async function submitNormalBranch(
  effectiveForm: typeof form.value & { globalProxyServer: string },
  options: ReturnType<typeof buildEngineOptions>,
) {
  let manualResult = { magnetGids: [] as string[], magnetFailures: [] as { uri: string; error: string }[] }

  if (hasBatch.value) {
    await submitBatchItems(batch.value, options, taskStore)
  }
  if (form.value.uris.trim()) {
    const shouldClassify = preferenceStore.config.fileCategoryEnabled && !dirUserModified.value
    manualResult = await submitManualUris(effectiveForm, options, taskStore, {
      enabled: shouldClassify,
      categories: preferenceStore.config.fileCategories,
    })
  }

  const failedCount = batch.value.filter((i) => i.status === 'failed').length + manualResult.magnetFailures.length
  if (failedCount > 0) {
    message.warning(`${failedCount} ${t('task.failed') || 'failed'}`, { closable: true })
    return
  }

  // Collect task names BEFORE handleClose clears form state
  const taskNames: string[] = []
  for (const item of batch.value) {
    if (item.status === 'submitted') taskNames.push(item.displayName)
  }
  for (const uri of normalizeUriLines(form.value.uris)) {
    if (!isMagnetUri(uri)) taskNames.push(extractDecodedFilename(uri) || uri)
  }
  for (let i = 0; i < manualResult.magnetGids.length; i++) {
    taskNames.push('Magnet Download')
  }

  handleClose()
  handleTaskStart(taskNames, {
    messageInfo: message.info,
    t,
    taskNotification: preferenceStore.config.taskNotification !== false,
    notifyOnStart: preferenceStore.config.notifyOnStart === true,
  })
  if (preferenceStore.config.newTaskShowDownloading !== false) {
    router.push({ path: '/task/all' }).catch(() => {})
  }
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true
  cookieExpired.value = false

  try {
    if (form.value.proxyMode === 'custom' && form.value.customProxy) {
      if (!isValidAria2ProxyUrl(form.value.customProxy)) {
        message.error(t('task.proxy-unsupported-protocol'), { closable: true })
        submitting.value = false
        return
      }
    }

    const effectiveForm = {
      ...form.value,
      dir: form.value.dir.trim() || preferenceStore.config.dir,
      globalProxyServer: globalProxyServer.value,
    }
    const options = buildEngineOptions(effectiveForm)

    const handled = await submitVideoBranch(effectiveForm, options)
    if (handled) return

    if (isFromWebPanel.value) {
      // Wait for the auto-parse to finish (or kick one off if it never
      // started) before deciding whether this is a video URL. Without
      // the wait, an in-flight parse leaves isVideo/isPlaylist false and
      // submit would prematurely report "video parse failed".
      if (videoFlow.isParsing.value) {
        await waitForParseDone()
      } else if (!videoFlow.isVideo.value && !videoFlow.isPlaylist.value) {
        await handleParseMedia()
      }
      const handledAfterParse = await submitVideoBranch(effectiveForm, options)
      if (handledAfterParse) return
      message.error(videoFlow.parseError.value || '视频解析失败，未创建普通下载任务', { closable: true })
      submitting.value = false
      return
    }

    await submitNormalBranch(effectiveForm, options)
  } catch (e: unknown) {
    const category = classifySubmitError(e)
    const errMsg = e instanceof Error ? e.message : String(e)
    logger.error('AddTask.submit', e)
    if (category === 'engine-not-ready') {
      message.error(t('app.engine-not-ready'), { closable: true })
    } else if (category === 'duplicate') {
      message.warning(errMsg, { closable: true })
    } else {
      message.error(errMsg, { closable: true })
    }
  } finally {
    submitting.value = false
  }
}

function kindTagType(kind: string): 'info' | 'success' | 'warning' {
  switch (kind) {
    case 'torrent':
      return 'info'
    case 'metalink':
      return 'success'
    default:
      return 'warning'
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="false"
    :close-on-esc="true"
    :auto-focus="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NCard
      :title="t('task.new-task')"
      closable
      class="add-task-card"
      :style="{
        maxWidth: '680px',
        minWidth: '380px',
        width: '70vw',
        margin: 'auto',
        height: '82vh',
        display: 'flex',
        flexDirection: 'column',
      }"
      :content-style="{ flex: '1', minHeight: '0', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
      @close="handleClose"
    >
      <NForm label-placement="left" label-width="110px">
        <NTabs
          v-if="!isFromWebPanel"
          :value="activeTab"
          type="line"
          animated
          @update:value="(v: string) => (activeTab = v)"
        >
          <!-- ── URI Tab ──────────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.URI" :tab="t('task.uri-task') || 'URL'">
            <div class="tab-pane-content">
              <NFormItem :show-label="false" style="margin-bottom: 0">
                <NInput
                  v-model:value="form.uris"
                  type="textarea"
                  :rows="5"
                  :placeholder="t('task.uri-task-tips') || 'One URL per line'"
                />
              </NFormItem>
            </div>
          </NTabPane>

          <!-- ── Torrent Tab ─────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.TORRENT" :tab="t('task.torrent-task') || 'Torrent'">
            <div v-auto-animate="{ duration: 200, easing: 'ease-out' }" class="tab-pane-content">
              <!-- Torrent panel: animated batch list + file detail -->
              <div v-if="fileItems.length > 0" class="torrent-panel">
                <!-- Batch list with AutoAnimate transitions -->
                <div v-auto-animate="{ duration: 200, easing: 'ease-out' }" class="batch-list">
                  <div
                    v-for="(item, idx) in fileItems"
                    :key="item.id"
                    class="batch-item"
                    :class="{ 'batch-item-selected': idx === selectedBatchIndex }"
                    @click="selectedBatchIndex = idx"
                  >
                    <div class="batch-item-main">
                      <NEllipsis :style="{ maxWidth: '400px', flex: 1 }">{{ item.displayName }}</NEllipsis>
                      <NSpace :size="4" align="center" :wrap="false">
                        <NTag :type="kindTagType(item.kind)" size="small" :bordered="false">
                          {{ item.kind === 'metalink' ? 'Metalink' : 'Torrent' }}
                        </NTag>
                        <NButton quaternary size="tiny" @click.stop="removeBatchItem(item)">✕</NButton>
                      </NSpace>
                    </div>
                  </div>
                </div>

                <!-- Add more files button -->
                <NButton size="small" dashed block style="margin-top: 6px" @click="chooseTorrentFile">
                  <template #icon>
                    <NIcon><CloudUploadOutline /></NIcon>
                  </template>
                  {{ t('task.select-torrent') || 'Select torrent files' }}
                </NButton>

                <!-- File detail for selected torrent -->
                <Transition name="content-fade" mode="out-in">
                  <div
                    v-if="selectedItem?.torrentMeta && selectedItem.torrentMeta.files.length > 0"
                    :key="selectedItem?.id"
                    class="torrent-file-list"
                  >
                    <NDataTable
                      v-model:checked-row-keys="checkedRowKeys"
                      :columns="fileColumns"
                      :data="selectedItem.torrentMeta.files"
                      :row-key="(row: any) => row.idx as number"
                      size="small"
                      :max-height="200"
                      :scroll-x="400"
                    />
                  </div>
                </Transition>
              </div>

              <!-- Upload zone: shown when no torrents loaded -->
              <div v-if="fileItems.length === 0" class="torrent-upload-zone" @click="chooseTorrentFile">
                <NIcon :size="36" :depth="3"><CloudUploadOutline /></NIcon>
                <span class="torrent-upload-text">
                  {{ t('task.select-torrent') || 'Drag torrent here or click to select' }}
                </span>
              </div>
            </div>
          </NTabPane>
        </NTabs>

        <!-- ── Download settings: hidden when triggered from web panel
             (URL is injected, defaults are fine, user just wants formats) -->
        <div v-if="isFromWebPanel" class="web-panel-url-section">
          <NFormItem :label="t('task.uri-task') + ':'">
            <NInput
              v-model:value="form.uris"
              type="textarea"
              :rows="3"
              :placeholder="t('task.uri-task-tips') || 'One URL per line'"
            />
          </NFormItem>
        </div>

        <div class="download-settings">
          <NFormItem v-if="!isFromWebPanel" :label="t('task.task-out') + ':'">
            <NInput v-model:value="form.out" :placeholder="t('task.task-out-tips')" :autofocus="false" />
          </NFormItem>
          <NFormItem v-if="!isFromWebPanel" :label="t('preferences.split-count') + ':'">
            <div class="split-field-wrapper" @input="onSplitRawInput">
              <NInputNumber v-model:value="form.split" :min="1" :max="maxSplit" style="width: 120px" />
              <!-- Limit hint — CSS Grid 0fr→1fr slide-in, mirrors ua-warn pattern -->
              <div class="split-limit-collapse" :class="{ 'split-limit-collapse--open': splitAtLimit }">
                <div class="split-limit-collapse__inner">
                  <div class="split-limit-bar">
                    <span class="split-limit-text">⚠ {{ t('task.split-limit-hint') }}</span>
                  </div>
                </div>
              </div>
            </div>
          </NFormItem>
          <NFormItem :label="dirLabel + ':'">
            <div style="width: 100%">
              <NInputGroup>
                <NInput
                  :value="form.dir"
                  style="flex: 1"
                  :placeholder="categoryEnabled ? t('task.category-dir-placeholder') : ''"
                  @update:value="onDirInput"
                />
                <NButton @click="chooseDirectory">
                  <template #icon>
                    <NIcon><FolderOpenOutline /></NIcon>
                  </template>
                </NButton>
              </NInputGroup>
              <Transition name="category-hint" mode="out-in">
                <div v-if="categoryEnabled" :key="categoryHintKey" class="category-hint-text">
                  ⓘ {{ t(categoryHintKey) }}
                </div>
              </Transition>
            </div>
          </NFormItem>
          <AdvancedOptions
            v-if="!isFromWebPanel"
            v-model:show="showAdvanced"
            v-model:user-agent="form.userAgent"
            v-model:authorization="form.authorization"
            v-model:referer="form.referer"
            v-model:cookie="form.cookie"
            v-model:cookies-from-browser="form.cookiesFromBrowser"
            v-model:proxy-mode="form.proxyMode"
            v-model:custom-proxy="form.customProxy"
            :global-proxy-available="globalProxyAvailable"
            :global-proxy-server="globalProxyServer"
          />
        </div>

        <!-- ── Media parser ────────────────────────────────────────────
             Shown when the user expands advanced options, OR automatically
             when the dialog was opened from the embedded web panel (in
             which case the parse also runs on open). -->
        <div v-if="showAdvanced || isFromWebPanel" class="media-parse-section">
          <NButton
            size="small"
            :loading="videoFlow.isParsing.value"
            :disabled="videoFlow.isParsing.value"
            @click="handleParseMedia"
          >
            {{ videoFlow.isParsing.value ? '正在解析...' : '解析媒体' }}
          </NButton>

          <div
            v-if="
              !videoFlow.isParsing.value &&
              videoFlow.parseError.value &&
              !videoFlow.isVideo.value &&
              !videoFlow.isPlaylist.value
            "
            class="video-error"
          >
            视频解析失败：{{ videoFlow.parseError.value }}。将按普通链接处理。
          </div>

          <div v-if="cookieExpired" class="cookie-expired-banner">
            <span>登录可能已过期，请重新打开浏览器登录：</span>
            <button type="button" class="link-btn" @click="openWebBrowser">打开浏览器</button>
          </div>

          <VideoInfoPanel
            v-if="videoFlow.isVideo.value && videoFlow.videoInfo.value"
            :video="videoFlow.videoInfo.value"
            :presets="videoFlow.formatPresets.value"
            :selected-format-id="videoFlow.selectedFormatId.value"
            :show-all-formats="videoFlow.showAllFormats.value"
            @update:selected-format-id="(id: string) => (videoFlow.selectedFormatId.value = id)"
            @update:show-all-formats="(show: boolean) => (videoFlow.showAllFormats.value = show)"
          />

          <PlaylistPanel
            v-if="videoFlow.isPlaylist.value && videoFlow.playlistInfo.value"
            :playlist="videoFlow.playlistInfo.value"
            :selected-items="videoFlow.selectedPlaylistItems.value"
            :presets="videoFlow.formatPresets.value"
            :selected-format-id="videoFlow.selectedFormatId.value"
            @toggle-item="videoFlow.togglePlaylistItem"
            @toggle-select-all="videoFlow.toggleSelectAll"
            @update:selected-format-id="(id: string) => (videoFlow.selectedFormatId.value = id)"
          />
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton
            data-testid="submit-button"
            type="primary"
            :loading="submitting || (isFromWebPanel && videoFlow.isParsing.value)"
            :disabled="isFromWebPanel && videoFlow.isParsing.value"
            @click="handleSubmit"
          >
            {{ submitLabel }}
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.torrent-file-list {
  margin-top: 8px;
}

/* Fixed-height tab panes prevent jitter when switching tabs.
 * URI textarea rows=5 ≈ 138px — keep both panes at same min-height. */
.tab-pane-content {
  min-height: 150px;
}

/* ── Torrent panel ────────────────────────────────────────────────── */
.torrent-panel {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  background: var(--n-color, var(--m3-surface-container-low));
}

/* ── Batch list ───────────────────────────────────────────────────── */
.batch-list {
  border-radius: 6px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  overflow: hidden;
}

/* ── Upload zone (when no torrents) ───────────────────────────────── */
.torrent-upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 138px;
  border: 1px dashed var(--m3-drop-zone-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.torrent-upload-zone:hover {
  border-color: var(--color-primary);
}
.torrent-upload-text {
  font-size: 13px;
  opacity: 0.6;
}

/* ── Download settings ────────────────────────────────────────────── */
.download-settings {
  margin-top: 4px;
}

/* ── Split limit hint — CSS Grid 0fr→1fr slide-in (mirrors ua-warn) ─── */
.split-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.split-limit-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.split-limit-collapse--open {
  grid-template-rows: 1fr;
}
.split-limit-collapse__inner {
  overflow: hidden;
}
.split-limit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container-bg);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.split-limit-collapse--open .split-limit-bar {
  opacity: 1;
}
.split-limit-text {
  font-size: var(--font-size-sm);
  color: var(--m3-error);
  flex: 1;
}

/* ── Media parser (manual trigger inside advanced options) ────────── */
.media-parse-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--n-border-color, rgba(128, 128, 128, 0.2));
}
.video-error {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--n-warning-color-suppl, #fcf3cf);
  color: var(--n-warning-color, #f0a020);
  font-size: 12px;
  line-height: 1.5;
}

/* ── Cookie-expired warning banner ───────────────────────────────── */
.cookie-expired-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin: 4px 0;
  border: 1px solid var(--m3-warning-border, #fde68a);
  background: var(--m3-warning-bg, #fef3c7);
  border-radius: 6px;
  color: var(--m3-warning-text, #92400e);
  font-size: 13px;
  line-height: 1.5;
}
.link-btn {
  background: none;
  border: none;
  color: var(--color-primary, #15803d);
  cursor: pointer;
  font-weight: 600;
  padding: 0;
  text-decoration: underline;
  font-size: 13px;
}
.link-btn:hover {
  color: var(--color-primary-hover, #166534);
}
</style>

<!-- Non-scoped: Vue Transition classes must NOT be scoped -->
<style>
/* ── Batch item base styles ───────────────────────────────────────── */
.batch-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.batch-item:hover {
  background: var(--n-color-hover, var(--m3-surface-container-high));
}
.batch-item-selected {
  background: var(--n-color-hover, var(--m3-surface-container-highest));
}
.batch-item + .batch-item {
  border-top: 1px solid var(--n-border-color, var(--m3-outline-variant));
}
.batch-item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* ── Content crossfade (file detail switching) ────────────────────── */
.content-fade-enter-active {
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.content-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.content-fade-enter-from,
.content-fade-leave-to {
  opacity: 0;
}

/* ── Category hint below dir field ────────────────────────────────── */
.category-hint-text {
  font-size: var(--font-size-sm, 12px);
  color: var(--n-text-color-3, #999);
  margin-top: 4px;
  padding-left: 2px;
}
.category-hint-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.category-hint-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.category-hint-enter-from,
.category-hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
