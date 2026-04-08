<script setup lang="ts">
/**
 * @fileoverview Smart Capsule Speedometer — always-visible status bar with
 * integrated speed limit toggle and configuration.
 *
 * Fixed-width capsule (205px) — never shrinks:
 *   IDLE (muted)     — no active tasks, lock-open + ∞
 *   ACTIVE (primary)  — active tasks, lock-open + ∞
 *   LIMITED (tertiary) — limit active, lock-closed + values
 *
 * Interactions:
 *   Left-click  — toggle speed limit on/off (toast hint if unconfigured)
 *   Right-click — open speed limit configuration popover
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import { bytesToSize } from '@shared/utils'
import { NIcon, NPopover, NInputNumber, NSelect, NButton } from 'naive-ui'
import {
  SpeedometerOutline,
  ArrowUpOutline,
  ArrowDownOutline,
  LockClosedOutline,
  LockOpenOutline,
  InfiniteOutline,
} from '@vicons/ionicons5'
import {
  formatLimitBadge,
  parseSpeedLimitValue,
  buildSpeedLimitString,
  toggleSpeedLimit,
  applyCustomLimit,
} from '@/composables/useSpeedLimiter'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'

const { t } = useI18n()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()

const stat = computed(() => appStore.stat)
const isIdle = computed(() => stat.value.numActive === 0)
const isLimited = computed(() => !!preferenceStore.config.speedLimitEnabled)
const downloadSpeed = computed(() => bytesToSize(String(stat.value.downloadSpeed)))
const uploadSpeed = computed(() => bytesToSize(String(stat.value.uploadSpeed)))

// ── Limit badge display ─────────────────────────────────────────────

const dlLimitBadge = computed(() => formatLimitBadge(preferenceStore.config.maxOverallDownloadLimit))
const ulLimitBadge = computed(() => formatLimitBadge(preferenceStore.config.maxOverallUploadLimit))

// ── Popover state ───────────────────────────────────────────────────

const showPopover = ref(false)
const popoverDlValue = ref(0)
const popoverDlUnit = ref('K')
const popoverUlValue = ref(0)
const popoverUlUnit = ref('K')

const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

function openPopover() {
  const dl = parseSpeedLimitValue(preferenceStore.config.maxOverallDownloadLimit)
  const ul = parseSpeedLimitValue(preferenceStore.config.maxOverallUploadLimit)
  popoverDlValue.value = dl.num
  popoverDlUnit.value = dl.unit
  popoverUlValue.value = ul.num
  popoverUlUnit.value = ul.unit
  showPopover.value = true
}

// ── Dependency injection for composable calls ───────────────────────

function makeDeps() {
  return {
    changeGlobalOption,
    updateAndSave: (partial: Partial<typeof preferenceStore.config>) => preferenceStore.updateAndSave(partial),
  }
}

// ── Left-click: toggle speed limit ──────────────────────────────────

async function handleClick() {
  if (!isEngineReady()) return

  const result = await toggleSpeedLimit(preferenceStore.config, makeDeps())

  switch (result) {
    case 'enabled':
      message.success(t('app.speedometer-limit-applied'))
      break
    case 'disabled':
      message.success(t('app.speedometer-limit-removed'))
      break
    case 'needs-config':
      message.info(t('app.speedometer-needs-config'))
      break
  }
}

// ── Right-click: open configuration popover ─────────────────────────

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  openPopover()
}

// ── Apply custom limit from popover ─────────────────────────────────

async function handleApply() {
  if (!isEngineReady()) return

  // Reject 0/0 — at least one direction must have a non-zero limit
  if (popoverDlValue.value === 0 && popoverUlValue.value === 0) {
    message.warning(t('app.speedometer-enter-values'))
    return
  }

  const dlStr = buildSpeedLimitString(popoverDlValue.value, popoverDlUnit.value)
  const ulStr = buildSpeedLimitString(popoverUlValue.value, popoverUlUnit.value)

  try {
    await applyCustomLimit(dlStr, ulStr, makeDeps())
    showPopover.value = false
    message.success(t('app.speedometer-limit-applied'))
  } catch (e) {
    logger.error('Speedometer.applyLimit', e)
  }
}
</script>

<template>
  <NPopover
    :show="showPopover"
    trigger="manual"
    placement="top-end"
    :show-arrow="true"
    @update:show="(v: boolean) => (showPopover = v)"
    @clickoutside="showPopover = false"
  >
    <template #trigger>
      <div
        :class="['speedometer', { idle: isIdle, limited: isLimited }]"
        @click="handleClick"
        @contextmenu="handleContextMenu"
      >
        <div class="mode">
          <i>
            <NIcon :size="22"><SpeedometerOutline /></NIcon>
            <span :class="['lock-badge', { locked: isLimited }]">
              <NIcon :size="10">
                <LockClosedOutline v-if="isLimited" />
                <LockOpenOutline v-else />
              </NIcon>
            </span>
          </i>
        </div>
        <div class="value">
          <div class="speed-row upload">
            <NIcon :size="10" class="speed-arrow"><ArrowUpOutline /></NIcon>
            <em>{{ uploadSpeed }}/s</em>
            <span class="limit-sep">┊</span>
            <span v-if="isLimited" class="limit-value">{{ ulLimitBadge }}</span>
            <NIcon v-else :size="12" class="limit-inf"><InfiniteOutline /></NIcon>
          </div>
          <div class="speed-row download">
            <NIcon :size="10" class="speed-arrow"><ArrowDownOutline /></NIcon>
            <span>{{ downloadSpeed }}/s</span>
            <span class="limit-sep">┊</span>
            <span v-if="isLimited" class="limit-value">{{ dlLimitBadge }}</span>
            <NIcon v-else :size="12" class="limit-inf"><InfiniteOutline /></NIcon>
          </div>
        </div>
      </div>
    </template>

    <!-- Speed limit configuration panel -->
    <div class="limit-panel">
      <div class="limit-panel-title">{{ t('app.speedometer-set-limit') }}</div>

      <div class="limit-panel-row">
        <div class="limit-panel-label">
          <NIcon :size="12"><ArrowDownOutline /></NIcon>
          <span>{{ t('app.speedometer-download-limit') }}</span>
        </div>
        <div class="limit-panel-inputs">
          <NInputNumber
            v-model:value="popoverDlValue"
            :min="0"
            :max="65535"
            :step="1"
            size="small"
            style="width: 100px"
          />
          <NSelect v-model:value="popoverDlUnit" :options="speedUnitOptions" size="small" style="width: 88px" />
        </div>
      </div>

      <div class="limit-panel-row">
        <div class="limit-panel-label">
          <NIcon :size="12"><ArrowUpOutline /></NIcon>
          <span>{{ t('app.speedometer-upload-limit') }}</span>
        </div>
        <div class="limit-panel-inputs">
          <NInputNumber
            v-model:value="popoverUlValue"
            :min="0"
            :max="65535"
            :step="1"
            size="small"
            style="width: 100px"
          />
          <NSelect v-model:value="popoverUlUnit" :options="speedUnitOptions" size="small" style="width: 88px" />
        </div>
      </div>

      <NButton type="primary" size="small" block style="margin-top: 12px" @click="handleApply">
        {{ t('app.speedometer-apply') }}
      </NButton>
    </div>
  </NPopover>
</template>

<style scoped>
/* ── Base: fixed-width capsule (205px, never shrinks) ─────────────── */
.speedometer {
  font-size: 12px;
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 20;
  display: inline-block;
  box-sizing: border-box;
  width: 205px;
  height: 46px;
  padding: 6px 14px 6px 44px;
  border-radius: 100px;
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    background 0.2s cubic-bezier(0.2, 0, 0, 1);
  border: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container);
}
.speedometer:hover {
  border-color: var(--m3-outline);
}
.speedometer:active {
  transform: scale(0.97);
}

/* ── IDLE — muted colors ─────────────────────────────────────────── */
.speedometer.idle .mode i {
  color: var(--m3-outline);
  transform: rotate(-15deg);
}
.speedometer.idle .value {
  opacity: 0.45;
}
.speedometer.idle .speed-row.download {
  color: var(--m3-outline);
}
.speedometer.idle .speed-row.download .speed-arrow {
  color: var(--m3-outline);
}

/* ── LIMITED — tertiary color accent ─────────────────────────────── */
.speedometer.limited {
  border-color: var(--m3-tertiary-container, var(--m3-outline-variant));
}
.speedometer.limited:hover {
  border-color: var(--m3-tertiary, var(--m3-outline));
}
.speedometer.limited .mode i {
  color: var(--m3-tertiary, var(--color-primary));
}
.speedometer.limited .speed-row.download {
  color: var(--m3-tertiary, var(--color-primary));
}
.speedometer.limited .speed-row.download .speed-arrow {
  color: var(--m3-tertiary, var(--color-primary));
}

/* ── Common ──────────────────────────────────────────────────────── */
.speedometer em {
  font-style: normal;
}
.mode {
  font-size: 0;
  position: absolute;
  top: 6px;
  left: 7px;
}
.mode i {
  font-size: 22px;
  font-style: normal;
  line-height: 30px;
  display: inline-block;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 2px;
  text-align: center;
  vertical-align: top;
  position: relative;
  color: var(--color-primary);
  transition:
    transform 0.35s cubic-bezier(0.2, 0, 0, 1),
    color 0.2s cubic-bezier(0.2, 0, 0, 1);
  transform: rotate(0deg);
}
.value {
  overflow: hidden;
  width: 100%;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 1;
  transition: opacity 0.3s cubic-bezier(0.2, 0, 0, 1);
}
.speed-row {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
}
.speed-arrow {
  flex-shrink: 0;
  opacity: 0.7;
}
.speed-row.upload {
  color: var(--m3-outline);
}
.speed-row.upload em {
  font-style: normal;
  font-size: 11px;
  line-height: 14px;
}
.speed-row.upload .speed-arrow {
  color: var(--m3-outline);
}
.speed-row.download {
  color: var(--color-primary);
}
.speed-row.download span {
  font-size: 13px;
  line-height: 16px;
  font-weight: 500;
}
.speed-row.download .speed-arrow {
  color: var(--color-primary);
}

/* ── Lock badge (always visible on speedometer icon) ──────────────── */
.lock-badge {
  position: absolute;
  bottom: -2px;
  right: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--m3-surface-container);
  color: var(--m3-outline);
  font-size: 10px;
  transition:
    color 0.2s cubic-bezier(0.2, 0, 0, 1),
    background 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.lock-badge.locked {
  background: var(--m3-tertiary-container, var(--m3-surface-container));
  color: var(--m3-tertiary, var(--color-primary));
}

/* ── Right-side limit/infinity display ────────────────────────────── */
.limit-sep {
  opacity: 0.3;
  font-size: 11px;
  margin: 0 1px;
  flex-shrink: 0;
}
.limit-value {
  font-size: 11px;
  opacity: 0.65;
  flex-shrink: 0;
  font-weight: 400;
}
.limit-inf {
  opacity: 0.35;
  flex-shrink: 0;
}

/* ── Popover panel ────────────────────────────────────────────────── */
.limit-panel {
  padding: 4px 0;
  min-width: 280px;
}
.limit-panel-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--m3-on-surface, inherit);
}
.limit-panel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.limit-panel-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  width: 70px;
  flex-shrink: 0;
  opacity: 0.8;
}
.limit-panel-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}
</style>
