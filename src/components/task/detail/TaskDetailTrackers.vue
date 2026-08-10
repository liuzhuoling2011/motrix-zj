<script setup lang="ts">
import { computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDataTable, NTag } from 'naive-ui'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import type { Aria2BtInfo } from '@shared/types'
import { buildTrackerRows, useTrackerProbe, type TrackerRow } from '@/composables/useTrackerProbe'
import { renderDetailCopyableText } from './TaskDetailShared'

const props = defineProps<{
  btInfo: Aria2BtInfo | null
  tooltip: string
  onCopy: (value: string, label: string) => void
}>()

const { t } = useI18n()

const {
  statuses: trackerStatuses,
  probing: trackerProbing,
  probeAll: probeTrackers,
  cancelProbe: cancelTrackerProbe,
} = useTrackerProbe()

const rows = computed((): TrackerRow[] => {
  if (!props.btInfo) return []
  const trackerRows = buildTrackerRows(props.btInfo.announceList)
  return trackerRows.map((row) => ({
    ...row,
    status: trackerStatuses.value[row.url] ?? row.status,
  }))
})

const TRACKER_STATUS_ORDER: Record<string, number> = { online: 0, checking: 1, 'not-probed': 2, unknown: 3, offline: 4 }

const columns = computed(() => {
  const data = rows.value
  return [
    {
      title: t('task.task-tracker-tier'),
      key: 'tier',
      width: calcColumnWidth({
        title: t('task.task-tracker-tier'),
        values: data.map((row) => String(row.tier)),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: (a: TrackerRow, b: TrackerRow) => a.tier - b.tier,
    },
    {
      title: 'URL',
      key: 'url',
      render: (row: TrackerRow) =>
        renderDetailCopyableText({ value: row.url, label: 'URL', tooltip: props.tooltip, onCopy: props.onCopy }),
    },
    {
      title: t('task.task-tracker-protocol'),
      key: 'protocol',
      width: calcColumnWidth({
        title: t('task.task-tracker-protocol'),
        values: data.map((row) => row.protocol),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: 'default' as const,
    },
    {
      title: t('task.task-tracker-status'),
      key: 'status',
      width: calcColumnWidth({
        title: t('task.task-tracker-status'),
        values: ['online', 'offline', 'checking', 'not-probed', 'unknown'].map((status) =>
          t(`task.task-tracker-${status}`),
        ),
        sortable: true,
        extraWidth: 20,
      }),
      align: 'center' as const,
      sorter: (a: TrackerRow, b: TrackerRow) =>
        (TRACKER_STATUS_ORDER[a.status] ?? 2) - (TRACKER_STATUS_ORDER[b.status] ?? 2),
      render: (row: TrackerRow) =>
        h(
          NTag,
          {
            type: row.status === 'online' ? 'success' : row.status === 'offline' ? 'error' : 'default',
            size: 'small',
            round: true,
            style: 'transition: all 0.3s cubic-bezier(0.05, 0.7, 0.1, 1)',
          },
          () => t(`task.task-tracker-${row.status}`),
        ),
    },
  ]
})

function handleProbeTrackers() {
  if (trackerProbing.value) {
    cancelTrackerProbe()
    return
  }
  probeTrackers(rows.value.map((row) => row.url))
}
</script>

<template>
  <div style="margin-bottom: 12px; height: 34px">
    <NButton
      size="medium"
      :type="trackerProbing ? 'default' : 'primary'"
      class="probe-btn"
      @click="handleProbeTrackers"
    >
      <template v-if="trackerProbing" #icon>
        <div class="probe-spinner" />
      </template>
      {{ trackerProbing ? t('task.task-tracker-cancel-probe') : t('task.task-tracker-probe') }}
    </NButton>
  </div>
  <NDataTable
    :columns="columns"
    :data="rows"
    :row-key="(row: TrackerRow) => row.url"
    size="small"
    :bordered="true"
    :max-height="400"
    :virtual-scroll="true"
    :min-row-height="34"
    striped
  />
</template>
