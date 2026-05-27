import { describe, expect, it } from 'vitest'

describe('BitTorrent seeding mode UI', () => {
  it('uses segmented radio buttons instead of the old inverted keep-seeding switch', async () => {
    const source = (await import('@/components/preference/BitTorrent.vue?raw')).default

    expect(source).toContain('NRadioGroup')
    expect(source).toContain('NRadioButton')
    expect(source).toContain('form.seedingMode')
    expect(source).toContain('preferences.seeding-mode')
    expect(source).not.toContain('onKeepSeedingChange')
    expect(source).not.toContain(':show="!form.keepSeeding"')
    expect(source).not.toContain(`t('${'preferences.'}keep-seeding')`)
  })
})
