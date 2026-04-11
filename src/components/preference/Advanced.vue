<script setup lang="ts">
/** @fileoverview Advanced preference form: proxy, tracker, RPC, port, and user-agent settings. */
import { ref, computed, nextTick, onMounted, h } from 'vue'
import type { VNodeChild } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { usePlatform } from '@/composables/usePlatform'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { useTaskStore } from '@/stores/task'
import { useHistoryStore } from '@/stores/history'
import { useAdvancedActions } from '@/composables/useAdvancedActions'
import { relaunch } from '@tauri-apps/plugin-process'
import { useIpc } from '@/composables/useIpc'
import { appDataDir, appLogDir, join } from '@tauri-apps/api/path'
import { LOG_LEVELS, PROXY_SCOPE_OPTIONS } from '@shared/constants'
import type { SystemProxyInfo, ProxyMode } from '@shared/types'
import { convertTrackerDataToLine } from '@shared/utils/tracker'
import { SYNC_MIN_DURATION } from '@shared/timing'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  isValidTrackerSourceUrl,
  randomRpcPort,
  randomBtPort,
  randomDhtPort,
} from '@/composables/useAdvancedPreference'
import userAgentMap from '@shared/ua'
import { hasUnsafeHeaderChars, sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NButtonGroup,
  NSpace,
  NDivider,
  NIcon,
  NModal,
  NDataTable,
  NEmpty,
  NRadioGroup,
  NRadioButton,
  useDialog,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  SyncOutline,
  DiceOutline,
  DownloadOutline,
  FolderOpenOutline,
  TrashOutline,
  CopyOutline,
  AddCircleOutline,
  CloseCircleOutline,
} from '@vicons/ionicons5'
import { logger } from '@shared/logger'
import PreferenceActionBar from './PreferenceActionBar.vue'
import { trackerSourceOptions } from '@shared/constants/trackerSources'

const { restartEngine } = useEngineRestart()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const historyStore = useHistoryStore()
const message = useAppMessage()
const dialog = useDialog()

const { isLinux } = usePlatform()

import { DEFAULT_TRACKER_SOURCE, ENGINE_RPC_PORT } from '@shared/constants'
import { diffConfig, checkIsNeedRestart } from '@shared/utils/config'

const proxyScopeOptions = PROXY_SCOPE_OPTIONS.map((s: string) => ({
  label: t(`preferences.proxy-scope-${s}`),
  value: s,
}))

const logLevelOptions = LOG_LEVELS.map((l: string) => ({ label: l, value: l }))

const syncingTracker = ref(false)
const customTrackerInput = ref('')
const systemProxyAvailable = ref(false)
const systemProxyInfo = ref<SystemProxyInfo | null>(null)

/** Detect system proxy on mount and when user switches to system mode. */
async function detectSystemProxy(): Promise<boolean> {
  try {
    const info = await invoke<SystemProxyInfo | null>('get_system_proxy')
    if (info && info.server) {
      if (info.isSocks) {
        systemProxyAvailable.value = false
        systemProxyInfo.value = null
        message.warning(t('preferences.proxy-system-socks-rejected'))
        return false
      }
      systemProxyAvailable.value = true
      systemProxyInfo.value = info
      return true
    }
    systemProxyAvailable.value = false
    systemProxyInfo.value = null
    return false
  } catch {
    systemProxyAvailable.value = false
    systemProxyInfo.value = null
    return false
  }
}

/** Handle proxy mode radio group change. */
async function onProxyModeChange(mode: ProxyMode) {
  if (mode === 'system') {
    const ok = await detectSystemProxy()
    if (ok && systemProxyInfo.value) {
      form.value.proxy.server = systemProxyInfo.value.server
      if (systemProxyInfo.value.bypass) {
        form.value.proxy.bypass = systemProxyInfo.value.bypass
      }
      // Default scope to all if empty
      if (!form.value.proxy.scope || form.value.proxy.scope.length === 0) {
        form.value.proxy.scope = [...PROXY_SCOPE_OPTIONS]
      }
    } else {
      // Detection failed — revert to none
      form.value.proxy.mode = 'none'
    }
  }
}

/** All known preset tracker source values for fast O(1) classification. */
const presetTrackerValues = new Set(
  trackerSourceOptions.flatMap((group) => ('children' in group ? group.children.map((c) => c.value) : [])),
)

/**
 * Writable computed: preset portion of form.trackerSource.
 * Reading returns only values that exist in trackerSourceOptions.
 * Writing merges the new preset values with existing custom values.
 */
const presetSources = computed({
  get: () => form.value.trackerSource.filter((v) => presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const custom = form.value.trackerSource.filter((v) => !presetTrackerValues.has(v))
    form.value.trackerSource = [...vals, ...custom]
  },
})

/** NSelect options derived from persisted custom URL registry. */
const customSelectOptions = computed(() =>
  form.value.customTrackerUrls.map((url: string) => ({ label: url, value: url })),
)

/**
 * Writable computed: active custom portion of form.trackerSource.
 * Reading returns only values NOT in trackerSourceOptions.
 * Writing merges the new custom values with existing preset values.
 */
const customSources = computed({
  get: () => form.value.trackerSource.filter((v) => !presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const preset = form.value.trackerSource.filter((v) => presetTrackerValues.has(v))
    form.value.trackerSource = [...preset, ...vals]
  },
})

/** Permanently removes a custom URL from both the registry and active selection. */
function onDeleteCustomTracker(url: string, e: Event) {
  e.stopPropagation() // prevent NSelect from toggling selection
  form.value.customTrackerUrls = form.value.customTrackerUrls.filter((v: string) => v !== url)
  customSources.value = customSources.value.filter((v) => v !== url)
}

/**
 * NSelect render-option: wraps each option with a delete button on the right.
 * Clicking the option text toggles selection; clicking the delete icon permanently removes.
 */
function renderCustomOption(info: {
  node: VNodeChild
  option: { value?: string | number }
  selected: boolean
}): VNodeChild {
  const url = String(info.option.value ?? '')
  return h('div', { style: 'display:flex;align-items:center;position:relative;padding-right:32px' }, [
    h('div', { style: 'flex:1;min-width:0' }, [info.node]),
    h(
      'span',
      {
        style:
          'position:absolute;right:8px;display:flex;align-items:center;cursor:pointer;color:var(--error-color, #e88080)',
        onClick: (e: Event) => onDeleteCustomTracker(url, e),
      },
      [h(NIcon, { size: 18 }, { default: () => h(CloseCircleOutline) })],
    ),
  ])
}

/** Dynamic placeholder: distinguishes empty registry from 'has URLs but none selected'. */
const customPlaceholder = computed(() =>
  form.value.customTrackerUrls.length
    ? t('preferences.bt-tracker-source-custom-select')
    : t('preferences.bt-tracker-source-custom-empty'),
)

const aria2ConfPath = ref('')
const sessionPath = ref('')
const logPath = ref('')

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildAdvancedSystemConfig,
  transformForStore: transformAdvancedForStore,
  beforeSave: async (f) => {
    const error = validateAdvancedForm(f)
    if (error) {
      message.error(t(error))
      return false
    }
    // Only warn when user actively clears the secret (non-empty → empty).
    // If it was already empty before this edit session, no need to re-warn.
    const prevSecret = preferenceStore.config.rpcSecret
    if (!f.rpcSecret && !!prevSecret) {
      return new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.rpc-secret-empty-title'),
          content: t('preferences.rpc-secret-empty-confirm'),
          positiveText: t('preferences.rpc-secret-empty-continue'),
          negativeText: t('preferences.engine-restart-later'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
    }
    return true
  },
  afterSave: async (f, prevConfig) => {
    // Sync UPnP mapping state only after a successful Save.
    if (f.enableUpnp !== prevConfig.enableUpnp) {
      syncUpnpState(!!f.enableUpnp, f.listenPort, f.dhtListenPort)
    }

    // Hot-reload engine when startup-only settings change (port, secret).
    const changed = diffConfig(prevConfig, f)
    if (checkIsNeedRestart(changed)) {
      const port = f.rpcListenPort || ENGINE_RPC_PORT
      const secret = f.rpcSecret || ''
      const d = dialog.warning({
        title: t('preferences.engine-restart-title'),
        content: t('preferences.engine-restart-confirm'),
        positiveText: t('preferences.engine-restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          d.loading = true
          d.negativeText = ''
          d.closable = false
          message.info(t('preferences.engine-restarting'))
          // Yield to browser so it paints the loading spinner before the IPC call
          await nextTick()
          await new Promise((r) => requestAnimationFrame(r))
          await restartEngine({ port, secret })
        },
      })
    }

    // Log level changes need a full app relaunch (not engine restart),
    // because tauri-plugin-log is configured at process startup.
    if (changed.logLevel !== undefined && changed.logLevel !== prevConfig.logLevel) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.log-level-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          await relaunch()
        },
      })
    }

    // Hardware rendering toggle needs a full app relaunch — the env var
    // WEBKIT_DISABLE_DMABUF_RENDERER is read by WebKitGTK at process startup.
    if (changed.hardwareRendering !== undefined && changed.hardwareRendering !== prevConfig.hardwareRendering) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.hardware-rendering-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          await relaunch()
        },
      })
    }
  },
})

function buildForm() {
  const c = preferenceStore.config
  const { form: formData, generatedSecret } = buildAdvancedForm(c)
  // Side effect: persist auto-generated secret
  if (generatedSecret) {
    preferenceStore.updateAndSave({ rpcSecret: generatedSecret })
  }
  // Restore trackerSource default that buildAdvancedForm doesn't know about
  if (!c.trackerSource) {
    formData.trackerSource = [...DEFAULT_TRACKER_SOURCE]
  }
  return formData
}

function loadForm() {
  Object.assign(form.value, buildForm())
}

async function loadPaths() {
  try {
    aria2ConfPath.value = await invoke<string>('get_engine_conf_path')
  } catch (e) {
    aria2ConfPath.value = ''
    logger.debug('Advanced.loadConf', e)
  }
  try {
    const dataDir = await appDataDir()
    sessionPath.value = await join(dataDir, 'download.session')
  } catch (e) {
    logger.debug('Advanced.loadPaths', e)
  }
  try {
    const logDir = await appLogDir()
    logPath.value = await join(logDir, 'motrix-next.log')
  } catch (e) {
    logger.debug('Advanced.loadLogPath', e)
  }
}

async function handleSyncTracker() {
  if (form.value.trackerSource.length === 0) {
    message.warning(t('preferences.bt-tracker-select-source'))
    return
  }
  syncingTracker.value = true
  try {
    // Minimum visible loading duration prevents animation flash
    const [result] = await Promise.all([
      preferenceStore.fetchBtTracker(form.value.trackerSource),
      new Promise((r) => setTimeout(r, SYNC_MIN_DURATION)),
    ])

    const text = convertTrackerDataToLine(result.data)

    if (result.failures.length === 0 && text) {
      // All sources succeeded with data
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      message.success(t('preferences.bt-tracker-sync-succeed'))
    } else if (result.data.length > 0 && text) {
      // Partial success — use available data, warn about failures
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      showSyncFailureDialog(result.failures, result.data.length, form.value.trackerSource.length)
    } else {
      // Total failure — no usable data
      showSyncFailureDialog(result.failures, 0, form.value.trackerSource.length)
    }
  } catch (e) {
    logger.debug('Advanced.syncTracker', e)
    message.error(t('preferences.bt-tracker-sync-failed'))
  } finally {
    syncingTracker.value = false
  }
}

/**
 * Shows a dialog listing which tracker source URLs failed and why.
 * Uses NDialog warning for partial success, error for total failure.
 */
function showSyncFailureDialog(
  failures: Array<{ url: string; reason: string }>,
  successCount: number,
  totalCount: number,
) {
  const isPartial = successCount > 0
  const dialogType = isPartial ? 'warning' : 'error'
  const title = isPartial ? t('preferences.bt-tracker-sync-partial-title') : t('preferences.bt-tracker-sync-failed')

  dialog[dialogType]({
    title,
    content: () =>
      h('div', { style: 'max-height:300px;overflow-y:auto' }, [
        isPartial
          ? h(
              'p',
              { style: 'margin:0 0 8px;color:var(--text-color-secondary, #999)' },
              `${successCount}/${totalCount} ${t('preferences.bt-tracker-sync-sources-ok')}`,
            )
          : null,
        h('p', { style: 'margin:0 0 8px;font-weight:500' }, t('preferences.bt-tracker-sync-failed-sources')),
        ...failures.map((f) =>
          h(
            'div',
            {
              style:
                'margin:6px 0;padding:6px 8px;border-radius:4px;background:var(--error-color-hover, rgba(232,128,128,0.08))',
            },
            [
              h('div', { style: 'font-size:12px;word-break:break-all;font-weight:500' }, f.url),
              h('div', { style: 'font-size:11px;color:var(--error-color, #e88080);margin-top:2px' }, f.reason),
            ],
          ),
        ),
      ]),
    positiveText: 'OK',
  })
}

/**
 * Adds a custom tracker source URL after validation.
 * Called when user clicks the Add button or presses Enter in the custom URL input.
 */
function onAddCustomTracker() {
  const url = customTrackerInput.value.trim()
  if (!url) return

  if (!isValidTrackerSourceUrl(url)) {
    message.warning(t('preferences.bt-tracker-source-invalid-url'))
    return
  }

  // Add to registry if not already known
  if (!form.value.customTrackerUrls.includes(url)) {
    form.value.customTrackerUrls = [...form.value.customTrackerUrls, url]
  }

  // Add to active selection if not already selected
  if (!form.value.trackerSource.includes(url)) {
    form.value.trackerSource = [...form.value.trackerSource, url]
  }

  customTrackerInput.value = ''
}

function onRpcPortDice() {
  form.value.rpcListenPort = randomRpcPort()
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

async function copyToClipboard(text: string, label: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('preferences.copied-to-clipboard', { label }))
  } catch {
    // Clipboard API may fail in restricted webview contexts — silently ignore
  }
}

function onBtPortDice() {
  form.value.listenPort = randomBtPort()
}

function onDhtPortDice() {
  form.value.dhtListenPort = randomDhtPort()
}

// ─── UPnP Save-time Sync ─────────────────────────────────────────────

/** Sync UPnP port-mapping state after preferences are saved. */
async function syncUpnpState(enabled: boolean, btPort: number, dhtPort: number) {
  try {
    if (enabled) {
      await invoke('start_upnp_mapping', { btPort, dhtPort })
    } else {
      await invoke('stop_upnp_mapping')
    }
  } catch (e) {
    logger.warn('UPnP', `sync failed: ${e}`)
    message.warning(t('preferences.upnp-mapping-failed'))
  }
}

function changeUA(type: string) {
  const ua = userAgentMap[type]
  if (ua) form.value.userAgent = ua
}

const uaHasIssue = computed(() => !!form.value.userAgent && hasUnsafeHeaderChars(form.value.userAgent))

function cleanUserAgent() {
  form.value.userAgent = sanitizeHeaderValue(form.value.userAgent)
}

// ─── Advanced Actions (delegated to composable) ─────────────────────

const {
  showDbBrowse,
  dbRecords,
  dbRecordsLoading,
  dbBrowseColumns,
  exportingLogs,
  handleManualRestart: handleManualRestartAction,
  handleSessionReset,
  handleRestoreDefaults,
  handleFactoryReset,
  handleDbIntegrityCheck,
  handleDbBrowse,
  handleDbReset,
  handleExportLogs,
  handleClearLog,
  handleRevealPath,
  handleOpenConfigFolder,
} = useAdvancedActions({
  t,
  message,
  taskStore,
  historyStore,
  preferenceStore,
  form,
  buildForm,
  resetSnapshot,
})

function handleManualRestart() {
  handleManualRestartAction(form.value.rpcListenPort as number, form.value.rpcSecret as string)
}

onMounted(() => {
  loadForm()
  resetSnapshot()
  loadPaths()
  detectSystemProxy()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <NDivider title-placement="left">{{ t('preferences.proxy') }}</NDivider>
      <NFormItem :label="t('preferences.proxy-mode')">
        <NRadioGroup v-model:value="form.proxy.mode" @update:value="onProxyModeChange">
          <NRadioButton value="none">{{ t('preferences.proxy-mode-none') }}</NRadioButton>
          <NRadioButton v-if="systemProxyAvailable || form.proxy.mode === 'system'" value="system">
            {{ t('preferences.proxy-mode-system') }}
          </NRadioButton>
          <NRadioButton value="manual">{{ t('preferences.proxy-mode-manual') }}</NRadioButton>
        </NRadioGroup>
      </NFormItem>
      <div class="proxy-collapse" :class="{ 'proxy-collapse--open': form.proxy.mode !== 'none' }">
        <div class="proxy-collapse__inner collapse-indent">
          <NFormItem :label="t('preferences.proxy-server')">
            <NInput v-model:value="form.proxy.server" placeholder="[http://][USER:PASSWORD@]HOST[:PORT]" />
          </NFormItem>
          <NFormItem :show-label="false">
            <div class="info-text">{{ t('preferences.proxy-http-only-hint') }}</div>
          </NFormItem>
          <NFormItem :label="t('preferences.proxy-bypass')">
            <NInput
              v-model:value="form.proxy.bypass"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 3 }"
              :placeholder="t('preferences.proxy-bypass-input-tips')"
            />
          </NFormItem>
          <NFormItem :label="t('preferences.proxy-scope')">
            <NSelect v-model:value="form.proxy.scope" :options="proxyScopeOptions" multiple style="width: 100%" />
          </NFormItem>
        </div>
      </div>

      <NDivider title-placement="left">{{ t('preferences.bt-tracker') }}</NDivider>
      <NFormItem :label="t('preferences.bt-tracker-source-preset')">
        <NSelect
          v-model:value="presetSources"
          :options="trackerSourceOptions"
          multiple
          :placeholder="t('preferences.bt-tracker-source-placeholder')"
          clearable
          max-tag-count="responsive"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-source-custom')">
        <NInputGroup>
          <NInput
            v-model:value="customTrackerInput"
            :placeholder="t('preferences.bt-tracker-source-custom-placeholder')"
            clearable
            @keydown.enter="onAddCustomTracker"
          />
          <NButton size="small" style="flex-shrink: 0" @click="onAddCustomTracker">
            <template #icon>
              <NIcon><AddCircleOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem label=" ">
        <NSelect
          v-model:value="customSources"
          :options="customSelectOptions"
          :render-option="renderCustomOption"
          multiple
          clearable
          :placeholder="customPlaceholder"
          max-tag-count="responsive"
        />
      </NFormItem>
      <NFormItem label=" ">
        <NButton :loading="syncingTracker" type="primary" secondary style="min-width: 140px" @click="handleSyncTracker">
          <template #icon>
            <NIcon><SyncOutline /></NIcon>
          </template>
          {{ t('preferences.bt-tracker-sync') }}
        </NButton>
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-content')">
        <NInput
          v-model:value="form.btTracker"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('preferences.bt-tracker-input-tips')"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="info-text">
          {{ t('preferences.bt-tracker-tips') }}
          <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer" class="info-link"
            >ngosang/trackerslist ↗</a
          >
          <a
            target="_blank"
            href="https://github.com/XIU2/TrackersListCollection"
            rel="noopener noreferrer"
            class="info-link"
            style="margin-left: 8px"
            >XIU2/TrackersListCollection ↗</a
          >
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.auto-sync-tracker')">
        <NSwitch v-model:value="form.autoSyncTracker" />
      </NFormItem>
      <NFormItem v-if="form.lastSyncTrackerTime" :show-label="false">
        <div class="info-text">{{ new Date(form.lastSyncTrackerTime).toLocaleString() }}</div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.rpc') }}</NDivider>
      <NFormItem :label="t('preferences.rpc-listen-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.rpcListenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton
            style="padding: 0 10px"
            @click="copyToClipboard(String(form.rpcListenPort), t('preferences.rpc-listen-port'))"
          >
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="onRpcPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.rpc-secret')" :validation-status="form.rpcSecret ? undefined : 'warning'">
        <NInputGroup>
          <NInput
            v-model:value="form.rpcSecret"
            type="password"
            show-password-on="click"
            placeholder="RPC Secret"
            style="flex: 1"
            :status="form.rpcSecret ? undefined : 'warning'"
          />
          <NButton style="padding: 0 10px" @click="copyToClipboard(form.rpcSecret, 'RPC Secret')">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="onRpcSecretDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.port') }}</NDivider>
      <NFormItem label="UPnP/NAT-PMP">
        <NSwitch v-model:value="form.enableUpnp" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.listenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton style="padding: 0 10px" @click="onBtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.dht-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.dhtListenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton style="padding: 0 10px" @click="onDhtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.user-agent') }}</NDivider>
      <NFormItem :label="t('preferences.mock-user-agent')">
        <div class="ua-field-wrapper">
          <NInput
            v-model:value="form.userAgent"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="User-Agent"
          />
          <!-- UA sanitization hint — slides in via CSS Grid 0fr→1fr -->
          <div class="ua-warn-collapse" :class="{ 'ua-warn-collapse--open': uaHasIssue }">
            <div class="ua-warn-collapse__inner">
              <div class="ua-warn-bar">
                <span class="ua-warn-text">⚠ {{ t('preferences.ua-unsafe-chars-detected') }}</span>
                <NButton size="tiny" type="primary" ghost @click="cleanUserAgent">
                  {{ t('preferences.ua-sanitize') }}
                </NButton>
              </div>
            </div>
          </div>
        </div>
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="ua-preset-row">
          <NButtonGroup size="small">
            <NButton @click="changeUA('aria2')">Aria2</NButton>
            <NButton @click="changeUA('transmission')">Transmission</NButton>
            <NButton @click="changeUA('chrome')">Chrome</NButton>
            <NButton @click="changeUA('du')">du</NButton>
          </NButtonGroup>
          <NButton class="ua-reset-btn" size="small" ghost @click="form.userAgent = ''">
            {{ t('preferences.ua-reset') }}
          </NButton>
        </div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.engine-section') }}</NDivider>
      <NFormItem :label="t('preferences.aria2-conf-path')">
        <NInputGroup>
          <NInput :value="aria2ConfPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(aria2ConfPath, t('preferences.aria2-conf-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(aria2ConfPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.session-path')">
        <NInputGroup>
          <NInput :value="sessionPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(sessionPath, t('preferences.session-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(sessionPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :show-label="false">
        <NButton class="ghost-btn--warning" ghost @click="handleSessionReset">
          {{ t('preferences.clear-all-tasks') }}
        </NButton>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.log-section') }}</NDivider>
      <NFormItem :label="t('preferences.log-path')">
        <NInputGroup>
          <NInput :value="logPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(logPath, t('preferences.log-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(logPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.log-level')">
        <div class="log-level-row">
          <NSelect v-model:value="form.logLevel" :options="logLevelOptions" style="width: 110px" />
          <NButton class="ghost-btn--primary" ghost :loading="exportingLogs" @click="handleExportLogs">
            <template #icon>
              <NIcon><DownloadOutline /></NIcon>
            </template>
            {{ t('preferences.export-diagnostic-logs') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleClearLog">
            <template #icon>
              <NIcon><TrashOutline /></NIcon>
            </template>
            {{ t('preferences.clear-log') }}
          </NButton>
        </div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.history-section') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton class="db-integrity-check-btn" @click="handleDbIntegrityCheck">
            {{ t('preferences.db-integrity-check') }}
          </NButton>
          <NButton class="db-browse-btn" @click="handleDbBrowse">
            {{ t('preferences.db-browse') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleDbReset">
            {{ t('preferences.db-reset') }}
          </NButton>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.diagnostics-section') }}</NDivider>
      <NFormItem v-if="isLinux" :label="t('preferences.hardware-rendering')">
        <NSwitch v-model:value="form.hardwareRendering" />
      </NFormItem>
      <NFormItem v-if="isLinux" :show-label="false">
        <div class="info-text">{{ t('preferences.hardware-rendering-hint') }}</div>
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton class="open-config-folder-btn" @click="handleOpenConfigFolder">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
            {{ t('preferences.open-config-folder') }}
          </NButton>
          <NButton class="ghost-btn--warning" ghost @click="handleRestoreDefaults">
            {{ t('preferences.restore-defaults') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleFactoryReset">
            {{ t('preferences.factory-reset') }}
          </NButton>
        </NSpace>
      </NFormItem>
    </NForm>

    <!-- Database records viewer modal -->
    <NModal
      v-model:show="showDbBrowse"
      preset="card"
      :title="t('preferences.db-browse-title')"
      style="width: 800px; max-width: 90vw"
      :mask-closable="true"
    >
      <NDataTable
        :columns="dbBrowseColumns"
        :data="dbRecords"
        :loading="dbRecordsLoading"
        :max-height="400"
        :scroll-x="700"
        size="small"
        striped
      >
        <template #empty>
          <NEmpty :description="t('preferences.db-record-count', { count: 0 })" />
        </template>
      </NDataTable>
      <div v-if="dbRecords.length > 0" style="margin-top: 12px; text-align: right; opacity: 0.6; font-size: 13px">
        {{ t('preferences.db-record-count', { count: dbRecords.length }) }}
      </div>
    </NModal>
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
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.info-text {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  max-width: 520px;
  word-wrap: break-word;
}
.info-link {
  color: var(--color-primary);
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: var(--color-primary);
  cursor: pointer;
  margin-left: 8px;
  font-size: 12px;
}
.action-link:hover {
  text-decoration: underline;
}
.form-actions {
  padding: 16px 24px 16px 40px;
}

/* ── Ghost button variants — shared tinted styles with M3 easing ──── */
.ghost-btn--danger {
  --btn-tint: var(--m3-error, #c97070);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--danger:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--danger :deep(.n-button__border),
.ghost-btn--danger :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

.ghost-btn--warning {
  --btn-tint: var(--m3-tertiary, #c9a055);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--warning:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--warning :deep(.n-button__border),
.ghost-btn--warning :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

.ghost-btn--primary {
  --btn-tint: var(--color-primary, #5b93d5);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--primary:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--primary :deep(.n-button__border),
.ghost-btn--primary :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Log-level row — select + export button inline ───────────────── */
.log-level-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

/* ── UA preset row — button group + standalone reset ─────────────── */
.ua-preset-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ── UA field wrapper — stacks textarea + warning within same NFormItem ── */
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── UA warning — CSS Grid 0fr→1fr slide-in, matches proxy-collapse ── */
.ua-warn-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open {
  grid-template-rows: 1fr;
}
.ua-warn-collapse__inner {
  overflow: hidden;
}
.ua-warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container-bg);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open .ua-warn-bar {
  opacity: 1;
}
.ua-warn-text {
  font-size: var(--font-size-sm);
  color: var(--m3-error);
  flex: 1;
}

/* ── UA Reset — muted-rose ghost that highlights on hover ─────────── */
.ua-reset-btn {
  --btn-muted: #c97070;
  color: var(--btn-muted) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-reset-btn:hover {
  background-color: color-mix(in srgb, var(--btn-muted) 12%, transparent) !important;
}
.ua-reset-btn :deep(.n-button__border) {
  border-color: var(--btn-muted) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-reset-btn:hover :deep(.n-button__border) {
  border-color: var(--btn-muted) !important;
}
.ua-reset-btn :deep(.n-button__state-border) {
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Proxy collapse — CSS Grid 0fr→1fr for glitch-free height:auto ── */
.proxy-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.proxy-collapse--open {
  grid-template-rows: 1fr;
}
.proxy-collapse__inner {
  overflow: hidden;
}

/* ── Collapse indent: subordinate toggle hierarchy ────────────────── */
.form-preference :deep(.collapse-indent) {
  margin-left: 16px;
}
</style>
