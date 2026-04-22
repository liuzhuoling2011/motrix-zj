import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WebToolbar from '../WebToolbar.vue'

const base = { currentUrl: 'https://example.com/', canGoBack: true, canGoForward: false }

describe('WebToolbar', () => {
  it('disables "下载视频" until currentUrl is http(s)', () => {
    const w = mount(WebToolbar, { props: { ...base, currentUrl: '' } })
    expect(w.find('.btn-download').attributes('disabled')).toBeDefined()
  })

  it('enables "下载视频" for http(s) URLs', () => {
    const w = mount(WebToolbar, { props: base })
    expect(w.find('.btn-download').attributes('disabled')).toBeUndefined()
  })

  it('emits navigate on ENTER in the URL input', async () => {
    const w = mount(WebToolbar, { props: base })
    const input = w.find<HTMLInputElement>('input[type="text"]')
    await input.setValue('https://new.example.com/x')
    await input.trigger('keydown.enter')
    expect(w.emitted('navigate')?.[0]).toEqual(['https://new.example.com/x'])
  })

  it('emits back/forward/reload/home/download on button clicks', async () => {
    const w = mount(WebToolbar, { props: base })
    await w.find('.btn-back').trigger('click')
    await w.find('.btn-forward').trigger('click')
    await w.find('.btn-reload').trigger('click')
    await w.find('.btn-home').trigger('click')
    await w.find('.btn-download').trigger('click')
    expect(w.emitted('back')).toBeTruthy()
    expect(w.emitted('reload')).toBeTruthy()
    expect(w.emitted('home')).toBeTruthy()
    expect(w.emitted('download')?.[0]).toEqual(['https://example.com/'])
  })

  it('reflects canGoForward in forward button disabled state', () => {
    const w = mount(WebToolbar, { props: base })
    expect(w.find('.btn-forward').attributes('disabled')).toBeDefined()
  })
})
