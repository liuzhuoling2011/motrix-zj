<script setup lang="ts">
import { SITES } from './sites'

const emit = defineEmits<{ navigate: [url: string] }>()
</script>

<template>
  <div class="site-grid">
    <button v-for="site in SITES" :key="site.id" class="site-card" type="button" @click="emit('navigate', site.url)">
      <img :src="site.icon" :alt="site.name" width="56" height="56" />
      <span class="site-name">{{ site.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.site-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
  max-width: 720px;
  margin: 80px auto;
  padding: 0 24px;
}
.site-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 12px;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: white;
  cursor: pointer;
  transition:
    transform 0.15s,
    box-shadow 0.15s;
}
.site-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}
.site-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

@media (prefers-color-scheme: dark) {
  .site-card {
    background: #2a2a2a;
    border-color: #444;
  }
  .site-card:hover {
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .site-name {
    color: #e0e0e0;
  }
}
</style>
