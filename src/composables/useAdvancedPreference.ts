/**
 * @fileoverview Pure functions extracted from Advanced.vue for testability.
 *
 * Contains configuration transforms, secret generation, and port randomization
 * logic that was previously inline in the component's script setup.
 */
import { ENGINE_RPC_PORT, PROXY_SCOPES, PROXY_SCOPE_OPTIONS } from '@shared/constants'
import { convertCommaToLine, convertLineToComma, generateRandomInt } from '@shared/utils'
import type { AppConfig } from '@shared/types'

// ── Types ───────────────────────────────────────────────────────────

export interface AdvancedForm {
  [key: string]: unknown
  proxy: {
    enable: boolean
    server: string
    bypass: string
    scope: string[]
  }
  trackerSource: string[]
  btTracker: string
  autoSyncTracker: boolean
  lastSyncTrackerTime: number
  rpcListenPort: number
  rpcSecret: string
  enableUpnp: boolean
  listenPort: number
  dhtListenPort: number
  userAgent: string
  logLevel: string
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Generates a cryptographically random secret string of 16 alphanumeric chars.
 * Used for aria2 RPC authentication.
 */
export function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

/**
 * Builds the advanced form state from the preference store config.
 * If no RPC secret exists, generates one.
 */
export function buildAdvancedForm(config: AppConfig): { form: AdvancedForm; generatedSecret: string | null } {
  const proxy = config.proxy || { enable: false, server: '', bypass: '', scope: [] }
  const savedSecret = config.rpcSecret || ''
  const rpcSecret = savedSecret || generateSecret()
  const generatedSecret = savedSecret ? null : rpcSecret

  return {
    form: {
      proxy: {
        enable: !!proxy.enable,
        server: proxy.server || '',
        bypass: proxy.bypass || '',
        scope: proxy.scope || [...PROXY_SCOPE_OPTIONS],
      },
      trackerSource: config.trackerSource || [],
      btTracker: convertCommaToLine(config.btTracker || ''),
      autoSyncTracker: !!config.autoSyncTracker,
      lastSyncTrackerTime: config.lastSyncTrackerTime || 0,
      rpcListenPort: config.rpcListenPort || ENGINE_RPC_PORT,
      rpcSecret,
      enableUpnp: config.enableUpnp !== false,
      listenPort: Number(config.listenPort) || 21301,
      dhtListenPort: Number(config.dhtListenPort) || 26701,
      userAgent: config.userAgent || '',
      logLevel: config.logLevel || 'warn',
    },
    generatedSecret,
  }
}

/**
 * Converts the advanced form into aria2 system config key-value pairs.
 * Pure function — no side effects.
 */
export function buildAdvancedSystemConfig(f: AdvancedForm): Record<string, string> {
  const proxyForDownloads =
    f.proxy.enable && Array.isArray(f.proxy.scope) && f.proxy.scope.includes(PROXY_SCOPES.DOWNLOAD)
  return {
    'rpc-listen-port': String(f.rpcListenPort),
    'rpc-secret': f.rpcSecret,
    'enable-dht': 'true',
    'enable-peer-exchange': 'true',
    'listen-port': String(f.listenPort),
    'dht-listen-port': String(f.dhtListenPort),
    'user-agent': f.userAgent || '',
    'log-level': f.logLevel || 'warn',
    'bt-tracker': convertLineToComma(f.btTracker),
    'all-proxy': proxyForDownloads ? f.proxy.server : '',
    'no-proxy': proxyForDownloads ? f.proxy.bypass || '' : '',
  }
}

/**
 * Transforms the advanced form for store persistence.
 * Normalizes tracker format and port types.
 */
export function transformAdvancedForStore(f: AdvancedForm): Record<string, unknown> {
  return {
    ...f,
    btTracker: convertLineToComma(f.btTracker),
    listenPort: String(f.listenPort),
    dhtListenPort: String(f.dhtListenPort),
  }
}

/**
 * Validates the advanced form before saving.
 * Returns null if valid, or an error key if invalid.
 */
export function validateAdvancedForm(f: AdvancedForm): string | null {
  if (!f.rpcSecret) return 'preferences.rpc-secret-empty-warning'
  return null
}

// ── Port Randomization ──────────────────────────────────────────────

export function randomRpcPort(): number {
  return generateRandomInt(ENGINE_RPC_PORT, 20000)
}

export function randomBtPort(): number {
  return generateRandomInt(20000, 24999)
}

export function randomDhtPort(): number {
  return generateRandomInt(25000, 29999)
}
