<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDataTable, NTooltip, type DataTableColumns } from 'naive-ui'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { countryCodeToFlag, lookupPeerIps, type GeoInfo } from '@shared/utils/geoip'
import { logger } from '@shared/logger'
import type { Aria2Peer } from '@shared/types'
import { buildPeerDetailRows, peerRowsSignature, type PeerDetailRow } from '@/composables/useTaskDetailRows'
import { nextFrame, renderDetailCopyableText, renderDetailLongText } from './TaskDetailShared'

const props = defineProps<{
  peers: Aria2Peer[] | undefined
  locale: string
  tooltip: string
  onCopy: (value: string, label: string) => void
}>()

const { t } = useI18n()
const rows = computed(() => buildPeerDetailRows(props.peers))
const geoCache = ref<Record<string, GeoInfo>>({})
const loading = ref(false)
const hasLoaded = ref(false)
let generation = 0

watch(
  () => peerRowsSignature(props.peers),
  async (signature) => {
    const current = ++generation
    if (!hasLoaded.value) loading.value = true
    await nextFrame()
    if (current !== generation) return
    if (!signature) {
      geoCache.value = {}
      hasLoaded.value = true
      loading.value = false
      return
    }
    try {
      geoCache.value = await lookupPeerIps([...new Set(rows.value.map((row) => row.ip))], props.locale)
    } catch (e) {
      logger.debug('TaskDetail.geoip', `lookupPeerIps failed: ${e}`)
    } finally {
      if (current === generation) {
        hasLoaded.value = true
        loading.value = false
      }
    }
  },
  { immediate: true },
)

function renderPeerIndex(row: PeerDetailRow) {
  const geo = geoCache.value[row.ip]
  if (!geo) return String(row.index)
  const flag = countryCodeToFlag(geo.country_code)
  const label = `${geo.country_name} · ${geo.continent}`
  return h(
    NTooltip,
    { delay: 500, placement: 'right' },
    {
      trigger: () => h('span', { style: 'cursor: default' }, [String(row.index), ' ', flag]),
      default: () => label,
    },
  )
}

function renderPeerFlags(row: PeerDetailRow): string {
  const flags: string[] = []
  if (!row.amChoking) flags.push('D')
  if (!row.peerChoking) flags.push('U')
  return flags.join('') || '—'
}

function speedColumn(key: 'downloadSpeed' | 'uploadSpeed', title: string, data: PeerDetailRow[]) {
  return {
    title,
    key,
    width: calcColumnWidth({
      title,
      values: data.map((row) => row[key]),
      sortable: true,
    }),
    align: 'right' as const,
    sorter: (a: PeerDetailRow, b: PeerDetailRow) => parseFloat(a[key]) - parseFloat(b[key]),
  }
}

const columns = computed<DataTableColumns<PeerDetailRow>>(() => {
  const data = rows.value
  return [
    {
      title: t('task.task-tracker-tier'),
      key: 'index',
      width: 64,
      align: 'center',
      sorter: (a, b) => a.index - b.index,
      defaultSortOrder: 'ascend',
      render: renderPeerIndex,
    },
    {
      title: t('task.task-peer-host'),
      key: 'host',
      minWidth: 140,
      render: (row) =>
        renderDetailCopyableText({
          value: row.host,
          label: t('task.task-peer-host'),
          tooltip: props.tooltip,
          onCopy: props.onCopy,
        }),
    },
    {
      title: t('task.task-peer-client'),
      key: 'client',
      minWidth: 100,
      render: (row) => renderDetailLongText(row.client),
    },
    {
      title: t('task.task-peer-percent'),
      key: 'percent',
      width: calcColumnWidth({
        title: t('task.task-peer-percent'),
        values: data.map((row) => row.percent),
        sortable: true,
      }),
      align: 'right',
      sorter: (a, b) => parseFloat(a.percent) - parseFloat(b.percent),
    },
    speedColumn('downloadSpeed', t('task.task-peer-download-speed'), data),
    speedColumn('uploadSpeed', t('task.task-peer-upload-speed'), data),
    {
      title: t('task.task-peer-flags'),
      key: 'flags',
      width: calcColumnWidth({
        title: t('task.task-peer-flags'),
        values: ['DU', 'D', 'U', '—'],
      }),
      align: 'center',
      render: renderPeerFlags,
    },
    {
      title: t('task.task-peer-seeder'),
      key: 'seeder',
      width: calcColumnWidth({
        title: t('task.task-peer-seeder'),
        values: ['✓'],
        sortable: true,
      }),
      align: 'center',
      sorter: (a, b) => Number(b.seeder) - Number(a.seeder),
      render: (row) => (row.seeder ? '✓' : ''),
    },
  ]
})
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="rows"
    :row-key="(row: PeerDetailRow) => row.host"
    :loading="loading"
    size="small"
    :bordered="true"
    :max-height="400"
    :virtual-scroll="true"
    :min-row-height="34"
    striped
  />
</template>
