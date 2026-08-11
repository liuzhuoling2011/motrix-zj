import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SiteGrid from '../SiteGrid.vue'

describe('SiteGrid', () => {
  it('renders the five supported homepage sites without YouTube', () => {
    const wrapper = mount(SiteGrid)
    expect(wrapper.findAll('.site-card')).toHaveLength(5)
    expect(wrapper.text()).not.toContain('YouTube')
  })

  it('emits navigate with the site URL when a card is clicked', async () => {
    const wrapper = mount(SiteGrid)
    await wrapper.findAll('.site-card')[0].trigger('click')
    expect(wrapper.emitted('navigate')?.[0]).toEqual(['https://www.bilibili.com'])
  })
})
