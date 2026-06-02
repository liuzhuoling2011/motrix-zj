<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NCheckbox, NEmpty, NInput, NSelect } from 'naive-ui'
import { vAutoAnimate } from '@formkit/auto-animate'
import type { UserAgentProfile, UserAgentRule } from '@shared/types'
import { sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import { isValidUserAgentHostPattern } from '@shared/utils/userAgentPolicy'
import { useAppMessage } from '@/composables/useAppMessage'

const props = defineProps<{
  profiles: UserAgentProfile[]
  rules: UserAgentRule[]
  recentProfileIds: string[]
}>()

const emit = defineEmits<{
  'update:profiles': [profiles: UserAgentProfile[]]
  'update:rules': [rules: UserAgentRule[]]
  'update:recentProfileIds': [ids: string[]]
}>()

const { t } = useI18n()
const message = useAppMessage()

const editingProfileId = ref<string | null>(null)
const profileDraft = ref({ name: '', value: '' })
const editingRuleId = ref<string | null>(null)
const ruleDraft = ref({ enabled: true, hostPattern: '', profileId: '', overridePlugin: false })

const profileOptions = computed(() =>
  props.profiles.map((profile) => ({
    label: profile.name,
    value: profile.id,
  })),
)

function newUserAgentId(prefix: string): string {
  const now = Date.now()
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function profileName(id: string): string {
  return props.profiles.find((profile) => profile.id === id)?.name ?? id
}

function startAddProfile() {
  editingProfileId.value = ''
  profileDraft.value = { name: '', value: '' }
}

function startEditProfile(profile: UserAgentProfile) {
  editingProfileId.value = profile.id
  profileDraft.value = { name: profile.name, value: profile.value }
}

function cancelProfileEdit() {
  editingProfileId.value = null
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
    emit(
      'update:profiles',
      props.profiles.map((profile) =>
        profile.id === editingProfileId.value ? { ...profile, name, value, updatedAt: now } : profile,
      ),
    )
  } else {
    emit('update:profiles', [
      ...props.profiles,
      {
        id: newUserAgentId('ua'),
        name,
        value,
        createdAt: now,
        updatedAt: now,
      },
    ])
  }

  editingProfileId.value = null
}

function removeProfile(id: string) {
  if (props.rules.some((rule) => rule.profileId === id)) {
    message.error(t('preferences.ua-profile-in-use'))
    return
  }
  emit(
    'update:profiles',
    props.profiles.filter((profile) => profile.id !== id),
  )
  emit(
    'update:recentProfileIds',
    props.recentProfileIds.filter((profileId) => profileId !== id),
  )
}

function startAddRule() {
  editingRuleId.value = ''
  ruleDraft.value = {
    enabled: true,
    hostPattern: '',
    profileId: props.profiles[0]?.id ?? '',
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

function cancelRuleEdit() {
  editingRuleId.value = null
}

function saveRule() {
  const hostPattern = ruleDraft.value.hostPattern.trim().toLowerCase()
  if (!isValidUserAgentHostPattern(hostPattern) || !ruleDraft.value.profileId) {
    message.error(t('preferences.ua-rule-invalid'))
    return
  }

  const now = Date.now()
  if (editingRuleId.value) {
    emit(
      'update:rules',
      props.rules.map((rule) =>
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
      ),
    )
  } else {
    emit('update:rules', [
      ...props.rules,
      {
        id: newUserAgentId('ua-rule'),
        enabled: ruleDraft.value.enabled,
        hostPattern,
        profileId: ruleDraft.value.profileId,
        overridePlugin: ruleDraft.value.overridePlugin,
        createdAt: now,
        updatedAt: now,
      },
    ])
  }

  editingRuleId.value = null
}

function removeRule(id: string) {
  emit(
    'update:rules',
    props.rules.filter((rule) => rule.id !== id),
  )
}
</script>

<template>
  <div class="ua-manager">
    <section class="ua-section">
      <div v-auto-animate="{ duration: 220, easing: 'ease-out' }" class="ua-card-list">
        <template v-for="profile in profiles" :key="profile.id">
          <div v-if="editingProfileId === profile.id" class="ua-edit-card">
            <NInput v-model:value="profileDraft.name" :placeholder="t('preferences.ua-profile-name')" />
            <NInput
              v-model:value="profileDraft.value"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 3 }"
              :placeholder="t('preferences.user-agent')"
            />
            <div class="ua-card-actions">
              <NButton size="small" @click="cancelProfileEdit">{{ t('app.cancel') }}</NButton>
              <NButton size="small" type="primary" @click="saveProfile">{{ t('app.save') }}</NButton>
            </div>
          </div>
          <div v-else class="ua-row">
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
        </template>

        <NEmpty
          v-if="profiles.length === 0 && editingProfileId === null"
          size="small"
          :description="t('task.ua-no-saved')"
        />

        <div v-if="editingProfileId === ''" class="ua-edit-card">
          <NInput v-model:value="profileDraft.name" :placeholder="t('preferences.ua-profile-name')" />
          <NInput
            v-model:value="profileDraft.value"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            :placeholder="t('preferences.user-agent')"
          />
          <div class="ua-card-actions">
            <NButton size="small" @click="cancelProfileEdit">{{ t('app.cancel') }}</NButton>
            <NButton size="small" type="primary" @click="saveProfile">{{ t('app.save') }}</NButton>
          </div>
        </div>
      </div>
      <NButton size="small" dashed @click="startAddProfile">{{ t('preferences.ua-add-profile') }}</NButton>
    </section>

    <section class="ua-section">
      <div v-auto-animate="{ duration: 220, easing: 'ease-out' }" class="ua-card-list">
        <template v-for="rule in rules" :key="rule.id">
          <div v-if="editingRuleId === rule.id" class="ua-edit-card">
            <NInput v-model:value="ruleDraft.hostPattern" placeholder="*.example.com" />
            <NSelect v-model:value="ruleDraft.profileId" :options="profileOptions" />
            <NCheckbox v-model:checked="ruleDraft.overridePlugin">{{ t('preferences.ua-override-plugin') }}</NCheckbox>
            <div class="ua-card-actions">
              <NButton size="small" @click="cancelRuleEdit">{{ t('app.cancel') }}</NButton>
              <NButton size="small" type="primary" @click="saveRule">{{ t('app.save') }}</NButton>
            </div>
          </div>
          <div v-else class="ua-row">
            <div class="ua-row-main">
              <strong>{{ rule.hostPattern }} -> {{ profileName(rule.profileId) }}</strong>
              <span>{{
                rule.overridePlugin ? t('preferences.ua-override-on') : t('preferences.ua-override-off')
              }}</span>
            </div>
            <NButton size="tiny" @click="startEditRule(rule)">{{ t('preferences.ua-edit') }}</NButton>
            <NButton size="tiny" quaternary @click="removeRule(rule.id)">{{ t('preferences.ua-delete') }}</NButton>
          </div>
        </template>

        <NEmpty
          v-if="rules.length === 0 && editingRuleId === null"
          size="small"
          :description="t('preferences.ua-rules')"
        />

        <div v-if="editingRuleId === ''" class="ua-edit-card">
          <NInput v-model:value="ruleDraft.hostPattern" placeholder="*.example.com" />
          <NSelect v-model:value="ruleDraft.profileId" :options="profileOptions" />
          <NCheckbox v-model:checked="ruleDraft.overridePlugin">{{ t('preferences.ua-override-plugin') }}</NCheckbox>
          <div class="ua-card-actions">
            <NButton size="small" @click="cancelRuleEdit">{{ t('app.cancel') }}</NButton>
            <NButton size="small" type="primary" @click="saveRule">{{ t('app.save') }}</NButton>
          </div>
        </div>
      </div>
      <NButton size="small" dashed :disabled="profiles.length === 0" @click="startAddRule">
        {{ t('preferences.ua-add-rule') }}
      </NButton>
    </section>
  </div>
</template>

<style scoped>
.ua-manager,
.ua-section,
.ua-card-list,
.ua-edit-card {
  display: flex;
  flex-direction: column;
}

.ua-manager {
  gap: 18px;
  width: 100%;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 62%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--m3-surface-container-low) 54%, transparent);
}

.ua-section {
  gap: 8px;
}

.ua-card-list {
  gap: 8px;
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

.ua-edit-card {
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  border-radius: 6px;
  background: var(--n-color, var(--m3-surface-container-low));
}

.ua-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
