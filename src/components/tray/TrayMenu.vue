<script setup lang="ts">
/**
 * @fileoverview Custom tray popup menu (cross-platform).
 *
 * Architecture: Runs inside a dedicated borderless, transparent Tauri window
 * (`tray-menu`). On right-click, tray.rs shows this window positioned near
 * the system tray icon via tauri-plugin-positioner.  Clicking an item emits
 * the action to the main window via Tauri events, then auto-closes.
 *
 * Focus guard: macOS can trigger onFocusChanged(false) during the show()
 * animation before the window is fully visible.  Without a delay guard,
 * this causes hide/show thrashing and a frozen UI.  The `focusGuardActive`
 * ref blocks focus-loss hiding for 200ms after each show.
 */
import { ref, onMounted, onUnmounted } from 'vue'
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

/**
 * Focus guard: when true, onFocusChanged(false) is ignored.
 * Armed for 200ms after the window becomes visible to prevent the
 * macOS show-animation race condition.
 */
const focusGuardActive = ref(false)
let focusGuardTimer: ReturnType<typeof setTimeout> | null = null

function armFocusGuard() {
  focusGuardActive.value = true
  if (focusGuardTimer) clearTimeout(focusGuardTimer)
  focusGuardTimer = setTimeout(() => {
    focusGuardActive.value = false
  }, 200)
}

async function handleItemClick(item: TrayMenuActionItem) {
  await emit('tray-menu-action', item.id)
  await currentWindow.hide()
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    currentWindow.hide()
  }
}

let unlistenFocus: (() => void) | null = null

onMounted(async () => {
  document.addEventListener('keydown', handleEscape)

  // Arm the focus guard whenever the window gains focus (i.e. becomes visible).
  // Auto-hide when the window loses focus (clicked outside) after the guard expires.
  const unlistenShow = await currentWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      armFocusGuard()
    } else if (!focusGuardActive.value) {
      currentWindow.hide()
    }
  })
  unlistenFocus = unlistenShow
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEscape)
  if (focusGuardTimer) clearTimeout(focusGuardTimer)
  if (unlistenFocus) unlistenFocus()
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

<!-- Global style: transparent body required for Tauri transparent window -->
<style>
html,
body {
  background: transparent !important;
}
</style>
