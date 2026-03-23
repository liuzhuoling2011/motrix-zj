<script setup lang="ts">
/** @fileoverview Advanced task options panel (UA, auth, referer, cookie, proxy). */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NFormItem, NInput, NCheckbox, NCollapseTransition, NButton } from 'naive-ui'
import { hasUnsafeHeaderChars, sanitizeHeaderValue } from '@shared/utils/headerSanitize'

const { t } = useI18n()

const props = defineProps<{
  show: boolean
  userAgent: string
  authorization: string
  referer: string
  cookie: string
  allProxy: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:userAgent': [value: string]
  'update:authorization': [value: string]
  'update:referer': [value: string]
  'update:cookie': [value: string]
  'update:allProxy': [value: string]
}>()

const uaHasIssue = computed(() => !!props.userAgent && hasUnsafeHeaderChars(props.userAgent))

function cleanUserAgent() {
  emit('update:userAgent', sanitizeHeaderValue(props.userAgent))
}
</script>

<template>
  <NFormItem :show-label="false">
    <NCheckbox :checked="show" @update:checked="$emit('update:show', $event)">
      {{ t('task.show-advanced-options') }}
    </NCheckbox>
  </NFormItem>
  <NCollapseTransition :show="show">
    <div>
      <NFormItem :label="t('task.task-user-agent') + ':'">
        <div class="ua-field-wrapper">
          <NInput
            :value="userAgent"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            @update:value="$emit('update:userAgent', $event)"
          />
          <!-- UA sanitization hint — slides in via CSS Grid 0fr→1fr -->
          <div class="ua-warn-collapse" :class="{ 'ua-warn-collapse--open': uaHasIssue }">
            <div class="ua-warn-collapse__inner">
              <div class="ua-warn-bar">
                <span class="ua-warn-text">⚠ {{ t('preferences.ua-unsafe-chars-detected') }}</span>
                <NButton size="tiny" type="warning" ghost @click="cleanUserAgent">
                  {{ t('preferences.ua-sanitize') }}
                </NButton>
              </div>
            </div>
          </div>
        </div>
      </NFormItem>
      <NFormItem :label="t('task.task-authorization') + ':'">
        <NInput
          :value="authorization"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:authorization', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-referer') + ':'">
        <NInput
          :value="referer"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:referer', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-cookie') + ':'">
        <NInput
          :value="cookie"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:cookie', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-proxy') + ':'">
        <NInput
          :value="allProxy"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          placeholder="[http://][USER:PASSWORD@]HOST[:PORT]"
          @update:value="$emit('update:allProxy', $event)"
        />
      </NFormItem>
    </div>
  </NCollapseTransition>
</template>

<style scoped>
/* ── UA field wrapper — stacks textarea + warning ────────────────── */
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── UA warning — CSS Grid 0fr→1fr slide-in ──────────────────────── */
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
</style>
