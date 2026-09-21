<script setup lang="ts">
/** @fileoverview General preference tab: system info, language, update, appearance, startup & tray. */
import { ref, computed, watch, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { useAppStore } from '@/stores/app'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineStore } from '@/stores/engine'
import { relaunch } from '@tauri-apps/plugin-process'
import { arch as osArch, version as osVersion } from '@tauri-apps/plugin-os'
import { usePlatform } from '@/composables/usePlatform'
import { getVersion as getAppVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { getLocale } from 'tauri-plugin-locale-api'
import { resolveSystemLocale } from '@shared/utils/locale'
import { loadLocale } from '@/composables/useLocale'
import { isSupportedLocale, LOCALE_CATALOG, SUPPORTED_LOCALES } from '@shared/localeCatalog'
import { logger } from '@shared/logger'
import { writeAppClipboardText } from '@shared/utils'
import { buildGeneralForm } from '@/composables/useGeneralPreference'
import { COLOR_SCHEMES, CUSTOM_COLOR_SCHEME_ID } from '@shared/constants'
import { normalizeCustomColorScheme } from '@shared/utils/colorSchemeConfig'
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
  NColorPicker,
  NIcon,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import MTooltip from '@/components/common/MTooltip.vue'
import { CloudDownloadOutline, FolderOpenOutline, OpenOutline } from '@vicons/ionicons5'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import type { UpdateChannel } from '@shared/types'
import PreferenceHintLabel from './PreferenceHintLabel.vue'

/** Per-platform direct-download URLs and matching artifact names. Aligned
 *  with `scripts/fetch-sidecars.mjs` so the link button hands the user the
 *  exact file we ship — no asset list to navigate.
 *  - GitHub `releases/latest/download/<asset>` redirects are stable.
 *  - BtbN's `tag/latest` is a rolling tag — keep the n7.1 filename in
 *    sync with fetch-sidecars when ffmpeg majors bump.
 *  - macOS Apple Silicon ffmpeg/ffprobe come from osxexperts.net which
 *    only publishes a static index page, so we open the page and tell
 *    the user which filename pattern to grab. */
function resolveSidecarDownload(
  name: SidecarName,
  os: 'macos' | 'windows' | 'linux' | '',
  arch: string,
): { url: string; fileHint: string; direct: boolean } {
  if (name === 'ytdlp') {
    const asset =
      os === 'macos'
        ? 'yt-dlp_macos'
        : os === 'windows'
          ? 'yt-dlp.exe'
          : os === 'linux' && arch === 'aarch64'
            ? 'yt-dlp_linux_aarch64'
            : 'yt-dlp_linux'
    return {
      url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
      fileHint: asset,
      direct: true,
    }
  }

  // ffmpeg / ffprobe
  if (os === 'macos') {
    if (arch === 'aarch64') {
      // osxexperts.net only publishes a static index page; tell users
      // which filename to grab. <NN> is the ffmpeg major (e.g. 81 = 8.1).
      const hint = name === 'ffmpeg' ? 'ffmpeg<NN>arm.zip' : 'ffprobe<NN>arm.zip'
      return { url: 'https://www.osxexperts.net/', fileHint: hint, direct: false }
    }
    // evermeet.cx exposes stable getrelease endpoints that always serve
    // the latest build — same as fetch-sidecars.mjs.
    const path = name === 'ffmpeg' ? 'ffmpeg/getrelease/zip' : 'ffmpeg/getrelease/ffprobe/zip'
    return {
      url: `https://evermeet.cx/${path}`,
      fileHint: `${name}.zip`,
      direct: true,
    }
  }
  if (os === 'windows') {
    const file = 'ffmpeg-n7.1-latest-win64-gpl-7.1.zip'
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${file}`,
      fileHint: file,
      direct: true,
    }
  }
  // linux
  const archSuffix = arch === 'aarch64' ? 'linuxarm64' : 'linux64'
  const file = `ffmpeg-n7.1-latest-${archSuffix}-gpl-7.1.tar.xz`
  return {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${file}`,
    fileHint: file,
    direct: true,
  }
}

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const appStore = useAppStore()
const dialog = useDialog()
const message = useAppMessage()
const { isMac, isLinux, platform: platformRef, platformLabel, archLabel: getArchLabel } = usePlatform()

// ─── System info card ────────────────────────────────────────────────
const sysArch = ref('')
const sysOsVersion = ref('')
const sysAppVersion = ref('')
const sysAria2Version = ref('')
const detectedLocaleCode = ref('en-US')
const archLabelDisplay = computed(() => getArchLabel(sysArch.value))

const sidecarVersions = useSidecarVersions()
const sidecarRows: Array<{ label: string; name: SidecarName }> = [
  { label: 'yt-dlp', name: 'ytdlp' },
  { label: 'ffmpeg', name: 'ffmpeg' },
  { label: 'ffprobe', name: 'ffprobe' },
]

async function copyVersionToClipboard(text: string, label: string) {
  try {
    await writeAppClipboardText(text)
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
  { label: t('preferences.interval-every-startup'), value: 0 },
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
  { label: t('preferences.interval-monthly'), value: 720 },
  { label: t('preferences.interval-semi-annual'), value: 4320 },
  { label: t('preferences.interval-yearly'), value: 8760 },
]

const CUSTOM_COLOR_SWATCHES = ['#F59E0B', '#2563EB', '#14B8A6', '#DC2626', '#9333EA', '#4B5563']

function buildForm() {
  return buildGeneralForm(preferenceStore.config)
}

const { form, isDirty, handleSave, handleReset, patchSnapshot, resetSnapshot } = usePreferenceForm({
  buildForm,
  afterSave: async (f, prevConfig) => {
    // Locale change → restart prompt
    const prevLocale = prevConfig.locale || 'auto'
    if (f.locale !== prevLocale) {
      // Determine the actual target locale for bilingual dialog rendering.
      const targetLocale = isSupportedLocale(f.locale)
        ? f.locale
        : resolveSystemLocale(detectedLocaleCode.value, SUPPORTED_LOCALES)
      const isEn = targetLocale === 'en-US'
      // Locale messages are lazy-loaded — pull in the target locale so the
      // dialog can render in it (falls back to English if loading fails).
      if (!isEn) await loadLocale(targetLocale)
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
          await engineStore.stop('appRelaunch')
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

// Note: the legacy one-shot locale sync watcher has been removed.
// With 'auto' as an explicit option, there is no async race condition
// to handle — the form correctly initialises with 'auto' from config.

// ── Instant color-scheme application ─────────────────────────────────
function handlePresetColorScheme(scheme: (typeof COLOR_SCHEMES)[number]): void {
  if (form.value.colorScheme === scheme.id) return

  form.value.colorScheme = scheme.id
  preferenceStore.updateAndSave({ colorScheme: scheme.id, customColorScheme: form.value.customColorScheme })
  patchSnapshot({ colorScheme: scheme.id } as Partial<typeof form.value>)
  message.success(t('preferences.color-scheme-switched', { name: t(scheme.labelKey) }))
}

async function handleCustomColorChange(value: string | null): Promise<void> {
  const color = normalizeCustomColorScheme(value)
  if (form.value.colorScheme === CUSTOM_COLOR_SCHEME_ID && form.value.customColorScheme === color) return

  form.value.customColorScheme = color
  form.value.colorScheme = CUSTOM_COLOR_SCHEME_ID
  patchSnapshot({ colorScheme: CUSTOM_COLOR_SCHEME_ID, customColorScheme: color } as Partial<typeof form.value>)
  await preferenceStore.updateAndSave({ colorScheme: CUSTOM_COLOR_SCHEME_ID, customColorScheme: color })
}

function handleCustomColorComplete(value: string): void {
  const color = normalizeCustomColorScheme(value)
  message.success(t('preferences.color-scheme-switched', { name: color }))
}

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

const localeOptions = LOCALE_CATALOG.map(({ code, label }) => ({ label, value: code }))

/** Dynamic label for the 'auto' option. */
const autoLocaleLabel = computed(() => {
  return locale.value === 'en-US' ? t('preferences.follow-system') : `${t('preferences.follow-system')} · Follow System`
})

/** Full locale options with 'Follow System' prepended as the first choice. */
const fullLocaleOptions = computed(() => [{ label: autoLocaleLabel.value, value: 'auto' }, ...localeOptions])

const themeOptions = computed(() => [
  { label: t('preferences.theme-auto'), value: 'auto' },
  { label: t('preferences.theme-light'), value: 'light' },
  { label: t('preferences.theme-dark'), value: 'dark' },
])

const taskCardModeOptions = computed(() => [
  { label: t('preferences.task-card-mode-full'), value: 'full' },
  { label: t('preferences.task-card-mode-compact'), value: 'compact' },
])

function handleCheckUpdate() {
  appStore.requestUpdateCheck()
}

const engineStore = useEngineStore()

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
  try {
    const raw = (await getLocale()) || 'en-US'
    detectedLocaleCode.value = resolveSystemLocale(raw, SUPPORTED_LOCALES)
  } catch (e) {
    logger.debug('General.detectLocale', e)
  }
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
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
              <button
                class="sysinfo-ver-badge"
                @click="copyVersionToClipboard(`Aria2 Next v${sysAria2Version}`, 'Aria2 Next')"
              >
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
                    <path
                      d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                      stroke="currentColor"
                      stroke-width="2"
                    />
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
              <div class="sidecar-download-tooltip">
                <div>
                  {{
                    sidecarDownloadInfo(row.name).direct
                      ? t('preferences.sidecar-download-tooltip-direct')
                      : t('preferences.sidecar-download-tooltip-page')
                  }}
                </div>
                <div class="sidecar-download-file">
                  <span>
                    {{
                      sidecarDownloadInfo(row.name).direct
                        ? t('preferences.sidecar-download-file')
                        : t('preferences.sidecar-download-pick')
                    }}
                  </span>
                  <code>{{ sidecarDownloadInfo(row.name).fileHint }}</code>
                </div>
                <div class="sidecar-download-hint">{{ t('preferences.sidecar-download-replace-hint') }}</div>
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
          <NSelect
            v-model:value="form.locale"
            :options="fullLocaleOptions"
            class="pref-control-auto pref-control-language"
          />
        </NFormItem>

        <!-- ③ Auto Update (disabled in this fork) -->
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
                class="pref-control-auto"
              />
            </NFormItem>
          </NCollapseTransition>
          <NFormItem :label="t('preferences.update-channel')">
            <NRadioGroup
              v-model:value="form.updateChannel"
              size="small"
              @update:value="
                async (v: string) => {
                  const ok = await preferenceStore.updateAndSave({ updateChannel: v as UpdateChannel })
                  if (ok) {
                    patchSnapshot({ updateChannel: v } as Partial<typeof form.value>)
                  }
                }
              }
            "
          >
            <NRadioButton value="stable">{{ t('preferences.update-channel-stable') }}</NRadioButton>
            <NRadioButton value="beta">{{ t('preferences.update-channel-beta') }}</NRadioButton>
            <NRadioButton value="latest">{{ t('preferences.update-channel-latest') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.last-check-update-time')">
          <div class="pref-inline-row">
            <NButton size="small" @click="handleCheckUpdate">
              <template #icon>
                <NIcon :size="14"><CloudDownloadOutline /></NIcon>
              </template>
              {{ t('app.check-updates-now') }}
            </NButton>
            <NText v-if="preferenceStore.config.lastCheckUpdateTime" depth="3" class="pref-inline-row__meta">
              {{ new Date(preferenceStore.config.lastCheckUpdateTime).toLocaleString() }}
            </NText>
            <NText v-else depth="3" class="pref-inline-row__meta">—</NText>
          </div>
        </NFormItem>
        <UpdateDialog ref="updateDialogRef" />
        <!-- ④ Appearance -->
        <NDivider title-placement="left">{{ t('preferences.appearance-section') }}</NDivider>
        <NFormItem :label="t('preferences.appearance')">
          <NSelect v-model:value="form.theme" :options="themeOptions" class="pref-control-auto" />
        </NFormItem>
        <NFormItem :label="t('preferences.color-scheme')">
          <div class="color-scheme-picker">
            <MTooltip v-for="scheme in COLOR_SCHEMES" :key="scheme.id">
              <template #trigger>
                <button
                  class="color-swatch"
                  :class="{ active: form.colorScheme === scheme.id }"
                  :style="{ '--swatch-color': scheme.seed }"
                  @click="handlePresetColorScheme(scheme)"
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
        <NFormItem :label="t('preferences.custom-color-scheme')">
          <div class="custom-color-picker-wrap">
            <NColorPicker
              :value="form.customColorScheme"
              :modes="['hex']"
              :show-alpha="false"
              :show-preview="true"
              :swatches="CUSTOM_COLOR_SWATCHES"
              class="custom-color-picker"
              @update:value="handleCustomColorChange"
              @complete="handleCustomColorComplete"
            />
          </div>
        </NFormItem>
        <NFormItem :label="t('preferences.task-card-mode')">
          <NRadioGroup v-model:value="form.taskCardMode">
            <NRadioButton v-for="option in taskCardModeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.reduce-motion')">
          <NSwitch v-model:value="form.reduceMotion" />
        </NFormItem>
        <NFormItem :label="t('preferences.sidebar-task-counts')">
          <NSwitch v-model:value="form.sidebarTaskCounts" />
        </NFormItem>
        <NFormItem :label="t('preferences.task-list-watermark')">
          <NSwitch v-model:value="form.taskListWatermark" />
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
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.lightweight-mode')"
              :hint="t('preferences.lightweight-mode-hint')"
            />
          </template>
          <NSwitch v-model:value="form.lightweightMode" />
        </NFormItem>

        <!-- ⑫ Browser Extension -->
        <NDivider title-placement="left">{{ t('preferences.browser-extension-section') }}</NDivider>
        <NFormItem :label="t('preferences.browser-extension-action')">
          <div class="browser-extension-action">
            <NButton type="primary" :loading="installingExtension" @click="installBrowserExtension">
              {{ t('preferences.browser-extension-install') }}
            </NButton>
            <NText depth="3" class="browser-extension-hint">
              {{ t('preferences.browser-extension-hint') }}
            </NText>
          </div>
        </NFormItem>
      </NForm>
    </div>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" />
  </div>
</template>

<style scoped>
.pref-control-language {
  min-width: 260px;
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
.sidecar-download-tooltip {
  max-width: 340px;
  line-height: 1.5;
}
.sidecar-download-file {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 4px;
}
.sidecar-download-file span {
  opacity: 0.75;
}
.sidecar-download-file code {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  font-size: 11px;
  word-break: break-all;
}
.sidecar-download-hint {
  margin-top: 5px;
  font-size: 11px;
  opacity: 0.65;
}

.browser-extension-action {
  display: flex;
  align-items: center;
  gap: 12px;
}
.browser-extension-hint {
  font-size: 12px;
}

/* ── System info version badge ─────────────────────────────────────── */
.sysinfo-ver-badge {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 8px;
  background: var(--about-card-bg);
  cursor: pointer;
  transition: var(--transition-all);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.sysinfo-ver-badge:hover {
  border-color: var(--m3-primary);
  background: var(--about-card-hover-bg);
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
  color: var(--m3-on-surface);
  letter-spacing: 0.3px;
}
.sysinfo-ver-copy {
  opacity: 0.35;
  margin-left: auto;
  color: var(--m3-on-surface-variant);
  transition: var(--transition-all);
  flex-shrink: 0;
}
.sysinfo-ver-badge--muted {
  cursor: default;
}
.sysinfo-ver-badge--muted:hover {
  border-color: var(--m3-outline-variant);
  background: var(--about-card-bg);
}
.sysinfo-ver-muted {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
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
  border-color: var(--m3-on-surface);
  box-shadow:
    0 0 0 2px var(--swatch-color),
    0 2px 8px rgba(0, 0, 0, 0.25);
}
.custom-color-picker-wrap {
  width: 100px;
  flex: 0 0 auto;
  display: inline-block;
}
.custom-color-picker {
  width: 100%;
}
.swatch-check {
  width: 14px;
  height: 14px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}
</style>
