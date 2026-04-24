<script setup lang="ts">
import { computed, h } from 'vue'
import { NImage, NTag, NSpace, NButton, NRadioGroup, NRadio, NDataTable } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { VideoInfo, VideoFormat, FormatPreset } from '@shared/types'

const props = defineProps<{
  video: VideoInfo
  presets: FormatPreset[]
  selectedFormatId: string
  showAllFormats: boolean
}>()

const emit = defineEmits<{
  'update:selectedFormatId': [id: string]
  'update:showAllFormats': [show: boolean]
}>()

function formatDuration(seconds?: number): string {
  if (!seconds) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const videoFormats = computed<VideoFormat[]>(() =>
  props.video.formats.filter((f: VideoFormat) => f.vcodec && f.vcodec !== 'none'),
)

function selectTableRow(row: VideoFormat) {
  emit('update:selectedFormatId', row.formatId)
}

// The first column is an explicit radio indicator so row selection has
// unambiguous visual feedback regardless of which CSS classes Naive UI's
// scoped table shadow DOM actually propagates.  Clicking anywhere in the
// row still fires the row-wide handler (see `row-props` below).
const formatTableColumns = computed<DataTableColumns<VideoFormat>>(() => [
  {
    title: '',
    key: '__selected',
    width: 44,
    align: 'center',
    render: (row: VideoFormat) =>
      h(NRadio, {
        checked: row.formatId === props.selectedFormatId,
        onChange: () => selectTableRow(row),
      }),
  },
  { title: '分辨率', key: 'resolution', width: 100, render: (row) => row.resolution || '-' },
  { title: '扩展名', key: 'ext', width: 70 },
  { title: '编码', key: 'vcodec', width: 120, render: (row) => row.vcodec || '-' },
  {
    title: '大小',
    key: 'filesize',
    width: 100,
    render: (row) => formatFileSize(row.filesize ?? row.filesizeApprox),
  },
  { title: '协议', key: 'protocol', width: 90 },
])
</script>

<template>
  <div class="video-info-panel">
    <!-- Summary -->
    <div class="video-summary">
      <NImage
        v-if="video.thumbnail"
        :src="video.thumbnail"
        :width="160"
        object-fit="cover"
        preview-disabled
        class="video-thumbnail"
      />
      <div class="video-meta">
        <div class="video-title">{{ video.title }}</div>
        <NSpace size="small">
          <NTag size="small" :bordered="false" type="info">{{ video.extractor }}</NTag>
          <NTag v-if="video.duration" size="small" :bordered="false">{{ formatDuration(video.duration) }}</NTag>
          <NTag v-if="video.uploader" size="small" :bordered="false">{{ video.uploader }}</NTag>
          <NTag v-if="video.isLive" size="small" :bordered="false" type="error">直播</NTag>
        </NSpace>
      </div>
    </div>

    <!-- Live stream warning -->
    <div v-if="video.isLive" class="live-warning">暂不支持直播下载</div>

    <!-- Format selection -->
    <template v-else>
      <div class="format-section">
        <div class="section-label">选择格式</div>
        <NRadioGroup :value="selectedFormatId" @update:value="(v: string) => emit('update:selectedFormatId', v)">
          <NSpace>
            <NRadio v-for="preset in presets" :key="preset.formatId" :value="preset.formatId">
              {{ preset.label }}
              <span v-if="preset.estimatedSize" class="preset-size">
                (~{{ formatFileSize(preset.estimatedSize) }})
              </span>
            </NRadio>
          </NSpace>
        </NRadioGroup>
      </div>

      <NButton text type="primary" size="small" @click="emit('update:showAllFormats', !showAllFormats)">
        {{ showAllFormats ? '收起格式列表 ▲' : '显示全部格式 ▼' }}
      </NButton>

      <NDataTable
        v-if="showAllFormats"
        :columns="formatTableColumns"
        :data="videoFormats"
        :max-height="200"
        size="small"
        :row-key="(row: VideoFormat) => row.formatId"
        :row-props="
          (row: VideoFormat) => ({
            style: 'cursor: pointer;',
            class: row.formatId === selectedFormatId ? 'selected-format' : '',
            onClick: () => selectTableRow(row),
          })
        "
      />
    </template>
  </div>
</template>

<style scoped>
.video-info-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.video-summary {
  display: flex;
  gap: 12px;
}
.video-thumbnail {
  border-radius: 6px;
  flex-shrink: 0;
}
.video-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.video-title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.format-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.7;
}
.preset-size {
  font-size: 12px;
  opacity: 0.6;
}
.live-warning {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--n-warning-color-suppl, #fcf3cf);
  color: var(--n-warning-color, #f0a020);
  font-size: 13px;
}
:deep(.selected-format) {
  background: var(--n-merged-color, rgba(24, 160, 88, 0.08));
}
</style>
