import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { invoke } from '@tauri-apps/api/core'
import { emit as emitTauri } from '@tauri-apps/api/event'
import InternalBrowserPanel from '../InternalBrowserPanel.vue'

vi.mock('naive-ui', () => ({
  NIcon: { template: '<span><slot /></span>' },
}))

vi.mock('@vicons/ionicons5', () => ({
  ArrowBackOutline: { template: '<i />' },
  ArrowForwardOutline: { template: '<i />' },
  RefreshOutline: { template: '<i />' },
  HomeOutline: { template: '<i />' },
  CloseOutline: { template: '<i />' },
  DownloadOutline: { template: '<i />' },
}))

vi.mock('@/web/content/SiteGrid.vue', () => ({
  default: {
    emits: ['navigate'],
    template:
      '<button class="mock-site-link" @click="$emit(\'navigate\', \'https://video.example/watch\')">Video</button>',
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}))

describe('InternalBrowserPanel', () => {
  it('renders icon toolbar actions and reserves Windows titlebar clearance', () => {
    const wrapper = mount(InternalBrowserPanel, { props: { platform: 'windows' } })

    expect(wrapper.classes()).toContain('windows')
    expect(wrapper.find('[aria-label="Back"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Forward"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Refresh"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Home"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Download video"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Close"]').exists()).toBe(true)
  })

  it('navigates site links in the current iframe and emits close', async () => {
    const wrapper = mount(InternalBrowserPanel)

    await wrapper.find('.mock-site-link').trigger('click')
    expect(wrapper.find('iframe').attributes('src')).toBe('https://video.example/watch')

    await wrapper.find('[aria-label="Close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('saves webview cookies before emitting the video download action', async () => {
    const wrapper = mount(InternalBrowserPanel)

    await wrapper.find('.mock-site-link').trigger('click')
    await wrapper.find('[aria-label="Download video"]').trigger('click')

    expect(invoke).toHaveBeenCalledWith('save_cookies_and_trigger_download', {
      url: 'https://video.example/watch',
    })
    expect(emitTauri).not.toHaveBeenCalled()
  })

  it('falls back to the frontend event when cookie persistence fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('cookie store unavailable'))
    const wrapper = mount(InternalBrowserPanel)

    await wrapper.find('.mock-site-link').trigger('click')
    await wrapper.find('[aria-label="Download video"]').trigger('click')

    expect(emitTauri).toHaveBeenCalledWith('add-task-from-web', { url: 'https://video.example/watch' })
  })

  it('syncs the address bar from iframe navigation messages without reloading the iframe', async () => {
    const wrapper = mount(InternalBrowserPanel)

    await wrapper.find('.mock-site-link').trigger('click')
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: 'motrix-next-web-panel',
          type: 'url-changed',
          url: 'https://www.bilibili.com/video/BV1faQSBNEpa',
        },
      }),
    )
    await wrapper.vm.$nextTick()

    expect(wrapper.find<HTMLInputElement>('.url-input').element.value).toBe(
      'https://www.bilibili.com/video/BV1faQSBNEpa',
    )
    expect(wrapper.find('iframe').attributes('src')).toBe('https://video.example/watch')
  })
})
