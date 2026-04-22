<script setup lang="ts">
import { computed } from 'vue'
import { NCheckbox, NTag, NSpace, NScrollbar } from 'naive-ui'
import type { PlaylistInfo, PlaylistItem, FormatPreset } from '@shared/types'

const props = defineProps<{
  playlist: PlaylistInfo
  selectedItems: Set<number>
  presets: FormatPreset[]
  selectedFormatId: string
}>()

const emit = defineEmits<{
  toggleItem: [index: number]
  toggleSelectAll: []
  'update:selectedFormatId': [id: string]
}>()

const selectedCount = computed(() => props.selectedItems.size)
const totalCount = computed(() => props.playlist.entries.length)
const allSelected = computed(() => selectedCount.value === totalCount.value && totalCount.value > 0)

function formatDuration(seconds?: number): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const PAGE_SIZE = 50
const visibleEntries = computed<PlaylistItem[]>(() => props.playlist.entries.slice(0, PAGE_SIZE))
</script>

<template>
  <div class="playlist-panel">
    <!-- Header -->
    <div class="playlist-header">
      <div class="playlist-title">{{ playlist.title }}</div>
      <NSpace size="small" align="center">
        <NTag v-if="playlist.uploader" size="small" :bordered="false">{{ playlist.uploader }}</NTag>
        <span class="selection-count">已选: {{ selectedCount }}/{{ totalCount }}</span>
      </NSpace>
    </div>

    <!-- Select all -->
    <div class="select-all">
      <NCheckbox
        :checked="allSelected"
        :indeterminate="selectedCount > 0 && !allSelected"
        @update:checked="emit('toggleSelectAll')"
      >
        全选
      </NCheckbox>
    </div>

    <!-- Entry list -->
    <NScrollbar style="max-height: 300px">
      <div
        v-for="(entry, index) in visibleEntries"
        :key="entry.id"
        class="playlist-item"
        @click="emit('toggleItem', index)"
      >
        <NCheckbox :checked="selectedItems.has(index)" @update:checked="emit('toggleItem', index)" @click.stop />
        <span class="item-index">{{ index + 1 }}.</span>
        <span class="item-title">{{ entry.title }}</span>
        <span v-if="entry.duration" class="item-duration">{{ formatDuration(entry.duration) }}</span>
      </div>
      <div v-if="totalCount > PAGE_SIZE" class="pagination-hint">显示前 {{ PAGE_SIZE }} 条，共 {{ totalCount }} 条</div>
    </NScrollbar>

    <!-- Unified format selection -->
    <div class="format-section">
      <span class="section-label">统一格式:</span>
      <NSpace size="small">
        <NTag
          v-for="preset in presets"
          :key="preset.formatId"
          :type="selectedFormatId === preset.formatId ? 'success' : 'default'"
          :bordered="selectedFormatId !== preset.formatId"
          size="small"
          style="cursor: pointer"
          @click="emit('update:selectedFormatId', preset.formatId)"
        >
          {{ preset.label }}
        </NTag>
      </NSpace>
    </div>
  </div>
</template>

<style scoped>
.playlist-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.playlist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.playlist-title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selection-count {
  font-size: 12px;
  opacity: 0.6;
}
.select-all {
  padding: 4px 0;
  border-bottom: 1px solid var(--n-border-color);
}
.playlist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}
.playlist-item:hover {
  background: var(--n-merged-color, rgba(0, 0, 0, 0.04));
}
.item-index {
  font-size: 12px;
  opacity: 0.5;
  min-width: 24px;
}
.item-title {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-duration {
  font-size: 12px;
  opacity: 0.5;
  flex-shrink: 0;
}
.format-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--n-border-color);
}
.section-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.7;
  flex-shrink: 0;
}
.pagination-hint {
  padding: 8px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
</style>
