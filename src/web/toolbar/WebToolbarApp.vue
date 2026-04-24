<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import WebToolbar from './WebToolbar.vue'

const currentUrl = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)
let stop: (() => void) | null = null

onMounted(async () => {
  stop = await listen<{ url: string; canGoBack: boolean; canGoForward: boolean }>(
    'web-browser-url-changed',
    ({ payload }) => {
      currentUrl.value = payload.url
      canGoBack.value = payload.canGoBack
      canGoForward.value = payload.canGoForward
    },
  )
})
onBeforeUnmount(() => {
  if (stop) stop()
})

function nav(action: string, url?: string) {
  invoke('web_browser_navigate', { action, url: url ?? null })
}
function download(url: string) {
  invoke('save_cookies_and_trigger_download', { url })
}
function close() {
  invoke('toggle_web_panel', { open: false, width: null })
}
</script>

<template>
  <WebToolbar
    :current-url="currentUrl"
    :can-go-back="canGoBack"
    :can-go-forward="canGoForward"
    @back="nav('back')"
    @forward="nav('forward')"
    @reload="nav('reload')"
    @home="nav('home')"
    @navigate="(u) => nav('load', u)"
    @download="download"
    @close="close"
  />
</template>
