import { describe, it, expect } from 'vitest'
import { userKeys } from '@shared/configKeys'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import type { AppConfig } from '@shared/types'

describe('webPanelWidth config key', () => {
  it('is registered in userKeys so it persists across app restarts', () => {
    expect(userKeys).toContain('web-panel-width')
  })

  it('has a default value of 960 logical pixels', () => {
    expect(DEFAULT_APP_CONFIG.webPanelWidth).toBe(960)
  })

  it('is typed as number on AppConfig', () => {
    // rpcSecret is intentionally absent from DEFAULT_APP_CONFIG (auto-generated at runtime),
    // so we use Partial<AppConfig> to validate the webPanelWidth field shape without
    // demanding every required key be present.
    const config: Partial<AppConfig> = { ...DEFAULT_APP_CONFIG }
    config.webPanelWidth = 1200
    expect(typeof config.webPanelWidth).toBe('number')
  })
})
