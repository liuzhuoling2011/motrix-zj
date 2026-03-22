<script setup lang="ts">
/**
 * @fileoverview Platform-aware window control buttons.
 *
 * On macOS, native traffic lights are provided by the OS via
 * `titleBarStyle: "Overlay"` in tauri.macos.conf.json — this component
 * renders nothing.
 *
 * On Windows/Linux, renders icon-style buttons (minimize → maximize → close,
 * right-aligned) since those platforms use `decorations: false`.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { NIcon } from 'naive-ui'
import { RemoveOutline, CopyOutline, SquareOutline, CloseOutline } from '@vicons/ionicons5'
import { usePreferenceStore } from '@/stores/preference'

const props = defineProps<{
  isMaximized: boolean
  /** Current OS platform identifier (e.g. 'macos', 'windows', 'linux'). */
  platform: string
}>()

const emit = defineEmits<{
  close: []
  'maximize-toggled': []
}>()

const appWindow = getCurrentWindow()
const preferenceStore = usePreferenceStore()

/** macOS uses native traffic lights — hide custom controls entirely. */
const isMac = computed(() => props.platform === 'macos')

// ── Window focus state ──────────────────────────────────────────────
const isFocused = ref(true)
let unlistenFocus: (() => void) | null = null

onMounted(async () => {
  if (!isMac.value) {
    unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
      isFocused.value = payload
    })
  }
})

onUnmounted(() => {
  unlistenFocus?.()
})

// ── Window actions ──────────────────────────────────────────────────

function minimize() {
  appWindow.minimize()
}

function toggleMaximize() {
  appWindow.toggleMaximize()
  emit('maximize-toggled')
}

async function close() {
  if (preferenceStore.config.minimizeToTrayOnClose) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_dock_visible', { visible: false })
    appWindow.hide()
  } else {
    emit('close')
  }
}
</script>

<template>
  <!-- macOS: native traffic lights provided by OS, render nothing -->
  <div v-if="!isMac" class="window-controls">
    <div class="win-buttons">
      <button class="ctrl-btn" title="Minimize" @click="minimize">
        <NIcon :size="14"><RemoveOutline /></NIcon>
      </button>
      <button class="ctrl-btn" :title="isMaximized ? 'Restore' : 'Maximize'" @click="toggleMaximize">
        <NIcon :size="14">
          <Transition name="icon-swap" mode="out-in">
            <CopyOutline v-if="isMaximized" key="restore" />
            <SquareOutline v-else key="maximize" />
          </Transition>
        </NIcon>
      </button>
      <button class="ctrl-btn close" title="Close" @click="close">
        <NIcon :size="14"><CloseOutline /></NIcon>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ── Windows / Linux buttons ─────────────────────────────────────── */
.win-buttons {
  position: fixed;
  top: 6px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ctrl-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--window-ctrl-border);
  border-radius: 8px;
  background: var(--window-ctrl-bg);
  color: var(--window-ctrl-color);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  outline: none;
  padding: 0;
}
.ctrl-btn:hover {
  background: var(--window-ctrl-hover-bg);
  border-color: var(--window-ctrl-hover-border);
  color: var(--window-ctrl-hover-color);
}
.ctrl-btn.close:hover {
  background: rgba(255, 59, 48, 0.75);
  border-color: rgba(255, 59, 48, 0.9);
  color: #fff;
}

/* Icon cross-fade animation for maximize ↔ restore toggle */
.icon-swap-enter-active,
.icon-swap-leave-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}
.icon-swap-enter-from {
  opacity: 0;
  transform: scale(0.75);
}
.icon-swap-leave-to {
  opacity: 0;
  transform: scale(0.75);
}
</style>
