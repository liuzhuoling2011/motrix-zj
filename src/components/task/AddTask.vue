<script setup lang="ts">
/** @fileoverview Add task dialog: dual-tab layout (URI / Torrent) with AutoAnimate list transitions. */
import { ref, computed, watch, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useHttpAuthStore } from '@/stores/httpAuth'
import { ADD_TASK_TYPE, ENGINE_MAX_CONNECTION_PER_SERVER } from '@shared/constants'
import { detectResource, bytesToSize } from '@shared/utils'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { mergeRawUriLines, normalizeUriLines, extractMagnetDisplayName } from '@shared/utils/batchHelpers'
import { resolveDownloadCategory } from '@shared/utils/fileCategory'
import { buildOuts } from '@shared/utils/rename'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  getDownloadProxy,
} from '@/composables/useAddTaskSubmit'
import type { AddTaskForm, ManualUriSubmitResult } from '@/composables/useAddTaskSubmit'
import { isValidAria2ProxyUrl } from '@shared/utils/proxy'
import { handleTaskStart } from '@/composables/useTaskNotifyHandlers'
import { isMagnetUri } from '@/composables/useMagnetFlow'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import {
  getDefaultTaskProxyMode,
  getDefaultTaskProxyPassword,
  getDefaultTaskProxyServer,
  getDefaultTaskProxyUsername,
} from '@shared/utils/proxy'
import { resolveUserVisibleDownloadDir } from '@shared/utils/userVisibleDirectory'
import { findMatchingUserAgentRule, resolveUserAgent } from '@shared/utils/userAgentPolicy'

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
import type { BatchItem, UserAgentProfile } from '@shared/types'
import { FolderOpenOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { vAutoAnimate } from '@formkit/auto-animate'
import AdvancedOptions from './addtask/AdvancedOptions.vue'
import DirectoryPopover from '@/components/common/DirectoryPopover.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const httpAuthStore = useHttpAuthStore()
const message = useAppMessage()
/** Tracks whether the user manually edited the download directory in this session. */
const dirUserModified = ref(false)

const activeTab = ref(ADD_TASK_TYPE.URI)
const tabsRef = ref<InstanceType<typeof import('naive-ui').NTabs> | null>(null)

/**
 * Switch tab programmatically with correct animation direction.
 *
 * NTabs only computes `animationDirection` inside its internal `activateTab()`
 * handler (user clicks).  Programmatic `:value` changes skip that and always
 * default to `'next'`.  This helper mirrors the direction logic from the NTabs
 * source and sets it on the component instance before updating `activeTab`.
 */
const TAB_ORDER = [ADD_TASK_TYPE.URI, ADD_TASK_TYPE.TORRENT] as const
function switchTab(target: string): void {
  if (activeTab.value === target) return
  const inst = tabsRef.value as Record<string, unknown> | null
  if (inst && 'animationDirection' in inst) {
    const curIdx = TAB_ORDER.indexOf(activeTab.value as (typeof TAB_ORDER)[number])
    const tgtIdx = TAB_ORDER.indexOf(target as (typeof TAB_ORDER)[number])
    ;(inst as { animationDirection: string }).animationDirection = tgtIdx > curIdx ? 'next' : 'prev'
  }
  activeTab.value = target
}
const showAdvanced = ref(false)
const submitting = ref(false)
const selectedBatchIndex = ref(0)
const userAgentManuallyEdited = ref(false)
const defaultTaskProxyMode = () => getDefaultTaskProxyMode(preferenceStore.config.proxy)
const defaultTaskProxyServer = () => getDefaultTaskProxyServer(preferenceStore.config.proxy)
const defaultTaskProxyUsername = () => getDefaultTaskProxyUsername(preferenceStore.config.proxy)
const defaultTaskProxyPassword = () => getDefaultTaskProxyPassword(preferenceStore.config.proxy)

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

function syncDefaultTaskProxy() {
  form.value.proxyMode = defaultTaskProxyMode()
  form.value.customProxy = defaultTaskProxyServer()
  form.value.customProxyUsername = defaultTaskProxyUsername()
  form.value.customProxyPassword = defaultTaskProxyPassword()
  form.value.appProxy = preferenceStore.config.proxy
}

function syncPendingExternalMetadata() {
  form.value.referer = appStore.pendingReferer
  form.value.cookie = appStore.pendingCookie
  form.value.out = appStore.pendingFilename
  form.value.userAgent = appStore.pendingUserAgent
  form.value.requestHeaders = appStore.pendingRequestHeaders
  applyResolvedUserAgent()
}

const form = ref<AddTaskForm>({
  uris: '',
  out: '',
  dir: preferenceStore.config.dir || '',
  split: preferenceStore.config.split || 16,
  userAgent: '',
  authorization: '',
  httpAuthUsername: '',
  httpAuthPassword: '',
  saveHttpAuth: true,
  referer: '',
  cookie: '',
  cookiesFromBrowser: '',
  proxyMode: defaultTaskProxyMode(),
  customProxy: defaultTaskProxyServer(),
  customProxyUsername: defaultTaskProxyUsername(),
  customProxyPassword: defaultTaskProxyPassword(),
  appProxy: preferenceStore.config.proxy,
  requestHeaders: [],
  uriRequestContexts: {},
})

const lastWebPanelAutoParseKey = ref('')

// Reset video parse state whenever the URL changes so a stale result from
// a previous URL doesn't linger under the Parse Media button.
//
// Skip while a parse is in flight: the synchronous web-panel kickoff sets
// `form.value.uris` and calls `handleParseMedia` in the same tick, and Vue
// flushes this watcher *after* `tryParseUrl` has already flipped
// `isParsing=true`. Without this guard, `videoFlow.reset()` clears
// `isParsing` back to false and the first render of the dialog still
// shows the parse-media + submit buttons in their idle state.
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

/** Resolves once the in-flight yt-dlp parse finishes (either success or
 *  error). Used by handleSubmit so the user can click "提交" while the
 *  auto-parse is still running and have the request queued instead of
 *  failing immediately with "解析失败". */
function waitForParseComplete(): Promise<void> {
  if (!videoFlow.isParsing.value) return Promise.resolve()
  return new Promise<void>((resolve) => {
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

const maxSplit = ENGINE_MAX_CONNECTION_PER_SERVER
const firstRegularUri = computed(
  () =>
    form.value.uris
      .split(/\r?\n/)
      .map((uri) => uri.trim())
      .find((uri) => uri && !isMagnetUri(uri)) ?? '',
)
const matchedUserAgentRule = computed(() =>
  findMatchingUserAgentRule({
    url: firstRegularUri.value,
    referer: form.value.referer,
    profiles: preferenceStore.config.userAgentProfiles,
    rules: preferenceStore.config.userAgentRules,
  }),
)
const userAgentSourceText = computed(() => {
  if (userAgentManuallyEdited.value) return t('task.ua-source-manual')
  const match = matchedUserAgentRule.value
  if (match && form.value.userAgent === match.profile.value)
    return t('task.ua-source-rule', { host: match.rule.hostPattern })
  if (appStore.pendingUserAgent && form.value.userAgent === appStore.pendingUserAgent)
    return t('task.ua-source-extension')
  return ''
})

function applyResolvedUserAgent() {
  if (userAgentManuallyEdited.value) return
  const resolved = resolveUserAgent({
    manualUserAgent: '',
    pluginUserAgent: appStore.pendingUserAgent,
    defaultUserAgent: preferenceStore.config.userAgent,
    url: firstRegularUri.value,
    referer: form.value.referer,
    profiles: preferenceStore.config.userAgentProfiles,
    rules: preferenceStore.config.userAgentRules,
  })
  form.value.userAgent = resolved.userAgent
}

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
//
// This is the SYNCHRONOUS entry point on dialog open. For the from-web-panel
// flow it ALSO flushes the URI from the pending batch and fires the auto
// parse here — `tryParseUrl` sets `isParsing=true` synchronously, so Vue's
// first paint of the dialog already shows the parse-media + submit buttons
// in their loading state. Doing it from the async watcher below leaves a
// frame where everything looks idle and users perceive "no loading".
watch(
  () => props.show,
  (visible) => {
    if (!visible) return

    // When classification is enabled, clear the dir so user sees it's optional;
    // otherwise sync from preferences as usual.
    if (preferenceStore.config.fileCategoryEnabled) {
      form.value.dir = ''
    } else {
      form.value.dir = preferenceStore.config.dir || form.value.dir
    }
    form.value.split = preferenceStore.config.split ?? form.value.split
    syncDefaultTaskProxy()
    dirUserModified.value = false
    syncPendingExternalMetadata()

    if (isFromWebPanel.value && hasBatch.value) {
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        const incomingUris = uriItems.map((i) => i.payload)
        form.value.uris = incomingUris.join('\n')
        form.value.uriRequestContexts = Object.fromEntries(
          uriItems.flatMap((item) => (item.browserContext ? [[item.payload, item.browserContext]] : [])),
        )
        appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
        switchTab(ADD_TASK_TYPE.URI)

        const trimmed = form.value.uris.trim()
        if (trimmed && !trimmed.includes('\n') && /^https?:\/\//i.test(trimmed)) {
          videoFlow.showAllFormats.value = true
          // Pre-stamp the dedup key so the multi-source auto-parse-watch
          // (which fires later for the same URL+cookie+referer combo) does
          // not start a duplicate parse on top of this synchronous one.
          const parseKey = `${trimmed}\n${form.value.cookie}\n${form.value.referer}`
          lastWebPanelAutoParseKey.value = parseKey
          appStore.pendingParseVideo = false
          void handleParseMedia()
        }
      }
    }
  },
)

watch(
  () => preferenceStore.config.proxy,
  () => {
    if (props.show) syncDefaultTaskProxy()
  },
  { deep: true },
)

watch(
  [
    firstRegularUri,
    () => form.value.referer,
    () => preferenceStore.config.userAgent,
    () => preferenceStore.config.userAgentProfiles,
    () => preferenceStore.config.userAgentRules,
  ],
  () => {
    if (props.show) applyResolvedUserAgent()
  },
  { deep: true },
)

const checkedRowKeys = computed({
  get: () => selectedItem.value?.selectedFileIndices || [],
  set: (keys: number[]) => {
    const item = selectedItem.value
    if (item) item.selectedFileIndices = keys
  },
})

const submitLabel = computed(() => {
  // Surface the in-flight web-panel parse on the primary action so users
  // see why the submit button is stuck in loading. The dedicated parse
  // button is small and easy to miss.
  if (isFromWebPanel.value && videoFlow.isParsing.value) return '正在解析...'
  const pending = batch.value.filter((i) => i.status === 'pending').length
  const failed = batch.value.filter((i) => i.status === 'failed').length
  const count = pending + failed
  if (count > 1) return `${t('app.submit')} (${count})`
  return t('app.submit')
})

/** Whether file classification is currently enabled in preferences. */
const categoryEnabled = computed(() => preferenceStore.config.fileCategoryEnabled)

/** Dynamic label: switches between original 'Save to' and 'Custom Path' based on classification state. */
const dirLabel = computed(() => (categoryEnabled.value ? t('task.task-custom-dir') : t('task.task-dir')))

function resolveCategoryMatches(): Map<string, { label: string; directory: string }> {
  const uris = normalizeUriLines(form.value.uris).filter((uri) => !isMagnetUri(uri))
  const outs = uris.length > 1 && form.value.out ? buildOuts(uris, form.value.out) : []
  const matched = new Map<string, { label: string; directory: string }>()

  for (const [index, uri] of uris.entries()) {
    const context = form.value.uriRequestContexts?.[uri]
    const category = resolveDownloadCategory(
      outs[index] || form.value.out || uri,
      preferenceStore.config.fileCategories,
      {
        urls: [uri, context?.finalUrl ?? '', context?.url ?? '', context?.referer ?? ''],
      },
    )
    if (!category) continue
    const label = category.builtIn ? t(`preferences.${category.label}`) : category.label
    matched.set(category.directory, { label, directory: category.directory })
  }

  return matched
}

const categoryMatches = computed(() => {
  if (!categoryEnabled.value || dirUserModified.value) return new Map<string, { label: string; directory: string }>()
  return resolveCategoryMatches()
})

const categoryMatchPreview = computed(() => {
  const matched = categoryMatches.value
  if (matched.size !== 1) return undefined
  return matched.values().next().value
})

const displayedDir = computed(() => {
  if (dirUserModified.value) return form.value.dir
  return categoryMatchPreview.value?.directory ?? form.value.dir
})

const categoryPreviewText = computed(() => {
  if (!categoryEnabled.value) return ''
  if (dirUserModified.value) return t('task.category-hint-overridden')

  const uris = normalizeUriLines(form.value.uris).filter((uri) => !isMagnetUri(uri))
  if (uris.length === 0) return t('task.category-hint-active')

  const matched = categoryMatchPreview.value
  if (matched) return t('task.category-match-single', { category: matched.label })

  const matchedSize = categoryMatches.value.size
  if (matchedSize === 0) return t('task.category-match-none')
  if (matchedSize > 1) return t('task.category-match-multiple')
  return t('task.category-match-none')
})

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
      const resolvedDir = await resolveUserVisibleDownloadDir({ configuredDir: preferenceStore.config.dir })
      form.value.dir = resolvedDir.path
      logger.info('AddTask.dir', `resolved source=${resolvedDir.source} fallback=${resolvedDir.usedFallback}`)
    } catch (e) {
      logger.debug('AddTask.dir', e)
      form.value.dir = '~/Downloads'
    }
  }
})

// When dialog opens: resolve file items, flush URIs into textarea, auto-select tab.
//
// The from-web-panel branch is handled by the synchronous visible-watcher
// above so the loading state is visible from the first render. This async
// watcher only deals with the slow paths: torrent/metalink byte loading
// and the no-batch clipboard probe.
// Race-condition guard: the batch.length watcher may fire and drain pendingBatch
// BEFORE this async watcher finishes its clipboard read.  A simple `hasBatch`
// re-check fails because the batch is already empty by that point.  Instead we
// use a flag that the batch.length watcher sets synchronously whenever it writes
// to form.uris — the flag survives the drain and is visible after the await.
let batchDidWrite = false

watch(
  () => props.show,
  async (visible) => {
    if (!visible) {
      batchDidWrite = false
      return
    }
    selectedBatchIndex.value = 0

    if (hasBatch.value) {
      // Resolve file-based items (torrent/metalink bytes → base64).
      await localResolveUnresolvedItems()
      // Flush URI batch items into the editable textarea via normalized merge
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        form.value.uris = mergeRawUriLines(
          form.value.uris,
          uriItems.map((i) => i.payload),
        )
        form.value.uriRequestContexts = Object.fromEntries(
          uriItems.flatMap((i) => (i.browserContext ? [[i.payload, i.browserContext]] : [])),
        )
        appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
      }
      // Auto-switch to Torrent tab when file items are present
      if (fileItems.value.length > 0) {
        switchTab(ADD_TASK_TYPE.TORRENT)
      } else {
        switchTab(ADD_TASK_TYPE.URI)
      }
    } else {
      // Only reset tab if batchWatcher hasn't already handled a programmatic
      // switch — otherwise we'd cause a rapid URI→TORRENT bounce that
      // confuses NTabs' animation direction.
      if (!batchDidWrite) switchTab(ADD_TASK_TYPE.URI)
      if (isFromWebPanel.value) return
      // No batch — check clipboard for URIs
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = await readText()
        // Re-check: a deep-link/extension batch may have arrived and been
        // processed (and drained) during the async readText() gap.
        // `hasBatch` is unreliable here because batchWatcher drains
        // pendingBatch after writing — use the flag instead.
        if (batchDidWrite) return
        if (text && detectResource(text, preferenceStore.config.clipboard)) {
          form.value.uris = text.trim()
        }
      } catch (e) {
        logger.debug('AddTask.readClipboard', e)
      }
    }
  },
)

// Watch for new batch items added while dialog is already open (drag-drop, deep link).
// Replace (not merge) the textarea — batch content takes priority over any clipboard
// auto-fill that the show watcher may have already written.
watch(
  () => batch.value.length,
  async (newLen, oldLen) => {
    if (!props.show || newLen <= oldLen) return
    // Snapshot newly arrived items before any drain/resolve mutates the batch.
    const newlyArrived = batch.value.slice(oldLen)
    const uriItems = batch.value.filter((i) => i.kind === 'uri')
    if (uriItems.length > 0) {
      batchDidWrite = true
      form.value.uris = mergeRawUriLines(
        '',
        uriItems.map((i) => i.payload),
      )
      form.value.uriRequestContexts = Object.fromEntries(
        uriItems.flatMap((i) => (i.browserContext ? [[i.payload, i.browserContext]] : [])),
      )
      syncPendingExternalMetadata()
      appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
    }
    // Auto-switch tab SYNCHRONOUSLY (before any await) so NTabs computes
    // the correct slide direction in the same render tick.
    const hasNewFiles = newlyArrived.some((i) => i.kind !== 'uri')
    const hasNewUris = newlyArrived.some((i) => i.kind === 'uri')
    if (hasNewFiles) {
      switchTab(ADD_TASK_TYPE.TORRENT)
    } else if (hasNewUris) {
      switchTab(ADD_TASK_TYPE.URI)
    }
    // Resolve file metadata asynchronously (doesn't affect tab choice).
    await localResolveUnresolvedItems()
  },
)

// ── File resolution (delegated to useAddTaskFileOps) ────────────────

async function localResolveUnresolvedItems() {
  await resolveUnresolvedItems(batch.value, t, getDownloadProxy(preferenceStore.config.proxy))
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

function onDirectorySelect(dir: string) {
  form.value.dir = dir
  dirUserModified.value = categoryEnabled.value && dir.trim().length > 0
}

function onUserAgentInput(value: string) {
  userAgentManuallyEdited.value = true
  form.value.userAgent = value
}

function selectUserAgentProfile(profile: UserAgentProfile) {
  userAgentManuallyEdited.value = true
  form.value.userAgent = profile.value
  preferenceStore.recordRecentUserAgentProfile(profile.id)
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
    httpAuthUsername: '',
    httpAuthPassword: '',
    saveHttpAuth: true,
    referer: '',
    cookie: '',
    cookiesFromBrowser: '',
    customProxyUsername: '',
    customProxyPassword: '',
    requestHeaders: [],
    uriRequestContexts: {},
  })
  syncDefaultTaskProxy()
  userAgentManuallyEdited.value = false
  submitting.value = false
  selectedBatchIndex.value = 0
  cookieExpired.value = false
  videoFlow.reset()
}

/** Submits the yt-dlp video/playlist branch. Returns true if handled. */
async function submitVideoBranch(
  effectiveForm: AddTaskForm,
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
  effectiveForm: AddTaskForm,
  options: ReturnType<typeof buildEngineOptions>,
): Promise<void> {
  let manualResult: ManualUriSubmitResult = { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }

  if (hasBatch.value) {
    await submitBatchItems(batch.value, options, taskStore)
  }
  if (form.value.uris.trim()) {
    const shouldClassify = preferenceStore.config.fileCategoryEnabled && !dirUserModified.value
    manualResult = await submitManualUris(
      effectiveForm,
      options,
      taskStore,
      {
        enabled: shouldClassify,
        categories: preferenceStore.config.fileCategories,
      },
      getDownloadProxy(preferenceStore.config.proxy),
    )
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
  taskNames.push(...manualResult.submittedTaskNames)
  const magnetUris = normalizeUriLines(form.value.uris).filter(isMagnetUri)
  for (let i = 0; i < manualResult.magnetGids.length; i++) {
    const displayName = magnetUris[i] ? extractMagnetDisplayName(magnetUris[i]) : ''
    taskNames.push(displayName || t('task.magnet-task'))
  }

  if (effectiveForm.saveHttpAuth && effectiveForm.httpAuthUsername.trim()) {
    const firstHttpUri = normalizeUriLines(effectiveForm.uris).find((uri) => /^https?:\/\//i.test(uri))
    if (firstHttpUri) {
      try {
        await httpAuthStore.saveCredential({
          url: firstHttpUri,
          username: effectiveForm.httpAuthUsername,
          password: effectiveForm.httpAuthPassword,
        })
        message.success(t('task.task-http-auth-saved'))
      } catch (error) {
        logger.warn('AddTask.httpAuth', `credential save failed: ${error}`)
      }
    }
  }

  const effectiveDir = effectiveForm.dir
  handleClose()

  // Record directory for the recent-folders popover.
  if (effectiveDir) {
    preferenceStore.recordHistoryDirectory(effectiveDir)
  }

  handleTaskStart(taskNames, {
    messageInfo: message.info,
    t,
  })
  if (preferenceStore.config.newTaskShowDownloading !== false) {
    router.push({ path: '/task/all' }).catch(() => {})
  }
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true
  cookieExpired.value = false

  // Web-panel retry path: when the auto-parse failed and the user clicks
  // submit to retry, drop the stale `parseError` synchronously here so the
  // error banner hides in the same render where the submit button enters
  // loading. Without this, there's a one-frame gap between
  // `submitting=true` and `tryParseUrl` clearing parseError where the user
  // sees the failure banner alongside the loading spinner — the
  // "loading → 解析失败 → 成功" flicker.
  if (isFromWebPanel.value && !videoFlow.isParsing.value && !videoFlow.isVideo.value && !videoFlow.isPlaylist.value) {
    videoFlow.parseError.value = null
  }

  try {
    // Validate custom proxy before building options
    if (form.value.proxyMode === 'manual' && form.value.customProxy) {
      if (!isValidAria2ProxyUrl(form.value.customProxy)) {
        message.error(t('task.proxy-unsupported-protocol'), { closable: true })
        submitting.value = false
        return
      }
    }

    const effectiveForm = {
      ...form.value,
      dir: form.value.dir.trim() || preferenceStore.config.dir,
      appProxy: preferenceStore.config.proxy,
      defaultUserAgent: preferenceStore.config.userAgent,
      userAgentProfiles: preferenceStore.config.userAgentProfiles,
      userAgentRules: preferenceStore.config.userAgentRules,
    }
    const options = buildEngineOptions(effectiveForm)

    const handled = await submitVideoBranch(effectiveForm, options)
    if (handled) return

    if (isFromWebPanel.value) {
      // Web-panel flow always goes through yt-dlp. If a parse is already in
      // flight (auto-parse-on-open) we must wait for it instead of skipping
      // straight to submitVideoBranch — otherwise isVideo/isPlaylist are
      // still false and the user sees "解析失败" even though parsing was
      // about to succeed.
      if (videoFlow.isParsing.value) {
        await waitForParseComplete()
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
    const errMsg = getErrorMessage(e, {
      fallback: t('task.error-unknown'),
      labels: { Aria2: t('task.error-aria2-next') },
    })
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
        minWidth: 'min(380px, calc(100vw - 24px))',
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
          ref="tabsRef"
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
                  class="uri-input"
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
                        <NTag type="info" size="small" :bordered="false">
                          {{ t('task.torrent-task') }}
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
          <!-- Cookie box exposed inline (advanced options panel is hidden in
               this mode). Lets the user paste fresh cookies and re-parse
               without leaving the dialog. -->
          <NFormItem :label="t('task.task-cookie') + ':'">
            <NInput
              v-model:value="form.cookie"
              type="textarea"
              :rows="2"
              :placeholder="t('task.task-cookie-placeholder')"
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
                  :value="displayedDir"
                  style="flex: 1"
                  :placeholder="categoryEnabled ? t('task.category-dir-placeholder') : ''"
                  @update:value="onDirInput"
                />
                <NButton @click="chooseDirectory">
                  <template #icon>
                    <NIcon><FolderOpenOutline /></NIcon>
                  </template>
                </NButton>
                <DirectoryPopover @select="onDirectorySelect" />
              </NInputGroup>
              <div class="category-hint-collapse" :class="{ 'category-hint-collapse--open': !!categoryPreviewText }">
                <div class="category-hint-collapse__inner">
                  <Transition name="category-hint" mode="out-in">
                    <div v-if="categoryPreviewText" :key="categoryPreviewText" class="category-hint-text">
                      ⓘ {{ categoryPreviewText }}
                    </div>
                  </Transition>
                </div>
              </div>
            </div>
          </NFormItem>
          <AdvancedOptions
            v-if="!isFromWebPanel"
            v-model:show="showAdvanced"
            v-model:authorization="form.authorization"
            v-model:http-auth-username="form.httpAuthUsername"
            v-model:http-auth-password="form.httpAuthPassword"
            v-model:save-http-auth="form.saveHttpAuth"
            v-model:referer="form.referer"
            v-model:cookie="form.cookie"
            v-model:cookies-from-browser="form.cookiesFromBrowser"
            v-model:proxy-mode="form.proxyMode"
            v-model:custom-proxy="form.customProxy"
            v-model:custom-proxy-username="form.customProxyUsername"
            v-model:custom-proxy-password="form.customProxyPassword"
            :source-url="firstRegularUri"
            :user-agent="form.userAgent"
            :user-agent-source="userAgentSourceText"
            :user-agent-profiles="preferenceStore.config.userAgentProfiles"
            :user-agent-rules="preferenceStore.config.userAgentRules"
            :recent-user-agent-profile-ids="preferenceStore.config.recentUserAgentProfileIds"
            @update:user-agent="onUserAgentInput"
            @select-user-agent-profile="selectUserAgentProfile"
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
            :disabled="isFromWebPanel && videoFlow.isParsing.value && !submitting"
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

.uri-input :deep(.n-input__textarea-el) {
  white-space: pre-wrap;
  overflow-wrap: normal;
  word-break: break-all;
  hyphens: none;
}

/* ── Torrent panel ────────────────────────────────────────────────── */
.torrent-panel {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container-low);
}

/* ── Batch list ───────────────────────────────────────────────────── */
.batch-list {
  border-radius: 6px;
  border: 1px solid var(--m3-outline-variant);
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
  border-color: var(--m3-primary);
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
  background: var(--m3-error-container);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.split-limit-collapse--open .split-limit-bar {
  opacity: 1;
}
.split-limit-text {
  font-size: var(--font-size-sm);
  color: var(--m3-on-error-container);
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
  background: var(--m3-surface-container-high);
}
.batch-item-selected {
  background: var(--m3-surface-container-highest);
}
.batch-item + .batch-item {
  border-top: 1px solid var(--m3-outline-variant);
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
.category-hint-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.category-hint-collapse--open {
  grid-template-rows: 1fr;
}
.category-hint-collapse__inner {
  overflow: hidden;
}
.category-hint-text {
  font-size: var(--font-size-sm);
  color: var(--n-text-color-3);
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
