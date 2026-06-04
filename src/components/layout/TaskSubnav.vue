<script setup lang="ts">
/** @fileoverview Task status sub-navigation tabs (active, waiting, stopped). */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { PlayOutline, CheckmarkDoneOutline, ListOutline } from '@vicons/ionicons5'
import { type Component } from 'vue'
import SubnavPane, { type SubnavPaneItem } from '@/components/layout/SubnavPane.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const items: { key: string; icon: Component; route: string }[] = [
  { key: 'all', icon: ListOutline, route: '/task/all' },
  { key: 'active', icon: PlayOutline, route: '/task/active' },
  { key: 'stopped', icon: CheckmarkDoneOutline, route: '/task/stopped' },
]

const subnavItems = computed<SubnavPaneItem[]>(() =>
  items.map((item) => ({
    ...item,
    label: t('task.' + item.key) || item.key,
    active: isActive(item.key),
  })),
)

function nav(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}

function isActive(key: string) {
  return route.path.includes(key)
}
</script>

<template>
  <SubnavPane :title="t('subnav.task-list') || 'Tasks'" :items="subnavItems" @navigate="nav" />
</template>
