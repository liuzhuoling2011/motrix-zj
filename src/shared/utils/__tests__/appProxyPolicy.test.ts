import { describe, expect, it } from 'vitest'
import { PROXY_SCOPES } from '@shared/constants'
import { resolveAppProxyUrl } from '../appProxyPolicy'

describe('resolveAppProxyUrl', () => {
  it('ignores stale proxy fields when mode is direct', () => {
    expect(
      resolveAppProxyUrl(
        {
          mode: 'direct',
          server: 'Test123',
          username: 'Test123',
          password: 'Test1234',
          scope: [PROXY_SCOPES.UPDATE_TRACKERS],
        },
        PROXY_SCOPES.UPDATE_TRACKERS,
      ),
    ).toBeNull()
  })
})
