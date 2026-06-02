<script setup lang="ts">
/** @fileoverview Network preference tab: proxy, ports, user-agent, timeouts, file allocation. */
import { ref, computed, nextTick, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { usePlatform } from '@/composables/usePlatform'
import { useSystemProxyDetect } from '@/composables/useSystemProxyDetect'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { useAppMessage } from '@/composables/useAppMessage'
import { PROXY_SCOPE_OPTIONS, FILE_ALLOCATION_OPTIONS, ENGINE_RPC_PORT } from '@shared/constants'
import { diffConfig, checkIsNeedRestart } from '@shared/utils/config'
import {
  buildNetworkForm,
  buildNetworkSystemConfig,
  transformNetworkForStore,
  validateNetworkForm,
  randomBtPort,
  randomDhtPort,
} from '@/composables/useNetworkPreference'
import { proxySwitchValueToMode } from '@shared/utils/proxyPolicy'

import userAgentMap from '@shared/ua'
import { hasUnsafeHeaderChars, sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import { isValidUserAgentHostPattern } from '@shared/utils/userAgentPolicy'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NCheckbox,
  NSwitch,
  NSelect,
  NButton,
  NButtonGroup,
  NDivider,
  NIcon,
  NText,
  NCollapseTransition,
  NRadioButton,
  NRadioGroup,
  useDialog,
} from 'naive-ui'
import type { UserAgentProfile, UserAgentRule } from '@shared/types'
const needsRestart = ref(false)
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceCheckboxGrid from './PreferenceCheckboxGrid.vue'
import PreferenceHintLabel from './PreferenceHintLabel.vue'
import { SearchOutline, DiceOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { isWindows } = usePlatform()

const proxyScopeOptions = PROXY_SCOPE_OPTIONS.map((s: string) => ({
  label: t(`preferences.proxy-scope-${s}`),
  value: s,
}))
const fileAllocationOptions = computed(() =>
  FILE_ALLOCATION_OPTIONS.filter((value) => !(isWindows.value && value === 'falloc')).map((value) => ({
    label: value,
    value,
  })),
)

type PortRecoveryTarget = 'rpc' | 'extensionApi' | 'bt' | 'dht' | 'ed2k' | 'ed2kUdp'
const portRecoveryTargets: PortRecoveryTarget[] = ['rpc', 'extensionApi', 'bt', 'dht', 'ed2k', 'ed2kUdp']
const portRecoveryTargetOptions = computed(() => [
  { label: t('preferences.rpc-listen-port'), value: 'rpc' },
  { label: t('preferences.extension-api-port'), value: 'extensionApi' },
  { label: t('preferences.port-conflict-recovery-bt'), value: 'bt' },
  { label: t('preferences.port-conflict-recovery-dht'), value: 'dht' },
  { label: t('preferences.port-conflict-recovery-ed2k'), value: 'ed2k' },
  { label: t('preferences.port-conflict-recovery-ed2k-udp'), value: 'ed2kUdp' },
])
const selectedPortRecoveryTargets = computed<string[]>({
  get: () => portRecoveryTargets.filter((target) => form.value.portConflictRecovery[target]),
  set: (targets) => {
    const selected = new Set(targets)
    for (const target of portRecoveryTargets) {
      form.value.portConflictRecovery[target] = selected.has(target)
    }
  },
})

// ── Proxy detection ─────────────────────────────────────────────────
const { detecting: detectingProxy, detect: detectProxy } = useSystemProxyDetect({
  onSuccess(info) {
    form.value.proxy.server = info.server
    if (info.bypass) form.value.proxy.bypass = info.bypass
    form.value.proxy.mode = 'manual'
    message.success(t('preferences.proxy-detected-success'))
  },
  onSocks() {
    message.warning(t('preferences.proxy-system-socks-rejected'))
  },
  onNotFound() {
    message.info(t('preferences.proxy-system-not-detected'))
  },
  onError() {
    message.error(t('preferences.proxy-system-detect-failed'))
  },
})

function buildForm() {
  return buildNetworkForm(preferenceStore.config)
}

const { restartEngine } = useEngineRestart()

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildNetworkSystemConfig,
  transformForStore: transformNetworkForStore,
  beforeSave: async (f) => {
    const validationKey = validateNetworkForm(f)
    if (validationKey) {
      message.error(t(validationKey))
      return false
    }

    // Gate: engine restart confirmation (BT/DHT port change).
    // Must confirm BEFORE saving — declining cancels the entire save so
    // config.json never contains values the running engine doesn't match.
    const changed = diffConfig(preferenceStore.config, f)
    if (checkIsNeedRestart(changed)) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.engine-restart-title'),
          content: t('preferences.engine-restart-confirm'),
          positiveText: t('preferences.engine-restart-now'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
      needsRestart.value = true
    }

    return true
  },
  afterSave: async (f, prevConfig) => {
    // Sync UPnP mapping state after save
    if (
      f.enableUpnp !== prevConfig.enableUpnp ||
      (f.enableUpnp && (f.listenPort !== prevConfig.listenPort || f.dhtListenPort !== prevConfig.dhtListenPort))
    ) {
      syncUpnpState(
        !!f.enableUpnp,
        f.listenPort,
        f.dhtListenPort,
        preferenceStore.config.ed2kListenPort,
        preferenceStore.config.ed2kUdpListenPort,
      )
    }

    // Engine restart — user already confirmed in beforeSave, execute immediately.
    if (needsRestart.value) {
      needsRestart.value = false
      const port = (preferenceStore.config.rpcListenPort as number) || ENGINE_RPC_PORT
      const secret = (preferenceStore.config.rpcSecret as string) || ''
      message.info(t('preferences.engine-restarting'))
      await nextTick()
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    }
  },
})

// ── Port randomization ──────────────────────────────────────────────
function onBtPortDice() {
  form.value.listenPort = randomBtPort()
}
function onDhtPortDice() {
  form.value.dhtListenPort = randomDhtPort()
}

// ── UPnP save-time sync ─────────────────────────────────────────────
async function syncUpnpState(enabled: boolean, btPort: number, dhtPort: number, ed2kPort: number, ed2kUdpPort: number) {
  try {
    if (enabled) {
      await invoke('start_upnp_mapping', {
        btPort,
        dhtPort,
        ed2kPort: ed2kPort > 0 ? ed2kPort : null,
        ed2kUdpPort: ed2kUdpPort > 0 ? ed2kUdpPort : null,
      })
    } else {
      await invoke('stop_upnp_mapping')
    }
  } catch (e) {
    logger.warn('UPnP', `sync failed: ${getErrorMessage(e)}`)
    message.warning(t('preferences.upnp-mapping-failed'))
  }
}

// ── User-Agent presets ──────────────────────────────────────────────
function changeUA(type: string) {
  const ua = userAgentMap[type]
  if (ua) form.value.userAgent = ua
}

const uaHasIssue = computed(() => !!form.value.userAgent && hasUnsafeHeaderChars(form.value.userAgent as string))
const userAgentProfileOptions = computed(() =>
  form.value.userAgentProfiles.map((profile) => ({
    label: profile.name,
    value: profile.id,
  })),
)
const userAgentProfiles = computed(() => form.value.userAgentProfiles)
const userAgentRules = computed(() => form.value.userAgentRules)
const editingProfileId = ref<string | null>(null)
const profileDraft = ref({ name: '', value: '' })
const editingRuleId = ref<string | null>(null)
const ruleDraft = ref({ enabled: true, hostPattern: '', profileId: '', overridePlugin: false })

function cleanUserAgent() {
  form.value.userAgent = sanitizeHeaderValue(form.value.userAgent as string)
}

function startAddProfile() {
  editingProfileId.value = ''
  profileDraft.value = { name: '', value: '' }
}

function startEditProfile(profile: UserAgentProfile) {
  editingProfileId.value = profile.id
  profileDraft.value = { name: profile.name, value: profile.value }
}

function saveProfile() {
  const name = profileDraft.value.name.trim()
  const value = sanitizeHeaderValue(profileDraft.value.value)
  if (!name || !value) {
    message.error(t('preferences.ua-profile-invalid'))
    return
  }
  const now = Date.now()
  if (editingProfileId.value) {
    form.value.userAgentProfiles = form.value.userAgentProfiles.map((profile) =>
      profile.id === editingProfileId.value ? { ...profile, name, value, updatedAt: now } : profile,
    )
  } else {
    form.value.userAgentProfiles = [
      ...form.value.userAgentProfiles,
      {
        id: `ua-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        value,
        createdAt: now,
        updatedAt: now,
      },
    ]
  }
  editingProfileId.value = null
}

function removeProfile(id: string) {
  if (form.value.userAgentRules.some((rule) => rule.profileId === id)) {
    message.error(t('preferences.ua-profile-in-use'))
    return
  }
  form.value.userAgentProfiles = form.value.userAgentProfiles.filter((profile) => profile.id !== id)
  form.value.recentUserAgentProfileIds = form.value.recentUserAgentProfileIds.filter((profileId) => profileId !== id)
}

function startAddRule() {
  editingRuleId.value = ''
  ruleDraft.value = {
    enabled: true,
    hostPattern: '',
    profileId: form.value.userAgentProfiles[0]?.id ?? '',
    overridePlugin: false,
  }
}

function startEditRule(rule: UserAgentRule) {
  editingRuleId.value = rule.id
  ruleDraft.value = {
    enabled: rule.enabled,
    hostPattern: rule.hostPattern,
    profileId: rule.profileId,
    overridePlugin: rule.overridePlugin,
  }
}

function saveRule() {
  const hostPattern = ruleDraft.value.hostPattern.trim().toLowerCase()
  if (!isValidUserAgentHostPattern(hostPattern) || !ruleDraft.value.profileId) {
    message.error(t('preferences.ua-rule-invalid'))
    return
  }
  const now = Date.now()
  if (editingRuleId.value) {
    form.value.userAgentRules = form.value.userAgentRules.map((rule) =>
      rule.id === editingRuleId.value
        ? {
            ...rule,
            enabled: ruleDraft.value.enabled,
            hostPattern,
            profileId: ruleDraft.value.profileId,
            overridePlugin: ruleDraft.value.overridePlugin,
            updatedAt: now,
          }
        : rule,
    )
  } else {
    form.value.userAgentRules = [
      ...form.value.userAgentRules,
      {
        id: `ua-rule-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        enabled: ruleDraft.value.enabled,
        hostPattern,
        profileId: ruleDraft.value.profileId,
        overridePlugin: ruleDraft.value.overridePlugin,
        createdAt: now,
        updatedAt: now,
      },
    ]
  }
  editingRuleId.value = null
}

function removeRule(id: string) {
  form.value.userAgentRules = form.value.userAgentRules.filter((rule) => rule.id !== id)
}

function profileName(id: string): string {
  return form.value.userAgentProfiles.find((profile) => profile.id === id)?.name ?? id
}

function handleProxySwitch(value: boolean) {
  form.value.proxy.mode = proxySwitchValueToMode(value)
}

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

onMounted(() => {
  Object.assign(form.value, buildForm())
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <!-- Proxy -->
      <NDivider title-placement="left">{{ t('preferences.proxy') }}</NDivider>
      <NFormItem>
        <template #label>
          <PreferenceHintLabel :label="t('task.use-proxy')" :hint="t('preferences.proxy-request-scope-hint')" />
        </template>
        <NSwitch :value="form.proxy.mode !== 'direct'" @update:value="handleProxySwitch" />
      </NFormItem>
      <div class="proxy-collapse" :class="{ 'proxy-collapse--open': form.proxy.mode === 'manual' }">
        <div class="proxy-collapse__inner collapse-indent">
          <NFormItem>
            <template #label>
              <PreferenceHintLabel
                :label="t('preferences.proxy-server')"
                :hint="t('preferences.proxy-http-only-hint')"
              />
            </template>
            <NInputGroup>
              <NInput v-model:value="form.proxy.server" class="pref-control-full" placeholder="http://host:port" />
              <NButton class="pref-action-button" :loading="detectingProxy" @click="detectProxy">
                <template #icon>
                  <NIcon><SearchOutline /></NIcon>
                </template>
                {{ t('preferences.detect-system-proxy') }}
              </NButton>
            </NInputGroup>
          </NFormItem>
          <NFormItem :label="t('preferences.proxy-username')">
            <NInput v-model:value="form.proxy.username" />
          </NFormItem>
          <NFormItem :label="t('preferences.proxy-password')">
            <NInput v-model:value="form.proxy.password" type="password" show-password-on="click" />
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
            <NSelect v-model:value="form.proxy.scope" :options="proxyScopeOptions" multiple class="pref-control-full" />
          </NFormItem>
        </div>
      </div>

      <!-- Port conflict recovery -->
      <NDivider title-placement="left">{{ t('preferences.port-conflict-recovery') }}</NDivider>
      <NFormItem :label="t('preferences.port-conflict-recovery-enable')">
        <NSwitch v-model:value="form.portConflictRecovery.enabled" />
      </NFormItem>
      <div
        class="port-recovery-collapse"
        :class="{ 'port-recovery-collapse--open': form.portConflictRecovery.enabled }"
      >
        <div class="port-recovery-collapse__inner collapse-indent">
          <NFormItem>
            <template #label>
              <PreferenceHintLabel
                :label="t('preferences.port-conflict-recovery-range')"
                :hint="t('preferences.port-conflict-recovery-range-hint')"
              />
            </template>
            <NInputGroup>
              <NInputNumber
                v-model:value="form.portConflictRecovery.rangeStart"
                :min="1024"
                :max="65535"
                class="pref-port"
              />
              <span class="port-range-separator">to</span>
              <NInputNumber
                v-model:value="form.portConflictRecovery.rangeEnd"
                :min="1024"
                :max="65535"
                class="pref-port"
              />
            </NInputGroup>
          </NFormItem>
          <NFormItem :label="t('preferences.port-conflict-recovery-apply-to')">
            <PreferenceCheckboxGrid v-model:value="selectedPortRecoveryTargets" :options="portRecoveryTargetOptions" />
          </NFormItem>
        </div>
      </div>

      <!-- Ports -->
      <NDivider title-placement="left">{{ t('preferences.port') }}</NDivider>
      <NFormItem label="UPnP/NAT-PMP">
        <NSwitch v-model:value="form.enableUpnp" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.listenPort" :min="1024" :max="65535" class="pref-port" />
          <NButton class="pref-icon-button" @click="onBtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.dht-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.dhtListenPort" :min="1024" :max="65535" class="pref-port" />
          <NButton class="pref-icon-button" @click="onDhtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <!-- P2P Sharing -->
      <NDivider title-placement="left">{{ t('preferences.p2p-sharing-section') }}</NDivider>
      <NFormItem>
        <template #label>
          <PreferenceHintLabel
            :label="t('preferences.sharing-mode')"
            :hint="t('preferences.sharing-mode-scope-hint')"
          />
        </template>
        <NRadioGroup v-model:value="form.sharingMode" size="small">
          <NRadioButton value="stop-by-condition">
            {{ t('preferences.sharing-mode-stop-by-condition') }}
          </NRadioButton>
          <NRadioButton value="manual-stop">{{ t('preferences.sharing-mode-manual-stop') }}</NRadioButton>
        </NRadioGroup>
      </NFormItem>
      <NCollapseTransition :show="form.sharingMode === 'stop-by-condition'" class="collapse-indent">
        <NFormItem :label="t('preferences.share-ratio')">
          <NInputNumber v-model:value="form.shareRatio" :min="1" :max="100" :step="0.1" class="pref-number" />
        </NFormItem>
        <NFormItem :label="t('preferences.share-time') + ' (' + t('preferences.share-time-unit') + ')'">
          <NInputNumber v-model:value="form.shareTime" :min="60" :max="525600" class="pref-number" />
        </NFormItem>
      </NCollapseTransition>
      <NCollapseTransition :show="form.sharingMode === 'manual-stop'" class="collapse-indent">
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.sharing-mode-manual-stop')"
              :hint="t('preferences.sharing-mode-manual-stop-tips')"
            />
          </template>
        </NFormItem>
      </NCollapseTransition>

      <!-- User-Agent -->
      <NDivider title-placement="left">{{ t('preferences.user-agent') }}</NDivider>
      <NFormItem :label="t('preferences.mock-user-agent')">
        <div class="ua-field-wrapper">
          <NInput
            v-model:value="form.userAgent"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="User-Agent"
          />
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
            <NButton @click="changeUA('chrome')">Chrome</NButton>
            <NButton @click="changeUA('edge')">Edge</NButton>
            <NButton @click="changeUA('safari')">Safari</NButton>
            <NButton @click="changeUA('firefox')">Firefox</NButton>
            <NButton @click="changeUA('transmission')">Transmission</NButton>
          </NButtonGroup>
          <NButton class="ua-reset-btn" size="small" ghost @click="form.userAgent = ''">
            {{ t('preferences.ua-reset') }}
          </NButton>
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.ua-saved')">
        <div class="ua-management">
          <div v-for="profile in userAgentProfiles" :key="profile.id" class="ua-row">
            <div class="ua-row-main">
              <strong>{{ profile.name }}</strong>
              <span>{{ profile.value }}</span>
            </div>
            <NButton size="tiny" @click="startEditProfile(profile)">
              {{ t('preferences.ua-edit') }}
            </NButton>
            <NButton size="tiny" quaternary @click="removeProfile(profile.id)">
              {{ t('preferences.ua-delete') }}
            </NButton>
          </div>
          <div v-if="editingProfileId !== null" class="ua-edit">
            <NInput v-model:value="profileDraft.name" :placeholder="t('preferences.ua-profile-name')" />
            <NInput
              v-model:value="profileDraft.value"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 3 }"
              :placeholder="t('preferences.user-agent')"
            />
            <div class="ua-edit-actions">
              <NButton size="small" @click="editingProfileId = null">{{ t('app.cancel') }}</NButton>
              <NButton size="small" type="primary" @click="saveProfile">{{ t('app.save') }}</NButton>
            </div>
          </div>
          <NButton size="small" @click="startAddProfile">{{ t('preferences.ua-add-profile') }}</NButton>
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.ua-rules')">
        <div class="ua-management">
          <div v-for="rule in userAgentRules" :key="rule.id" class="ua-row">
            <div class="ua-row-main">
              <strong>{{ rule.hostPattern }} -> {{ profileName(rule.profileId) }}</strong>
              <span>{{
                rule.overridePlugin ? t('preferences.ua-override-on') : t('preferences.ua-override-off')
              }}</span>
            </div>
            <NButton size="tiny" @click="startEditRule(rule)">{{ t('preferences.ua-edit') }}</NButton>
            <NButton size="tiny" quaternary @click="removeRule(rule.id)">{{ t('preferences.ua-delete') }}</NButton>
          </div>
          <div v-if="editingRuleId !== null" class="ua-edit">
            <NInput v-model:value="ruleDraft.hostPattern" placeholder="*.example.com" />
            <NSelect v-model:value="ruleDraft.profileId" :options="userAgentProfileOptions" />
            <NCheckbox v-model:checked="ruleDraft.overridePlugin">{{ t('preferences.ua-override-plugin') }}</NCheckbox>
            <div class="ua-edit-actions">
              <NButton size="small" @click="editingRuleId = null">{{ t('app.cancel') }}</NButton>
              <NButton size="small" type="primary" @click="saveRule">{{ t('app.save') }}</NButton>
            </div>
          </div>
          <NButton size="small" :disabled="form.userAgentProfiles.length === 0" @click="startAddRule">
            {{ t('preferences.ua-add-rule') }}
          </NButton>
        </div>
      </NFormItem>

      <!-- Timeout & Disk -->
      <NDivider title-placement="left">{{ t('preferences.transfer-params') }}</NDivider>
      <NFormItem :label="t('preferences.connect-timeout')">
        <NInputNumber v-model:value="form.connectTimeout" :min="1" :max="600" class="pref-number" />
        <NText depth="3" class="pref-inline-note">{{ t('preferences.unit-seconds') }}</NText>
      </NFormItem>
      <NFormItem :label="t('preferences.timeout')">
        <NInputNumber v-model:value="form.timeout" :min="1" :max="600" class="pref-number" />
        <NText depth="3" class="pref-inline-note">{{ t('preferences.unit-seconds') }}</NText>
      </NFormItem>
      <NFormItem :label="t('preferences.file-allocation')">
        <NSelect v-model:value="form.fileAllocation" :options="fileAllocationOptions" class="pref-control-auto" />
      </NFormItem>
      <NFormItem>
        <template #label>
          <PreferenceHintLabel :label="t('preferences.async-dns')" :hint="t('preferences.async-dns-hint')" />
        </template>
        <NSwitch v-model:value="form.asyncDns" />
      </NFormItem>
    </NForm>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
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
.port-recovery-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.port-recovery-collapse--open {
  grid-template-rows: 1fr;
}
.port-recovery-collapse__inner {
  overflow: hidden;
}
.port-range-separator {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  line-height: 1;
}
/* ── UA preset row ───────────────────────────────────────────────── */
.ua-preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}
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
.ua-reset-btn :deep(.n-button__state-border) {
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-management {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.ua-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  border-radius: 6px;
}
.ua-row-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ua-row-main span {
  overflow: hidden;
  color: var(--n-text-color-3, var(--m3-on-surface-variant));
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ua-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  border-radius: 6px;
}
.ua-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
