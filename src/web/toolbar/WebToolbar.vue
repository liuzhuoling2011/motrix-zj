<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
}>()

const emit = defineEmits<{
  back: []
  forward: []
  reload: []
  home: []
  navigate: [url: string]
  download: [url: string]
  close: []
}>()

const input = ref(props.currentUrl)
watch(
  () => props.currentUrl,
  (u) => {
    input.value = u
  },
)

const isDownloadable = () => /^https?:\/\//i.test(props.currentUrl)

function onEnter() {
  const v = input.value.trim()
  if (v) emit('navigate', v)
}
</script>

<template>
  <div class="web-toolbar">
    <button class="btn btn-back" :disabled="!canGoBack" aria-label="后退" @click="emit('back')">←</button>
    <button class="btn btn-forward" :disabled="!canGoForward" aria-label="前进" @click="emit('forward')">→</button>
    <button class="btn btn-reload" aria-label="刷新" @click="emit('reload')">↻</button>
    <button class="btn btn-home" aria-label="首页" @click="emit('home')">🏠</button>
    <input
      v-model="input"
      type="text"
      class="url-input"
      placeholder="输入网址或粘贴视频页链接"
      @keydown.enter="onEnter"
    />
    <button class="btn btn-download" :disabled="!isDownloadable()" @click="emit('download', currentUrl)">
      下载视频
    </button>
    <button class="btn btn-close" aria-label="关闭面板" @click="emit('close')">✕</button>
  </div>
</template>

<style scoped>
.web-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 48px;
  padding: 0 8px;
  background: #f8f8f8;
  border-bottom: 1px solid #e0e0e0;
  font-size: 13px;
}
.btn {
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: white;
  cursor: pointer;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-download {
  margin-left: 4px;
  padding: 0 14px;
  background: #15803d;
  color: white;
  border-color: #15803d;
  font-weight: 600;
}
.btn-download:hover:not(:disabled) {
  background: #166534;
}
.btn-close {
  margin-left: 4px;
  color: #666;
  font-weight: 600;
}
.btn-close:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #991b1b;
}
.url-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  font-size: 13px;
}
.url-input:focus {
  outline: none;
  border-color: #15803d;
}
</style>
