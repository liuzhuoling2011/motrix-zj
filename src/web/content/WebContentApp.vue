<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { onMounted, onBeforeUnmount } from 'vue'
import SiteGrid from './SiteGrid.vue'

let stop: (() => void) | null = null

function navigate(url: string) {
  window.location.href = url
}

onMounted(async () => {
  stop = await listen<{ url: string }>('web-browser-navigate', (evt) => {
    navigate(evt.payload.url)
  })
})
onBeforeUnmount(() => {
  if (stop) stop()
})
</script>

<template>
  <SiteGrid @navigate="navigate" />
</template>
