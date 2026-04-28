<script setup lang="ts">
/** @fileoverview General preference tab: system info, language, update, appearance, startup & tray. */
import { ref, computed, watch, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useIpc } from '@/composables/useIpc'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { relaunch } from '@tauri-apps/plugin-process'
import { arch as osArch, version as osVersion } from '@tauri-apps/plugin-os'
import { usePlatform } from '@/composables/usePlatform'
import { getVersion as getAppVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { logger } from '@shared/logger'
import {
  buildGeneralForm,
  buildGeneralSystemConfig,
  transformGeneralForStore,
} from '@/composables/useGeneralPreference'
import { COLOR_SCHEMES, ENGINE_RPC_PORT } from '@shared/constants'
import { useSidecarVersions, type SidecarName } from '@shared/utils/sidecarVersion'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  NForm,
  NFormItem,
  NSelect,
  NSwitch,
  NButton,
  NDivider,
  NText,
  NCollapseTransition,
  NSpace,
  NTag,
  NRadioGroup,
  NRadioButton,
  NIcon,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import MTooltip from '@/components/common/MTooltip.vue'
import { CloudDownloadOutline, FolderOpenOutline, OpenOutline } from '@vicons/ionicons5'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'

/** Per-platform download landing pages and matching artifact names. Stays
 *  aligned with `scripts/fetch-sidecars.mjs` so users grab the same build
 *  flavor we ship. ffmpeg/ffprobe on macOS use upstream third-party builds
 *  (BtbN doesn't publish macOS); other platforms use BtbN. */
function resolveSidecarDownload(
  name: SidecarName,
  os: 'macos' | 'windows' | 'linux' | '',
  arch: string,
): { url: string; fileHint: string } {
  if (name === 'ytdlp') {
    if (os === 'macos') return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest', fileHint: 'yt-dlp_macos' }
    if (os === 'windows') return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest', fileHint: 'yt-dlp.exe' }
    if (os === 'linux') {
      const file = arch === 'aarch64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
      return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest', fileHint: file }
    }
    return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest', fileHint: 'yt-dlp_macos' }
  }

  // ffmpeg / ffprobe — same artifact source per platform.
  if (os === 'macos') {
    if (arch === 'aarch64') {
      const file = name === 'ffmpeg' ? 'ffmpeg arm64 (latest)' : 'ffprobe arm64 (latest)'
      return { url: 'https://www.osxexperts.net/', fileHint: file }
    }
    const file = name === 'ffmpeg' ? 'ffmpeg.zip (latest)' : 'ffprobe.zip (latest)'
    return { url: 'https://evermeet.cx/ffmpeg/', fileHint: file }
  }
  if (os === 'windows') {
    return {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest',
      fileHint: 'ffmpeg-n*-win64-gpl-*.zip',
    }
  }
  // linux
  const archSuffix = arch === 'aarch64' ? 'linuxarm64' : 'linux64'
  return {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest',
    fileHint: `ffmpeg-n*-${archSuffix}-gpl-*.tar.xz`,
  }
}

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { isMac, isLinux, platform: platformRef, platformLabel, archLabel: getArchLabel } = usePlatform()

// ─── System info card ────────────────────────────────────────────────
const sysArch = ref('')
const sysOsVersion = ref('')
const sysAppVersion = ref('')
const sysAria2Version = ref('')
const archLabelDisplay = computed(() => getArchLabel(sysArch.value))

const sidecarVersions = useSidecarVersions()
const sidecarRows: Array<{ label: string; name: SidecarName }> = [
  { label: 'yt-dlp', name: 'ytdlp' },
  { label: 'ffmpeg', name: 'ffmpeg' },
  { label: 'ffprobe', name: 'ffprobe' },
]

async function copyVersionToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('about.version-copied', { label }))
  } catch (e) {
    logger.debug('General.clipboard', `writeText failed: ${e}`)
  }
}

async function revealSidecarBinary(name: SidecarName) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_sidecar_binary', { name })
  } catch (e) {
    logger.warn('General.revealSidecar', e instanceof Error ? e.message : String(e))
    message.error(t('preferences.sidecar-reveal-failed'))
  }
}

function sidecarDownloadInfo(name: SidecarName) {
  const os = (platformRef.value || '') as 'macos' | 'windows' | 'linux' | ''
  return resolveSidecarDownload(name, os, sysArch.value)
}

async function openSidecarDownloadPage(name: SidecarName) {
  const { url } = sidecarDownloadInfo(name)
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch (e) {
    logger.warn('General.openSidecarDownload', e instanceof Error ? e.message : String(e))
    message.error(t('preferences.sidecar-open-page-failed'))
  }
}
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

const checkIntervalOptions = [
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
  { label: t('preferences.interval-monthly'), value: 720 },
  { label: t('preferences.interval-semi-annual'), value: 4320 },
  { label: t('preferences.interval-yearly'), value: 8760 },
]

function buildForm() {
  return buildGeneralForm(preferenceStore.config)
}

const { form, isDirty, handleSave, handleReset, patchSnapshot, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildGeneralSystemConfig,
  transformForStore: transformGeneralForStore,
  afterSave: async (f, prevConfig) => {
    // Locale change → restart prompt
    const prevLocale = prevConfig.locale || 'en-US'
    if (f.locale !== prevLocale) {
      const targetLocale = f.locale
      const isEn = targetLocale === 'en-US'
      const tt = (key: string) => t(key, {}, { locale: targetLocale })
      dialog.info({
        style: 'min-width: 520px',
        title: isEn
          ? tt('preferences.language-changed-title')
          : () =>
              h('div', { style: 'padding-left: 12px' }, [
                h('div', tt('preferences.language-changed-title')),
                h('div', 'Language Changed'),
              ]),
        content: isEn
          ? tt('preferences.language-changed-content')
          : () =>
              h('div', { style: 'padding: 10px 0' }, [
                h('p', { style: 'margin: 0' }, tt('preferences.language-changed-content')),
                h('p', { style: 'margin: 0' }, 'Please restart the application to apply the new language.'),
              ]),
        positiveText: isEn
          ? tt('preferences.language-changed-restart')
          : `${tt('preferences.language-changed-restart')} · Restart Now`,
        negativeText: isEn
          ? tt('preferences.language-changed-later')
          : `${tt('preferences.language-changed-later')} · Later`,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          relaunch()
        },
      })
    }

    // Sync autostart state immediately on save
    if (f.openAtLogin !== !!prevConfig.openAtLogin) {
      try {
        const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
        const currentlyEnabled = await isEnabled()
        if (f.openAtLogin && !currentlyEnabled) await enable()
        else if (!f.openAtLogin && currentlyEnabled) await disable()
      } catch (e) {
        logger.error('General.autostart', e)
      }
    }
  },
})

// One-shot sync: if async OS locale detection completes after mount, patch the form.
const stopLocaleSync = watch(
  () => preferenceStore.config.locale,
  (detected) => {
    if (detected && form.value.locale === 'en-US' && detected !== 'en-US') {
      form.value.locale = detected
      patchSnapshot({ locale: detected } as Partial<typeof form.value>)
      stopLocaleSync()
    }
  },
)

// ── Instant color-scheme application ─────────────────────────────────
watch(
  () => form.value.colorScheme,
  (newId, oldId) => {
    if (!newId || newId === oldId) return
    preferenceStore.updateAndSave({ colorScheme: newId })
    patchSnapshot({ colorScheme: newId } as Partial<typeof form.value>)
    const scheme = COLOR_SCHEMES.find((s) => s.id === newId)
    if (scheme) {
      message.success(t('preferences.color-scheme-switched', { name: t(scheme.labelKey) }))
    }
  },
)

// ── Instant theme application ────────────────────────────────────────
watch(
  () => form.value.theme,
  (newTheme, oldTheme) => {
    if (!newTheme || newTheme === oldTheme) return
    preferenceStore.updateAndSave({ theme: newTheme as 'auto' | 'light' | 'dark' })
    patchSnapshot({ theme: newTheme } as Partial<typeof form.value>)
  },
)

// ── Lightweight mode ↔ Minimize-to-tray linkage ─────────────────────
watch(
  () => form.value.lightweightMode,
  (enabled) => {
    if (enabled && !form.value.minimizeToTrayOnClose) {
      form.value.minimizeToTrayOnClose = true
    }
  },
)
watch(
  () => form.value.minimizeToTrayOnClose,
  (enabled) => {
    if (!enabled && form.value.lightweightMode) {
      form.value.lightweightMode = false
    }
  },
)

const localeOptions = [
  { label: 'English', value: 'en-US' },
  { label: '简体中文 · Chinese Simplified', value: 'zh-CN' },
  { label: '繁體中文 · Chinese Traditional', value: 'zh-TW' },
  { label: '日本語 · Japanese', value: 'ja' },
  { label: '한국어 · Korean', value: 'ko' },
  { label: 'Français · French', value: 'fr' },
  { label: 'Deutsch · German', value: 'de' },
  { label: 'Español · Spanish', value: 'es' },
  { label: 'Português · Portuguese (Brazil)', value: 'pt-BR' },
  { label: 'Русский · Russian', value: 'ru' },
  { label: 'Türkçe · Turkish', value: 'tr' },
  { label: 'العربية · Arabic', value: 'ar' },
  { label: 'Български · Bulgarian', value: 'bg' },
  { label: 'Català · Catalan', value: 'ca' },
  { label: 'Ελληνικά · Greek', value: 'el' },
  { label: 'فارسی · Persian', value: 'fa' },
  { label: 'Magyar · Hungarian', value: 'hu' },
  { label: 'Bahasa Indonesia · Indonesian', value: 'id' },
  { label: 'Italiano · Italian', value: 'it' },
  { label: 'Norsk Bokmål · Norwegian', value: 'nb' },
  { label: 'Nederlands · Dutch', value: 'nl' },
  { label: 'Polski · Polish', value: 'pl' },
  { label: 'Română · Romanian', value: 'ro' },
  { label: 'ไทย · Thai', value: 'th' },
  { label: 'Українська · Ukrainian', value: 'uk' },
  { label: 'Tiếng Việt · Vietnamese', value: 'vi' },
]

const themeOptions = computed(() => [
  { label: t('preferences.theme-auto'), value: 'auto' },
  { label: t('preferences.theme-light'), value: 'light' },
  { label: t('preferences.theme-dark'), value: 'dark' },
])

function handleCheckUpdate() {
  updateDialogRef.value?.open()
}

const { restartEngine } = useEngineRestart()

function handleManualRestart() {
  const port = (preferenceStore.config.rpcListenPort as number) || ENGINE_RPC_PORT
  const secret = (preferenceStore.config.rpcSecret as string) || ''
  const d = dialog.warning({
    title: t('preferences.engine-restart-title'),
    content: t('preferences.engine-restart-manual-confirm'),
    positiveText: t('preferences.engine-restart-now'),
    negativeText: t('preferences.engine-restart-later'),
    maskClosable: false,
    onPositiveClick: async () => {
      d.loading = true
      d.negativeText = ''
      d.closable = false
      message.info(t('preferences.engine-restarting'))
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    },
  })
}

// ── Browser extension installer ────────────────────────────────────
const installingExtension = ref(false)

async function installBrowserExtension() {
  if (installingExtension.value) return
  installingExtension.value = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const dest = await invoke<string>('install_browser_extension')

    // Pre-copy the path: Chrome's "Load unpacked" file dialog opens fresh
    // and ignores any Finder window we revealed, so the only reliable way
    // to land on the right folder is for the user to paste the path via
    // Cmd+Shift+G (macOS) / Ctrl+L (Windows/Linux) inside that dialog.
    let copied = true
    try {
      await navigator.clipboard.writeText(dest)
    } catch (e) {
      copied = false
      logger.warn('General.copyExtensionPath', e instanceof Error ? e.message : String(e))
    }
    await invoke('show_item_in_dir', { path: dest })

    const pasteTipKey = isMac.value
      ? 'preferences.browser-extension-paste-tip-mac'
      : 'preferences.browser-extension-paste-tip-other'

    dialog.success({
      title: t('preferences.browser-extension-installed-title'),
      content: () =>
        h('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, [
          h(
            'div',
            { style: copied ? 'color:var(--m3-success);' : '' },
            copied
              ? t('preferences.browser-extension-path-auto-copied')
              : t('preferences.browser-extension-installed-intro'),
          ),
          h('ol', { style: 'padding-left:20px;margin:0;line-height:1.7;' }, [
            h('li', t('preferences.browser-extension-step-1')),
            h('li', t('preferences.browser-extension-step-2')),
            h('li', t('preferences.browser-extension-step-3')),
            h('li', t(pasteTipKey)),
          ]),
          h('div', { style: 'font-family:Menlo,monospace;font-size:12px;opacity:0.85;word-break:break-all;' }, dest),
        ]),
      positiveText: t('preferences.browser-extension-copy-path'),
      negativeText: t('app.dismiss'),
      onPositiveClick: async () => {
        try {
          await navigator.clipboard.writeText(dest)
          message.success(t('preferences.browser-extension-path-copied'))
        } catch (e) {
          logger.warn('General.copyExtensionPath', e instanceof Error ? e.message : String(e))
        }
      },
    })
  } catch (e) {
    logger.error('General.installBrowserExtension', e)
    message.error(t('preferences.browser-extension-install-failed'))
  } finally {
    installingExtension.value = false
  }
}

onMounted(async () => {
  try {
    sysArch.value = osArch()
  } catch (e) {
    logger.debug('General.arch', e)
  }
  try {
    sysOsVersion.value = osVersion()
  } catch (e) {
    logger.debug('General.osVersion', e)
  }
  try {
    sysAppVersion.value = await getAppVersion()
  } catch (e) {
    logger.debug('General.appVersion', e)
  }
  try {
    const info = await getAria2Version()
    sysAria2Version.value = info.version
  } catch (e) {
    logger.debug('General.aria2Version', e)
  }
  // Sidecar versions are prefetched at startup by main.ts + backend; the
  // reactive `sidecarVersions` handle already reflects whatever landed.
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <!-- ① System info -->
      <NDivider title-placement="left">{{ t('preferences.system-info') }}</NDivider>
      <NFormItem :label="t('preferences.detected-platform')">
        <NSpace :size="8">
          <NTag type="info" round size="medium">{{ platformLabel }}</NTag>
          <NTag type="success" round size="medium">{{ archLabelDisplay }}</NTag>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('about.app-version')">
        <MTooltip>
          <template #trigger>
            <button
              class="sysinfo-ver-badge"
              @click="copyVersionToClipboard(`Motrix ZJ v${sysAppVersion}`, 'Motrix ZJ')"
            >
              <span class="sysinfo-ver-value">v{{ sysAppVersion || '\u2014' }}</span>
              <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
              </svg>
            </button>
          </template>
          {{ t('about.click-to-copy') }}
        </MTooltip>
      </NFormItem>
      <NFormItem :label="t('about.aria2-version')">
        <MTooltip v-if="sysAria2Version">
          <template #trigger>
            <button class="sysinfo-ver-badge" @click="copyVersionToClipboard(`aria2 v${sysAria2Version}`, 'aria2')">
              <span class="sysinfo-ver-value">v{{ sysAria2Version }}</span>
              <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
              </svg>
            </button>
          </template>
          {{ t('about.click-to-copy') }}
        </MTooltip>
        <div v-else class="sysinfo-ver-badge sysinfo-ver-badge--muted">
          <span class="sysinfo-ver-muted">{{ t('about.unavailable') }}</span>
        </div>
      </NFormItem>
      <NFormItem v-for="row in sidecarRows" :key="row.name" :label="row.label">
        <NSpace :size="6" align="center">
          <MTooltip v-if="sidecarVersions[row.name]">
            <template #trigger>
              <button
                class="sysinfo-ver-badge"
                @click="copyVersionToClipboard(`${row.label} v${sidecarVersions[row.name]}`, row.label)"
              >
                <span class="sysinfo-ver-value">v{{ sidecarVersions[row.name] }}</span>
                <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
                </svg>
              </button>
            </template>
            {{ t('about.click-to-copy') }}
          </MTooltip>
          <div v-else class="sysinfo-ver-badge sysinfo-ver-badge--muted">
            <span class="sysinfo-ver-muted">{{ t('about.unavailable') }}</span>
          </div>
          <MTooltip>
            <template #trigger>
              <button class="sidecar-action-btn" type="button" @click="revealSidecarBinary(row.name)">
                <NIcon :size="16"><FolderOpenOutline /></NIcon>
              </button>
            </template>
            {{ t('preferences.sidecar-reveal-tooltip') }}
          </MTooltip>
          <MTooltip>
            <template #trigger>
              <button class="sidecar-action-btn" type="button" @click="openSidecarDownloadPage(row.name)">
                <NIcon :size="16"><OpenOutline /></NIcon>
              </button>
            </template>
            <div style="max-width: 320px; line-height: 1.5">
              <div>{{ t('preferences.sidecar-download-tooltip') }}</div>
              <div style="margin-top: 4px">
                <span style="opacity: 0.75">{{ t('preferences.sidecar-download-pick') }}</span>
                <code
                  style="
                    margin-left: 4px;
                    padding: 1px 6px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    font-family: Menlo, monospace;
                  "
                  >{{ sidecarDownloadInfo(row.name).fileHint }}</code
                >
              </div>
            </div>
          </MTooltip>
        </NSpace>
      </NFormItem>

      <!-- ② Language -->
      <NDivider title-placement="left">
        {{ locale === 'en-US' ? t('preferences.language') : `${t('preferences.language')} · Language` }}
      </NDivider>
      <NFormItem
        :label="
          locale === 'en-US'
            ? t('preferences.select-language')
            : `${t('preferences.select-language')} · Select Language`
        "
      >
        <NSelect v-model:value="form.locale" :options="localeOptions" style="width: 280px" />
      </NFormItem>

      <!-- ③ Auto Update (hidden) -->
      <template v-if="false">
        <NDivider title-placement="left">{{ t('preferences.auto-update') }}</NDivider>
        <NFormItem :label="t('preferences.auto-check-update')">
          <NSwitch v-model:value="form.autoCheckUpdate" />
        </NFormItem>
        <NCollapseTransition :show="form.autoCheckUpdate" class="collapse-indent">
          <NFormItem :label="t('preferences.check-frequency')">
            <NSelect
              v-model:value="form.autoCheckUpdateInterval"
              :options="checkIntervalOptions"
              style="width: 180px"
            />
          </NFormItem>
        </NCollapseTransition>
        <NFormItem :label="t('preferences.update-channel')">
          <NRadioGroup
            v-model:value="form.updateChannel"
            size="small"
            @update:value="
              async (v: string) => {
                const ok = await preferenceStore.updateAndSave({ updateChannel: v as 'stable' | 'beta' })
                if (ok) {
                  patchSnapshot({ updateChannel: v } as Partial<typeof form.value>)
                }
              }
            "
          >
            <NRadioButton value="stable">{{ t('preferences.update-channel-stable') }}</NRadioButton>
            <NRadioButton value="beta">{{ t('preferences.update-channel-beta') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.last-check-update-time')">
          <div style="display: flex; align-items: center; gap: 16px">
            <NButton size="small" @click="handleCheckUpdate">
              <template #icon>
                <NIcon :size="14"><CloudDownloadOutline /></NIcon>
              </template>
              {{ t('app.check-updates-now') }}
            </NButton>
            <NText v-if="preferenceStore.config.lastCheckUpdateTime" depth="3" style="font-size: 13px">
              {{ new Date(preferenceStore.config.lastCheckUpdateTime).toLocaleString() }}
            </NText>
            <NText v-else depth="3" style="font-size: 13px">—</NText>
          </div>
        </NFormItem>
        <UpdateDialog ref="updateDialogRef" />
      </template>

      <!-- ④ Appearance -->
      <NDivider title-placement="left">{{ t('preferences.appearance-section') }}</NDivider>
      <NFormItem :label="t('preferences.appearance')">
        <NSelect v-model:value="form.theme" :options="themeOptions" style="width: 200px" />
      </NFormItem>
      <NFormItem :label="t('preferences.color-scheme')">
        <div class="color-scheme-picker">
          <MTooltip v-for="scheme in COLOR_SCHEMES" :key="scheme.id">
            <template #trigger>
              <button
                class="color-swatch"
                :class="{ active: form.colorScheme === scheme.id }"
                :style="{ '--swatch-color': scheme.seed }"
                @click="form.colorScheme = scheme.id"
              >
                <svg v-if="form.colorScheme === scheme.id" class="swatch-check" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 8.5L6.5 11L12 5"
                    stroke="white"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </template>
            {{ t(scheme.labelKey) }}
          </MTooltip>
        </div>
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.dock-badge-speed')">
        <NSwitch v-model:value="form.dockBadgeSpeed" />
      </NFormItem>

      <!-- ⑪ Startup & Tray -->
      <NDivider title-placement="left">{{ t('preferences.startup-behavior') }}</NDivider>
      <NFormItem :label="t('preferences.open-at-login')">
        <NSwitch v-model:value="form.openAtLogin" />
      </NFormItem>
      <NCollapseTransition :show="form.openAtLogin" class="collapse-indent">
        <NFormItem :label="t('preferences.auto-hide-window')">
          <NSwitch v-model:value="form.autoHideWindow" />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.keep-window-state')">
        <NSwitch v-model:value="form.keepWindowState" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-resume-all')">
        <NSwitch v-model:value="form.resumeAllWhenAppLaunched" />
      </NFormItem>
      <NDivider title-placement="left">{{ t('preferences.tray-and-dock') }}</NDivider>
      <NFormItem :label="t('preferences.minimize-to-tray-on-close')">
        <NSwitch v-model:value="form.minimizeToTrayOnClose" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.hide-dock-on-minimize')">
        <NSwitch v-model:value="form.hideDockOnMinimize" />
      </NFormItem>
      <NFormItem v-if="isMac || isLinux" :label="t('preferences.tray-speedometer')">
        <NSwitch v-model:value="form.traySpeedometer" />
      </NFormItem>
      <NFormItem :label="t('preferences.show-progress-bar')">
        <NSwitch v-model:value="form.showProgressBar" />
      </NFormItem>
      <NFormItem :label="t('preferences.lightweight-mode')">
        <NSwitch v-model:value="form.lightweightMode" />
      </NFormItem>
      <NText
        depth="3"
        style="font-size: 12px; display: block; margin-top: -8px; margin-bottom: 8px; padding-left: 50px"
      >
        ⓘ {{ t('preferences.lightweight-mode') }}:
        {{ t('preferences.lightweight-mode-hint') }}
      </NText>

      <!-- ⑬ Browser Extension -->
      <NDivider title-placement="left">{{ t('preferences.browser-extension-section') }}</NDivider>
      <NFormItem :label="t('preferences.browser-extension-action')">
        <NButton type="primary" :loading="installingExtension" @click="installBrowserExtension">
          {{ t('preferences.browser-extension-install') }}
        </NButton>
      </NFormItem>
      <NText
        depth="3"
        style="font-size: 12px; display: block; margin-top: -8px; margin-bottom: 8px; padding-left: 50px"
      >
        ⓘ {{ t('preferences.browser-extension-hint') }}
      </NText>
    </NForm>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.preference-form-wrapper {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.form-preference {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}

/* ── Sidecar action buttons ────────────────────────────────────────── */
.sidecar-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--m3-outline-variant, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: var(--about-card-bg, rgba(255, 255, 255, 0.03));
  color: var(--m3-on-surface-variant, rgba(255, 255, 255, 0.7));
  cursor: pointer;
  transition: var(--transition-all, 0.2s ease);
}
.sidecar-action-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--about-card-hover-bg, rgba(255, 255, 255, 0.06));
}
.sidecar-action-btn:active {
  transform: scale(0.95);
}

/* ── System info version badge ─────────────────────────────────────── */
.sysinfo-ver-badge {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--m3-outline-variant, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: var(--about-card-bg, rgba(255, 255, 255, 0.03));
  cursor: pointer;
  transition: var(--transition-all, 0.2s ease);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.sysinfo-ver-badge:hover {
  border-color: var(--color-primary);
  background: var(--about-card-hover-bg, rgba(255, 255, 255, 0.06));
}
.sysinfo-ver-badge:hover .sysinfo-ver-copy {
  opacity: 0.7;
}
.sysinfo-ver-badge:active {
  transform: scale(0.97);
}
.sysinfo-ver-value {
  font-size: 13px;
  font-weight: 520;
  color: var(--m3-on-surface, rgba(255, 255, 255, 0.9));
  letter-spacing: 0.3px;
}
.sysinfo-ver-copy {
  opacity: 0.35;
  margin-left: auto;
  color: var(--m3-on-surface-variant, rgba(255, 255, 255, 0.5));
  transition: var(--transition-all, 0.2s ease);
  flex-shrink: 0;
}
.sysinfo-ver-badge--muted {
  cursor: default;
}
.sysinfo-ver-badge--muted:hover {
  border-color: var(--m3-outline-variant, rgba(255, 255, 255, 0.08));
  background: var(--about-card-bg, rgba(255, 255, 255, 0.03));
}
.sysinfo-ver-muted {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline, rgba(255, 255, 255, 0.38));
  letter-spacing: 0.3px;
}

/* ── Collapse indent ─────────────────────────────────────────────── */
.form-preference :deep(.collapse-indent) {
  position: relative;
  margin-left: 16px;
}

/* ── Color Scheme Swatch Picker ───────────────────────────────────── */
.color-scheme-picker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.color-swatch {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: var(--swatch-color);
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    box-shadow 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  padding: 0;
}
.color-swatch:hover {
  transform: scale(1.18);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.color-swatch:active {
  transform: scale(1.05);
}
.color-swatch.active {
  border-color: var(--m3-on-surface, #fff);
  box-shadow:
    0 0 0 2px var(--swatch-color),
    0 2px 8px rgba(0, 0, 0, 0.25);
}
.swatch-check {
  width: 14px;
  height: 14px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}
</style>
