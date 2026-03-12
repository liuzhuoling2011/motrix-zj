<script setup lang="ts">
/** @fileoverview Preference settings view with basic/advanced sub-routes. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

const { t } = useI18n()
const route = useRoute()

const tabKey = computed(() => {
  const path = route.path
  if (path.includes('advanced')) return 'advanced'
  return 'basic'
})
</script>

<template>
  <div class="preference-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4>{{ t('preferences.' + tabKey) || 'Settings' }}</h4>
    </header>
    <div class="panel-body">
      <router-view v-slot="{ Component, route: innerRoute }">
        <Transition name="pref-fade" mode="out-in">
          <component :is="Component" :key="innerRoute.path" />
        </Transition>
      </router-view>
    </div>
  </div>
</template>

<style scoped>
.preference-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-header {
  padding: 46px 0 12px;
  margin: 0 36px;
  border-bottom: 2px solid var(--panel-border);
  user-select: none;
}
.panel-header h4 {
  margin: 0;
  color: var(--panel-title);
  font-size: 16px;
  font-weight: normal;
  line-height: 24px;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
}

/* ── pref-fade: opacity-only transition for preference sub-routes ──
 * The global `fade` transition uses `transform: scale(0.98)` which creates
 * a new CSS containing block — breaking `position: sticky` on the action
 * bar and causing a visible "snap-down" at the end of the animation.
 * This variant uses pure opacity to avoid the stacking context conflict. */
.pref-fade-enter-active {
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.pref-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.pref-fade-enter-from,
.pref-fade-leave-to {
  opacity: 0;
}
</style>
