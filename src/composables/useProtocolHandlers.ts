import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type ProtocolKey = 'magnet' | 'ed2k' | 'thunder' | 'motrixnext'

export type ProtocolStatus = Record<ProtocolKey, boolean>

export const protocolKeys: ProtocolKey[] = ['magnet', 'ed2k', 'thunder', 'motrixnext']

const defaultStatus: ProtocolStatus = {
  magnet: false,
  ed2k: false,
  thunder: false,
  motrixnext: false,
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) return Object.values(error as Record<string, unknown>).join(': ')
  return String(error)
}

export function useProtocolHandlers() {
  const status = ref<ProtocolStatus>({ ...defaultStatus })
  const pending = ref<ProtocolKey | null>(null)
  const lastError = ref<{ protocol: ProtocolKey; enabled: boolean; reason: string } | null>(null)

  async function readProtocol(protocol: ProtocolKey): Promise<boolean> {
    return await invoke<boolean>('is_default_protocol_client', { protocol })
  }

  async function refreshProtocol(protocol: ProtocolKey): Promise<boolean> {
    const enabled = await readProtocol(protocol)
    status.value = { ...status.value, [protocol]: enabled }
    return enabled
  }

  async function refreshAll(): Promise<void> {
    const entries = await Promise.all(protocolKeys.map(async (protocol) => [protocol, await readProtocol(protocol)]))
    status.value = Object.fromEntries(entries) as ProtocolStatus
  }

  async function setProtocolEnabled(protocol: ProtocolKey, enabled: boolean): Promise<void> {
    pending.value = protocol
    lastError.value = null
    try {
      if (enabled) {
        await invoke('set_default_protocol_client', { protocol })
      } else {
        await invoke('remove_as_default_protocol_client', { protocol })
      }
    } catch (error) {
      lastError.value = { protocol, enabled, reason: errorReason(error) }
    } finally {
      await refreshProtocol(protocol)
      pending.value = null
    }
  }

  return {
    status: computed(() => status.value),
    pending: computed(() => pending.value),
    lastError: computed(() => lastError.value),
    refreshAll,
    setProtocolEnabled,
  }
}
