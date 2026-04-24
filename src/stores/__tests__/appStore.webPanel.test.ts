import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '@/stores/app'

describe('useAppStore webPanelOpen', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defaults webPanelOpen to false', () => {
    const store = useAppStore()
    expect(store.webPanelOpen).toBe(false)
  })

  it('allows toggling webPanelOpen', () => {
    const store = useAppStore()
    store.webPanelOpen = true
    expect(store.webPanelOpen).toBe(true)
    store.webPanelOpen = false
    expect(store.webPanelOpen).toBe(false)
  })
})
