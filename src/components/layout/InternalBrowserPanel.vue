<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emit as emitTauri } from '@tauri-apps/api/event'
import { NIcon } from 'naive-ui'
import {
  ArrowBackOutline,
  ArrowForwardOutline,
  CloseOutline,
  DownloadOutline,
  HomeOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import SiteGrid from '@/web/content/SiteGrid.vue'
import { logger } from '@shared/logger'

const emit = defineEmits<{ close: [] }>()
const props = defineProps<{
  platform?: string
}>()

const currentUrl = ref('')
const frameSrc = ref('')
const addressInput = ref('')
const frameKey = ref(0)
const iframeRef = ref<HTMLIFrameElement | null>(null)
const historyStack = ref<string[]>([])
const historyIndex = ref(-1)
const frameUrl = computed(() => frameSrc.value || '')
const isWindows = computed(() => props.platform === 'windows')
const canGoBack = computed(() => historyIndex.value > 0)
const canGoForward = computed(() => historyIndex.value >= 0 && historyIndex.value < historyStack.value.length - 1)
const canDownload = computed(() => /^https?:\/\//i.test(currentUrl.value))
const WEB_PANEL_FRAME_MESSAGE_SOURCE = 'motrix-next-web-panel'
const WEB_PANEL_FRAME_URL_MESSAGE_TYPE = 'url-changed'

watch(currentUrl, (url) => {
  addressInput.value = url
})

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function navigate(url: string, replace = false) {
  const normalizedUrl = normalizeUrl(url)
  if (!normalizedUrl) return

  currentUrl.value = normalizedUrl
  frameSrc.value = normalizedUrl
  if (!replace) {
    frameKey.value += 1
  }

  if (replace && historyIndex.value >= 0) {
    historyStack.value[historyIndex.value] = normalizedUrl
    return
  }

  const retainedHistory = historyStack.value.slice(0, historyIndex.value + 1)
  historyStack.value = [...retainedHistory, normalizedUrl]
  historyIndex.value = historyStack.value.length - 1
}

function syncFrameUrl(url: string) {
  const normalizedUrl = normalizeUrl(url)
  if (!normalizedUrl || normalizedUrl === currentUrl.value) return
  currentUrl.value = normalizedUrl
  if (historyIndex.value >= 0) {
    historyStack.value[historyIndex.value] = normalizedUrl
  } else {
    historyStack.value = [normalizedUrl]
    historyIndex.value = 0
  }
}

function goHome() {
  currentUrl.value = ''
  frameSrc.value = ''
  addressInput.value = ''
  historyStack.value = []
  historyIndex.value = -1
}

function goBack() {
  if (!canGoBack.value) return
  historyIndex.value -= 1
  currentUrl.value = historyStack.value[historyIndex.value] ?? ''
  frameSrc.value = currentUrl.value
  frameKey.value += 1
}

function goForward() {
  if (!canGoForward.value) return
  historyIndex.value += 1
  currentUrl.value = historyStack.value[historyIndex.value] ?? ''
  frameSrc.value = currentUrl.value
  frameKey.value += 1
}

function refresh() {
  if (!currentUrl.value) return
  frameKey.value += 1
}

function submitAddress() {
  navigate(addressInput.value)
}

async function downloadVideo() {
  if (!canDownload.value) return
  try {
    await invoke('save_cookies_and_trigger_download', { url: currentUrl.value })
  } catch (e) {
    logger.warn('InternalBrowserPanel.downloadVideo.saveCookies', e instanceof Error ? e.message : String(e))
    try {
      await emitTauri('add-task-from-web', { url: currentUrl.value })
    } catch (emitError) {
      logger.warn(
        'InternalBrowserPanel.downloadVideo.emitFallback',
        emitError instanceof Error ? emitError.message : String(emitError),
      )
    }
  }
}

function forceCurrentFrameNavigation() {
  try {
    const frameWindow = iframeRef.value?.contentWindow
    const frameDocument = iframeRef.value?.contentDocument
    if (!frameWindow || !frameDocument) return

    frameWindow.open = ((url?: string | URL | null) => {
      if (url) frameWindow.location.href = String(url)
      return frameWindow
    }) as typeof window.open

    frameDocument.querySelectorAll<HTMLAnchorElement>('a[target="_blank"], a[target="_new"]').forEach((anchor) => {
      anchor.target = '_self'
    })
    frameDocument.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
        if (!target || (target.target !== '_blank' && target.target !== '_new')) return
        event.preventDefault()
        target.target = '_self'
        frameWindow.location.href = target.href
      },
      true,
    )
  } catch (e) {
    logger.debug('InternalBrowserPanel.forceCurrentFrameNavigation', e instanceof Error ? e.message : String(e))
  }
}

function isFrameUrlMessage(data: unknown): data is { source: string; type: string; url: string } {
  if (!data || typeof data !== 'object') return false
  const payload = data as Record<string, unknown>
  return (
    payload.source === WEB_PANEL_FRAME_MESSAGE_SOURCE &&
    payload.type === WEB_PANEL_FRAME_URL_MESSAGE_TYPE &&
    typeof payload.url === 'string' &&
    /^https?:\/\//i.test(payload.url)
  )
}

function handleFrameUrlMessage(event: MessageEvent<unknown>) {
  if (!frameUrl.value || !isFrameUrlMessage(event.data)) return
  syncFrameUrl(event.data.url)
}

onMounted(() => window.addEventListener('message', handleFrameUrlMessage))
onUnmounted(() => window.removeEventListener('message', handleFrameUrlMessage))
</script>

<template>
  <section class="internal-browser" :class="{ windows: isWindows }" aria-label="Internal browser">
    <div v-if="isWindows" class="title-drag-strip" data-tauri-drag-region />
    <div class="browser-toolbar">
      <button
        type="button"
        class="tool-button icon-button"
        :disabled="!canGoBack"
        aria-label="Back"
        title="Back"
        @click="goBack"
      >
        <NIcon :size="18"><ArrowBackOutline /></NIcon>
      </button>
      <button
        type="button"
        class="tool-button icon-button"
        :disabled="!canGoForward"
        aria-label="Forward"
        title="Forward"
        @click="goForward"
      >
        <NIcon :size="18"><ArrowForwardOutline /></NIcon>
      </button>
      <button type="button" class="tool-button icon-button" aria-label="Refresh" title="Refresh" @click="refresh">
        <NIcon :size="18"><RefreshOutline /></NIcon>
      </button>
      <button type="button" class="tool-button icon-button" aria-label="Home" title="Home" @click="goHome">
        <NIcon :size="18"><HomeOutline /></NIcon>
      </button>
      <input
        v-model="addressInput"
        class="url-input"
        type="text"
        placeholder="Enter a URL or paste a video page link"
        @keydown.enter="submitAddress"
      />
      <button
        type="button"
        class="tool-button icon-button download-button"
        :disabled="!canDownload"
        aria-label="Download video"
        title="Download video"
        @click="downloadVideo"
      >
        <NIcon :size="18"><DownloadOutline /></NIcon>
      </button>
      <button
        type="button"
        class="tool-button icon-button close-button"
        aria-label="Close"
        title="Close"
        @click="emit('close')"
      >
        <NIcon :size="18"><CloseOutline /></NIcon>
      </button>
    </div>

    <div class="browser-content">
      <SiteGrid v-if="!frameUrl" @navigate="navigate" />
      <iframe
        v-else
        :key="frameKey"
        ref="iframeRef"
        :src="frameUrl"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
        allowfullscreen
        class="browser-frame"
        referrerpolicy="strict-origin-when-cross-origin"
        title="Internal browser content"
        @load="forceCurrentFrameNavigation"
      />
    </div>
  </section>
</template>

<style scoped>
.internal-browser {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--main-bg);
  color: var(--m3-on-surface);
  border-left: 1px solid var(--m3-outline-variant);
}

.title-drag-strip {
  height: 36px;
  flex-shrink: 0;
  background: var(--main-bg);
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 10px;
  border-bottom: 1px solid var(--m3-outline-variant);
  background: var(--subnav-bg);
  flex-shrink: 0;
}

.tool-button {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 6px;
  background: var(--main-bg);
  color: var(--m3-on-surface);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-button:hover:not(:disabled) {
  background: var(--m3-surface-container-high);
}

.tool-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.icon-button {
  width: 32px;
  flex: 0 0 32px;
}

.download-button {
  color: var(--m3-primary);
}

.download-button:hover:not(:disabled) {
  background: var(--m3-primary-container);
  color: var(--m3-on-primary-container);
}

.close-button:hover {
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}

.url-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 6px;
  background: var(--main-bg);
  color: var(--m3-on-surface);
}

.browser-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.browser-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
