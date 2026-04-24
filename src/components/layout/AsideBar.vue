<script setup lang="ts">
/** @fileoverview Sidebar navigation component. */
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'

import { NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { ListOutline, AddOutline, SettingsOutline, HelpCircleOutline, GlobeOutline } from '@vicons/ionicons5'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const emit = defineEmits<{ 'show-about': [] }>()

function nav(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}

function showAddTask() {
  appStore.showAddTaskDialog()
}

async function toggleWebPanel() {
  try {
    await invoke('toggle_web_panel', {
      open: !appStore.webPanelOpen,
      width: preferenceStore.config.webPanelWidth,
    })
  } catch (e) {
    logger.warn('AsideBar', `toggle_web_panel failed: ${e}`)
  }
}
</script>

<template>
  <aside class="aside" data-tauri-drag-region>
    <div class="aside-inner" data-tauri-drag-region>
      <h1 class="logo-mini">
        <a target="_blank" href="https://github.com/AnInsomniacy/motrix-next/">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="18" viewBox="0 0 40 18">
            <rect
              x="0.5"
              y="0.5"
              width="39"
              height="17"
              rx="4"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            />
            <text
              x="20"
              y="13"
              fill="currentColor"
              font-family="Arial, Helvetica, sans-serif"
              font-weight="900"
              font-size="10"
              text-anchor="middle"
              letter-spacing="1"
            >
              ZJ
            </text>
          </svg>
        </a>
      </h1>
      <ul class="menu top-menu" data-tauri-drag-region>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.task-list')"
                @click="nav('/task/all')"
              >
                <NIcon :size="20"><ListOutline /></NIcon>
              </button>
            </template>
            {{ t('app.task-list') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.add-task')"
                @click="showAddTask"
              >
                <NIcon :size="20"><AddOutline /></NIcon>
              </button>
            </template>
            {{ t('app.add-task') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :class="{ active: appStore.webPanelOpen }"
                aria-label="Web 浏览器面板"
                @click="toggleWebPanel"
              >
                <NIcon :size="20"><GlobeOutline /></NIcon>
              </button>
            </template>
            Web 浏览器面板
          </MTooltip>
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.about')"
                @click="emit('show-about')"
              >
                <NIcon :size="20"><HelpCircleOutline /></NIcon>
              </button>
            </template>
            {{ t('app.about') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.preferences')"
                @click="nav('/preference/general')"
              >
                <NIcon :size="20"><SettingsOutline /></NIcon>
              </button>
            </template>
            {{ t('app.preferences') }}
          </MTooltip>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.aside {
  width: var(--aside-width);
  height: 100%;
  background-color: var(--aside-bg);
  color: var(--m3-on-surface);
  flex-shrink: 0;
  z-index: 10;
}
.aside-inner {
  display: flex;
  height: 100%;
  flex-flow: column;
}
.logo-mini {
  margin: 0;
  padding: 0;
  width: 100%;
  margin-top: 50px;
}
.logo-mini > a {
  display: block;
  width: 40px;
  height: 18px;
  text-align: center;
  font-size: 0;
  outline: none;
  padding: 2px;
  margin: 0 auto;
}
.menu {
  list-style: none;
  padding: 0;
  margin: 0 auto;
  user-select: none;
  cursor: default;
}
.menu > li {
  margin-top: 24px;
}
.menu-button {
  width: 32px;
  height: 32px;
  cursor: pointer;
  border-radius: 16px;
  transition: background-color 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--m3-on-surface-variant);
  background: transparent;
  border: none;
  padding: 0;
}
.menu-button:hover,
.menu-button:focus-visible {
  background-color: var(--aside-icon-hover-bg);
  color: var(--m3-on-surface);
  outline: none;
}
.menu-button.active {
  background-color: var(--aside-icon-hover-bg);
  color: var(--m3-on-surface);
}
.menu-button.active:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.top-menu {
  flex: 1;
}
.bottom-menu {
  margin-bottom: 24px;
}
</style>
