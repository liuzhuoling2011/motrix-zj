<script setup lang="ts">
/**
 * @fileoverview Custom tray popup menu for Windows.
 *
 * macOS uses native NSMenu (good styling by default).
 * Linux follows DE theme (acceptable).
 * Windows Win32 context menus are visually plain — this custom popup
 * provides M3-styled menu items with icons, hover effects, and animations.
 *
 * Architecture: Runs inside a dedicated borderless, transparent Tauri window
 * (`tray-menu`). On right-click, tray.rs shows this window positioned near
 * the system tray icon.  Clicking an item emits the action to the main
 * window via Tauri events, then auto-closes.
 */
import { onMounted, onUnmounted } from 'vue'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from 'vue-i18n'
import { TRAY_MENU_ITEMS, type TrayMenuActionItem } from './trayMenuItems'

const { t } = useI18n()
const currentWindow = getCurrentWindow()

/** Resolve Ionicons5 component by name. */
import { OpenOutline, AddCircleOutline, PlayOutline, PauseOutline, PowerOutline } from '@vicons/ionicons5'

const iconMap: Record<string, typeof OpenOutline> = {
  OpenOutline,
  AddCircleOutline,
  PlayOutline,
  PauseOutline,
  PowerOutline,
}

async function handleItemClick(item: TrayMenuActionItem) {
  // Emit action to the main window, then close the popup.
  await emit('tray-menu-action', item.id)
  await currentWindow.hide()
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    currentWindow.hide()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleEscape)
  // Auto-close when the popup loses focus.
  currentWindow.onFocusChanged(({ payload: focused }) => {
    if (!focused) currentWindow.hide()
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEscape)
})
</script>

<template>
  <div class="tray-menu" data-testid="tray-menu">
    <template v-for="item in TRAY_MENU_ITEMS" :key="item.id">
      <div v-if="item.type === 'separator'" class="tray-menu-separator" />
      <button
        v-else
        class="tray-menu-item"
        :class="{ 'tray-menu-item--danger': (item as TrayMenuActionItem).variant === 'danger' }"
        :data-testid="`tray-item-${item.id}`"
        @click="handleItemClick(item as TrayMenuActionItem)"
      >
        <component :is="iconMap[(item as TrayMenuActionItem).icon]" class="tray-menu-icon" />
        <span class="tray-menu-label">{{ t((item as TrayMenuActionItem).labelKey) }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.tray-menu {
  width: 220px;
  padding: 6px;
  background: var(--m3-surface-container-high);
  border: 1px solid var(--m3-outline-variant);
  border-radius: 12px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.18),
    0 2px 8px rgba(0, 0, 0, 0.1);
  font-family: var(--font-family);
  user-select: none;
  /* M3 emphasized decelerate easing for entry */
  animation: tray-menu-enter 0.2s cubic-bezier(0.05, 0.7, 0.1, 1);
}

@keyframes tray-menu-enter {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.tray-menu-separator {
  height: 1px;
  margin: 4px 12px;
  background: var(--m3-outline-variant);
}

.tray-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m3-on-surface);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background 0.15s cubic-bezier(0.2, 0, 0, 1);
}

.tray-menu-item:hover {
  background: color-mix(in srgb, var(--m3-on-surface) 8%, transparent);
}

.tray-menu-item:active {
  background: color-mix(in srgb, var(--m3-on-surface) 12%, transparent);
}

.tray-menu-item--danger {
  color: var(--m3-error);
}

.tray-menu-item--danger:hover {
  background: color-mix(in srgb, var(--m3-error) 8%, transparent);
}

.tray-menu-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.tray-menu-label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
