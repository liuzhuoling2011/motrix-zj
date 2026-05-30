import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { useProtocolHandlers } from '../useProtocolHandlers'

describe('useProtocolHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-reads the real OS state after unregister fails', async () => {
    mockInvoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce({ Protocol: 'manual_change_required' })
      .mockResolvedValueOnce(true)

    const protocols = useProtocolHandlers()

    await protocols.refreshAll()
    await protocols.setProtocolEnabled('magnet', false)

    expect(mockInvoke).toHaveBeenCalledWith('remove_as_default_protocol_client', { protocol: 'magnet' })
    expect(mockInvoke).toHaveBeenLastCalledWith('is_default_protocol_client', { protocol: 'magnet' })
    expect(protocols.status.value.magnet).toBe(true)
  })
})
