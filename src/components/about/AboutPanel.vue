<script setup lang="ts">
/** @fileoverview About panel with staggered entrance animations and glass effect. */
import { ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { open } from '@tauri-apps/plugin-shell'
import { getVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { preloadSidecarVersions, useSidecarVersions } from '@shared/utils/sidecarVersion'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const message = useAppMessage()
const appVersion = ref('')
const aria2Version = ref('')
const aria2Loading = ref(true)
const aria2Error = ref(false)
const animate = ref(false)

interface SidecarEntry {
  key: 'ytdlp' | 'ffmpeg' | 'ffprobe'
  label: string
  loading: boolean
  error: boolean
  version: string
}
const sidecars = ref<SidecarEntry[]>([
  { key: 'ytdlp', label: 'yt-dlp', loading: true, error: false, version: '' },
  { key: 'ffmpeg', label: 'ffmpeg', loading: true, error: false, version: '' },
  { key: 'ffprobe', label: 'ffprobe', loading: true, error: false, version: '' },
])

const sidecarVersionMap = useSidecarVersions()

async function loadSidecarVersions() {
  try {
    await preloadSidecarVersions()
  } catch (e) {
    logger.warn('AboutPanel', `sidecar version preload failed: ${e}`)
  }
  sidecars.value.forEach((entry) => {
    const v = sidecarVersionMap.value[entry.key]
    if (v) {
      entry.version = v
      entry.error = false
    } else {
      entry.error = true
    }
    entry.loading = false
  })
}

onMounted(async () => {
  appVersion.value = await getVersion()
})

/* Trigger entrance animation and re-fetch aria2 version each time the panel opens. */
watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      animate.value = false
      requestAnimationFrame(() => {
        animate.value = true
      })

      /* Reset state and fetch fresh aria2 version */
      aria2Loading.value = true
      aria2Error.value = false
      aria2Version.value = ''
      try {
        const info = await getAria2Version()
        aria2Version.value = info.version
      } catch (e) {
        logger.warn('AboutPanel', `aria2 version fetch failed: ${e}`)
        aria2Error.value = true
      } finally {
        aria2Loading.value = false
      }
      loadSidecarVersions()
    }
  },
)

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('about.version-copied', { label }))
  } catch (e) {
    logger.debug('AboutPanel.clipboard', `writeText failed: ${e}`)
  }
}

function openUrl(url: string) {
  open(url)
}
</script>

<template>
  <NModal
    :show="show"
    transform-origin="center"
    @update:show="
      (v: boolean) => {
        if (!v) emit('close')
      }
    "
  >
    <div class="about-glass" :class="{ 'about-enter': animate }">
      <!-- Close button -->
      <button class="about-close" :aria-label="t('about.about')" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>

      <!-- Logo -->
      <div class="about-logo stagger stagger-1">
        <img src="@/assets/logo.png" alt="Motrix ZJ" width="96" height="96" />
      </div>

      <!-- Title -->
      <div class="about-title stagger stagger-2">Motrix <span class="accent">ZJ</span></div>

      <!-- Version Badges (stacked, prominent) -->
      <div class="about-versions stagger stagger-2">
        <MTooltip>
          <template #trigger>
            <button class="version-badge" @click="copyToClipboard(`Motrix ZJ v${appVersion}`, 'Motrix ZJ')">
              <span class="version-label">{{ t('about.app-version') }}</span>
              <span class="version-value">v{{ appVersion }}</span>
              <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
              </svg>
            </button>
          </template>
          {{ t('about.click-to-copy') }}
        </MTooltip>
        <Transition name="version-swap" mode="out-in">
          <!-- Loading -->
          <div v-if="aria2Loading" key="loading" class="version-badge version-badge--loading">
            <span class="version-label">{{ t('about.aria2-version') }}</span>
            <span class="version-loading">
              <svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.2" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
              {{ t('about.loading') }}
            </span>
          </div>
          <!-- Error -->
          <div v-else-if="aria2Error" key="error" class="version-badge version-badge--loading">
            <span class="version-label">{{ t('about.aria2-version') }}</span>
            <span class="version-error">{{ t('about.unavailable') }}</span>
          </div>
          <!-- Success -->
          <MTooltip v-else key="loaded">
            <template #trigger>
              <button class="version-badge" @click="copyToClipboard(`aria2 v${aria2Version}`, 'aria2')">
                <span class="version-label">{{ t('about.aria2-version') }}</span>
                <span class="version-value">v{{ aria2Version }}</span>
                <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
                </svg>
              </button>
            </template>
            {{ t('about.click-to-copy') }}
          </MTooltip>
        </Transition>

        <!-- Sidecar versions: yt-dlp / ffmpeg / ffprobe -->
        <template v-for="entry in sidecars" :key="entry.key">
          <div v-if="entry.loading" class="version-badge version-badge--loading">
            <span class="version-label">{{ entry.label }}</span>
            <span class="version-loading">
              <svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.2" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
              {{ t('about.loading') }}
            </span>
          </div>
          <div v-else-if="entry.error" class="version-badge version-badge--loading">
            <span class="version-label">{{ entry.label }}</span>
            <span class="version-error">{{ t('about.unavailable') }}</span>
          </div>
          <MTooltip v-else>
            <template #trigger>
              <button class="version-badge" @click="copyToClipboard(`${entry.label} v${entry.version}`, entry.label)">
                <span class="version-label">{{ entry.label }}</span>
                <span class="version-value">v{{ entry.version }}</span>
                <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
                </svg>
              </button>
            </template>
            {{ t('about.click-to-copy') }}
          </MTooltip>
        </template>
      </div>

      <!-- Description -->
      <p class="about-desc stagger stagger-3">{{ t('about.description') }}</p>

      <!-- Footer -->
      <div class="about-footer stagger stagger-6">
        <span>
          Developed by Zoran • Inspired by
          <a class="about-link" @click="openUrl('https://github.com/AnInsomniacy/motrix-next')">Motrix Next</a>
          /
          <a class="about-link" @click="openUrl('https://github.com/yt-dlp/yt-dlp')">YT-DLP</a>
        </span>
        <span>&copy; 2026 ZoranJojo</span>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
/* ── Glass Container ──────────────────────────────────────────────── */
.about-glass {
  position: relative;
  max-width: 440px;
  min-width: 320px;
  width: 50vw;
  padding: 32px 28px 24px;
  text-align: center;
  border-radius: 16px;
  border: 1px solid var(--m3-outline-variant);
  background: color-mix(in srgb, var(--m3-surface-container-high) 96%, transparent);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  box-shadow:
    0 8px 32px var(--m3-shadow),
    0 0 0 1px color-mix(in srgb, var(--m3-on-surface) 8%, transparent);
}

/* ── Close Button ─────────────────────────────────────────────────── */
.about-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m3-on-surface-variant);
  cursor: pointer;
  transition: var(--transition-all);
}
.about-close:hover {
  background: var(--m3-surface-container-highest);
  color: var(--m3-on-surface);
}

/* ── Logo ─────────────────────────────────────────────────────────── */
.about-logo img {
  border-radius: 22px;
  box-shadow: 0 4px 20px var(--m3-shadow);
}

/* ── Title ────────────────────────────────────────────────────────── */
.about-title {
  margin-top: 16px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--m3-on-surface);
}
.about-title .accent {
  color: var(--color-primary);
}

/* ── Version Badges (stacked, prominent) ──────────────────────────── */
.about-versions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  padding: 0 12px;
}
.version-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 10px;
  background: var(--about-card-bg);
  cursor: pointer;
  transition: var(--transition-all);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.version-badge:hover {
  border-color: var(--color-primary);
  background: var(--about-card-hover-bg);
}
.version-badge:hover .copy-icon {
  opacity: 1;
  color: var(--color-primary);
}
.version-badge:active {
  transform: scale(0.98);
}
.version-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-on-surface-variant);
  letter-spacing: 0.3px;
}
.version-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--m3-on-surface);
  letter-spacing: 0.5px;
  margin-left: auto;
}
.copy-icon {
  opacity: 0.3;
  color: var(--m3-outline);
  transition: var(--transition-all);
  flex-shrink: 0;
}

/* ── Description ──────────────────────────────────────────────────── */
.about-desc {
  margin: 16px auto 0;
  max-width: 320px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--m3-on-surface-variant);
}

/* ── Footer ───────────────────────────────────────────────────────── */
.about-footer {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--m3-outline);
}
.about-link {
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: none;
}
.about-link:hover {
  text-decoration: underline;
}
.version-error {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
}

/* ── Staggered Entrance Animation ─────────────────────────────────── */
.stagger {
  opacity: 0;
  transform: translateY(12px);
}
.about-enter .stagger {
  animation: about-fade-up 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}
.about-enter .stagger-1 {
  animation-delay: 0.05s;
}
.about-enter .stagger-2 {
  animation-delay: 0.12s;
}
.about-enter .stagger-3 {
  animation-delay: 0.18s;
}
.about-enter .stagger-4 {
  animation-delay: 0.24s;
}
.about-enter .stagger-5 {
  animation-delay: 0.3s;
}
.about-enter .stagger-6 {
  animation-delay: 0.36s;
}

@keyframes about-fade-up {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ── Spinner ──────────────────────────────────────────────────────── */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.spinner {
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
  will-change: transform;
  contain: layout style paint;
}
.version-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
}
.version-badge--loading {
  cursor: default;
}
.version-badge--loading:hover {
  border-color: var(--m3-outline-variant);
  background: var(--about-card-bg);
}

/* ── Version Swap Transition ──────────────────────────────────────── */
.version-swap-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.version-swap-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.version-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.version-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
