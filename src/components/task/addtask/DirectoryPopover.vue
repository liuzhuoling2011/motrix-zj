<script setup lang="ts">
/**
 * @fileoverview Directory quick-pick popover for the AddTask "Save to" field.
 *
 * Renders a clock-icon button that opens an NPopover showing two groups:
 *   ⭐ Favorite directories  (pinned, manually managed)
 *   🕘 Recent directories    (auto-recorded on successful download)
 *
 * Backend CRUD is fully handled by `preferenceStore` — this component
 * only provides the UI surface.
 *
 * The button is hidden when both lists are empty to avoid showing an
 * empty popover.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { NPopover, NButton, NIcon, NEllipsis } from 'naive-ui'
import { TimeOutline, StarOutline, Star, TrashOutline } from '@vicons/ionicons5'

const emit = defineEmits<{ select: [dir: string] }>()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const popoverVisible = ref(false)

// ── Computed lists ──────────────────────────────────────────────────

const favorites = computed(() => preferenceStore.config.favoriteDirectories ?? [])
const recents = computed(() => preferenceStore.config.historyDirectories ?? [])
const hasItems = computed(() => favorites.value.length + recents.value.length > 0)

// ── Handlers ────────────────────────────────────────────────────────

function onSelect(dir: string) {
  emit('select', dir)
  popoverVisible.value = false
}

function onToggleFavorite(dir: string, isFavorite: boolean) {
  if (isFavorite) {
    preferenceStore.cancelFavoriteDirectory(dir)
  } else {
    preferenceStore.favoriteDirectory(dir)
  }
}

function onRemove(dir: string) {
  preferenceStore.removeDirectory(dir)
}

/**
 * Returns the shortest unambiguous label for a directory path.
 * Shows the last path segment, or the last two if the last segment would
 * be ambiguous (e.g. two entries both ending in "Downloads").
 */
function shortLabel(dir: string): string {
  const segments = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return segments.length >= 2 ? segments.slice(-2).join('/') : segments[segments.length - 1] || dir
}
</script>

<template>
  <NPopover
    v-if="hasItems"
    v-model:show="popoverVisible"
    trigger="click"
    placement="bottom-end"
    :width="340"
    content-class="dir-popover-content"
  >
    <template #trigger>
      <NButton>
        <template #icon>
          <NIcon><TimeOutline /></NIcon>
        </template>
      </NButton>
    </template>

    <!-- ⭐ Favorites -->
    <template v-if="favorites.length > 0">
      <div class="dir-popover-heading">{{ t('task.favorite-folders') }}</div>
      <div v-for="dir in favorites" :key="'fav-' + dir" class="dir-popover-item" :title="dir" @click="onSelect(dir)">
        <NEllipsis class="dir-popover-label" :tooltip="false">
          {{ shortLabel(dir) }}
        </NEllipsis>
        <div class="dir-popover-actions">
          <NButton text size="tiny" class="dir-popover-action" @click.stop="onToggleFavorite(dir, true)">
            <template #icon>
              <NIcon color="var(--color-primary)"><Star /></NIcon>
            </template>
          </NButton>
          <NButton text size="tiny" class="dir-popover-action" @click.stop="onRemove(dir)">
            <template #icon>
              <NIcon><TrashOutline /></NIcon>
            </template>
          </NButton>
        </div>
      </div>
    </template>

    <!-- 🕘 Recents -->
    <template v-if="recents.length > 0">
      <div class="dir-popover-heading" :class="{ 'dir-popover-heading--spaced': favorites.length > 0 }">
        {{ t('task.recent-folders') }}
      </div>
      <div v-for="dir in recents" :key="'rec-' + dir" class="dir-popover-item" :title="dir" @click="onSelect(dir)">
        <NEllipsis class="dir-popover-label" :tooltip="false">
          {{ shortLabel(dir) }}
        </NEllipsis>
        <div class="dir-popover-actions">
          <NButton text size="tiny" class="dir-popover-action" @click.stop="onToggleFavorite(dir, false)">
            <template #icon>
              <NIcon><StarOutline /></NIcon>
            </template>
          </NButton>
          <NButton text size="tiny" class="dir-popover-action" @click.stop="onRemove(dir)">
            <template #icon>
              <NIcon><TrashOutline /></NIcon>
            </template>
          </NButton>
        </div>
      </div>
    </template>
  </NPopover>
</template>

<style scoped>
.dir-popover-heading {
  font-size: var(--font-size-sm, 12px);
  font-weight: 600;
  color: var(--n-text-color-3, #999);
  padding: 4px 8px 2px;
  user-select: none;
}
.dir-popover-heading--spaced {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--n-border-color, var(--m3-outline-variant));
}

.dir-popover-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 5px 8px;
  border-radius: var(--border-radius, 6px);
  cursor: pointer;
  transition: background-color 0.15s;
}
.dir-popover-item:hover {
  background: var(--n-color-hover, var(--m3-surface-container-high));
}

.dir-popover-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.dir-popover-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-shrink: 0;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.dir-popover-item:hover .dir-popover-actions {
  opacity: 1;
}

.dir-popover-action {
  padding: 2px !important;
}
</style>
