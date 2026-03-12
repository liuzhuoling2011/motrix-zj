<script setup lang="ts">
/**
 * @fileoverview Custom tray popup menu (cross-platform).
 *
 * Architecture: Runs inside a dedicated borderless, transparent Tauri window
 * (`tray-menu`). On right-click, tray.rs positions this window at the mouse
 * cursor coordinates and shows it.  Clicking an item emits
 * the action to the main window via Tauri events, then auto-closes.
 *
 * Animation lifecycle:
 *   - Enter: re-triggered on every `onFocusChanged(true)` via class toggle
 *            (M3 emphasized decelerate, 200ms)
 *   - Exit:  played before `hide()` via `animationend` callback
 *            (M3 standard accelerate, 150ms)
 *
 * Focus guard: macOS can trigger onFocusChanged(false) during the show()
 * animation before the window is fully visible.  Without a delay guard,
 * this causes hide/show thrashing and a frozen UI.  The `focusGuardActive`
 * ref blocks focus-loss hiding for 200ms after each show.
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { TRAY_MENU_ITEMS, type TrayMenuActionItem } from './trayMenuItems'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
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

// ── Focus guard (window-global to survive HMR) ─────────────────────
// Stored on `window` so that HMR-created duplicate onFocusChanged
// listeners all share the same guard boolean.  Without this, each
// hot-reload cycle creates a new module scope with its own variable,
// and old listeners read a stale copy that is always `false`.
const _w = window as unknown as {
  __trayFocusGuard?: boolean
  __trayGuardTimer?: ReturnType<typeof setTimeout>
}

// ── Animation state ──────────────────────────────────────────────────
const animating = ref(false)
const exiting = ref(false)
let hiding = false

/**
 * Re-trigger the M3 enter animation and arm the focus guard.
 *
 * Two critical design constraints:
 *
 * 1. **Focus guard first** — macOS fires rapid focus→blur→focus during
 *    app activation.  The guard must be armed BEFORE any other logic
 *    so the interleaved blur callback sees it immediately.
 *
 * 2. **requestAnimationFrame for animation restart** — CSS animations
 *    only restart when the class is removed for at least one frame.
 *    Vue batches synchronous ref changes (`false → true`) into a
 *    single render, producing no DOM change.  `requestAnimationFrame`
 *    guarantees the removal is painted before re-addition.
 *
 * Preference reload is fire-and-forget after the animation is armed.
 */
function onWindowShow() {
  // ── 1. Arm the focus guard (window-global) ──
  _w.__trayFocusGuard = true
  if (_w.__trayGuardTimer) clearTimeout(_w.__trayGuardTimer)
  _w.__trayGuardTimer = setTimeout(() => {
    _w.__trayFocusGuard = false
  }, 300)

  // ── 2. Reset exit state synchronously ──
  exiting.value = false
  hiding = false

  // ── 3. Restart CSS animation via requestAnimationFrame ──
  // Frame N:   remove animation class → browser paints opacity:0
  // Frame N+1: add animation class    → CSS animation plays
  animating.value = false
  requestAnimationFrame(() => {
    animating.value = true
  })

  // ── 4. Non-blocking preference refresh ──
  preferenceStore.loadPreference()
}

/**
 * Play the M3 exit animation, then hide the window.
 *
 * Guards against double-calls: if a hide is already in progress, this
 * is a no-op.  The `animationend` handler calls `currentWindow.hide()`
 * after the exit transition completes (150ms).
 */
function hideWithAnimation() {
  if (hiding || exiting.value) return
  hiding = true
  exiting.value = true

  const menu = document.querySelector('.tray-menu') as HTMLElement | null
  if (!menu) {
    // Fallback: no DOM element, hide immediately
    currentWindow.hide()
    return
  }

  const onEnd = () => {
    menu.removeEventListener('animationend', onEnd)
    currentWindow.hide()
    exiting.value = false
  }
  menu.addEventListener('animationend', onEnd)

  // Safety fallback: if animationend never fires, hide after 200ms
  setTimeout(() => {
    menu.removeEventListener('animationend', onEnd)
    currentWindow.hide()
    exiting.value = false
  }, 200)
}

async function handleItemClick(item: TrayMenuActionItem) {
  await emit('tray-menu-action', item.id)
  hideWithAnimation()
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    hideWithAnimation()
  }
}

let unlistenShow: UnlistenFn | null = null
let unlistenBlur: (() => void) | null = null

onMounted(async () => {
  document.addEventListener('keydown', handleEscape)

  // Enter animation: triggered by explicit Rust event (cross-platform reliable).
  // Rust emits 'tray-popup-show' before calling show(), so the animation
  // state is set before the window becomes visible.
  unlistenShow = await listen('tray-popup-show', () => {
    onWindowShow()
  })

  // Exit: blur-only — hide when the window loses focus.
  unlistenBlur = await currentWindow.onFocusChanged(({ payload: focused }) => {
    if (!focused && !_w.__trayFocusGuard) {
      hideWithAnimation()
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEscape)
  if (_w.__trayGuardTimer) clearTimeout(_w.__trayGuardTimer)
  if (unlistenShow) unlistenShow()
  if (unlistenBlur) unlistenBlur()
})
</script>

<template>
  <div
    class="tray-menu"
    :class="{ 'tray-menu--enter': animating && !exiting, 'tray-menu--exit': exiting }"
    data-testid="tray-menu"
  >
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
  /* Start invisible — animation classes drive visibility */
  opacity: 0;
  transform: scale(0.92) translateY(8px);
}

/* ── M3 Enter: emphasized decelerate (200ms) ──────────────────────── */
.tray-menu--enter {
  animation: tray-enter 0.2s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}

@keyframes tray-enter {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* ── M3 Exit: standard accelerate (150ms) ─────────────────────────── */
.tray-menu--exit {
  animation: tray-exit 0.15s cubic-bezier(0.3, 0, 0.8, 0.15) forwards;
}

@keyframes tray-exit {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.95) translateY(4px);
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
