/**
 * @fileoverview Pure functions for the BitTorrent preference tab.
 *
 * Manages BT-specific config: auto-download content, encryption, seeding,
 * discovery, max peers, and tracker management. Key business logic:
 * - btAutoDownloadContent ↔ pauseMetadata
 * - Tracker comma ↔ newline format conversion
 *
 * Tracker source URL validation (isValidTrackerSourceUrl) is co-located
 * here since it is only used in the BT tab's tracker source management.
 */
import type { AppConfig } from '@shared/types'
import { DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { convertCommaToLine, convertLineToComma } from '@shared/utils'

// ── URL Validation ──────────────────────────────────────────────────

/**
 * Validates whether a string is a valid HTTP/HTTPS URL suitable for use as a
 * tracker source. Custom tracker sources are fetched via axios GET, so only
 * HTTP-based protocols are accepted.
 */
export function isValidTrackerSourceUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface BtForm {
  [key: string]: unknown
  btAutoDownloadContent: boolean
  btForceEncryption: boolean
  btDhtEnabled: boolean
  btPeerExchangeEnabled: boolean
  btLocalPeerDiscoveryEnabled: boolean
  seedingMode: 'stop-by-condition' | 'manual-stop'
  seedRatio: number
  seedTime: number
  btMaxPeers: number
  trackerSource: string[]
  customTrackerUrls: string[]
  btTracker: string
  autoSyncTracker: boolean
  lastSyncTrackerTime: number
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the BT form state from the preference store config.
 * Maps pauseMetadata into btAutoDownloadContent.
 */
export function buildBtForm(config: AppConfig): BtForm {
  const pauseMetadata = config.pauseMetadata ?? D.pauseMetadata
  const btAutoDownloadContent = !pauseMetadata
  const keepSeeding = config.keepSeeding ?? D.keepSeeding

  return {
    btAutoDownloadContent,
    btForceEncryption: config.btForceEncryption ?? D.btForceEncryption,
    btDhtEnabled: config.btDhtEnabled ?? D.btDhtEnabled,
    btPeerExchangeEnabled: config.btPeerExchangeEnabled ?? D.btPeerExchangeEnabled,
    btLocalPeerDiscoveryEnabled: config.btLocalPeerDiscoveryEnabled ?? D.btLocalPeerDiscoveryEnabled,
    seedingMode: keepSeeding ? 'manual-stop' : 'stop-by-condition',
    seedRatio: config.seedRatio ?? D.seedRatio,
    seedTime: config.seedTime ?? D.seedTime,
    btMaxPeers: config.btMaxPeers ?? D.btMaxPeers,
    trackerSource: config.trackerSource ?? [...D.trackerSource],
    customTrackerUrls: config.customTrackerUrls ?? [...D.customTrackerUrls],
    btTracker: convertCommaToLine(config.btTracker ?? D.btTracker),
    autoSyncTracker: config.autoSyncTracker ?? D.autoSyncTracker,
    lastSyncTrackerTime: config.lastSyncTrackerTime ?? D.lastSyncTrackerTime,
  }
}

/**
 * Converts the BT form into aria2 system config key-value pairs.
 * Handles btAutoDownloadContent → pause-metadata.
 *
 * IMPORTANT: force-save is intentionally excluded from global config.
 * It must only be set per-download on BT tasks to prevent aria2 from
 * re-downloading completed HTTP tasks on restart.
 */
export function buildBtSystemConfig(f: BtForm): Record<string, string> {
  const autoContent = !!f.btAutoDownloadContent
  const keepSeeding = f.seedingMode === 'manual-stop'
  const config: Record<string, string> = {
    'bt-max-peers': String(f.btMaxPeers),
    'bt-force-encryption': String(!!f.btForceEncryption),
    'bt-require-crypto': String(!!f.btForceEncryption),
    'enable-dht': String(!!f.btDhtEnabled),
    'enable-peer-exchange': String(!!f.btPeerExchangeEnabled),
    'bt-enable-lpd': String(!!f.btLocalPeerDiscoveryEnabled),
    'seed-ratio': keepSeeding ? '0' : String(f.seedRatio),
    'keep-seeding': String(keepSeeding),
    'pause-metadata': String(!autoContent),
    'bt-tracker': convertLineToComma(f.btTracker),
  }

  if (!keepSeeding) {
    config['seed-time'] = String(f.seedTime)
  }

  return config
}

/**
 * Transforms the BT form for store persistence.
 * Expands btAutoDownloadContent back into pauseMetadata.
 * Converts tracker newline format back to comma-separated for storage.
 */
export function transformBtForStore(f: BtForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>

  delete data.btAutoDownloadContent
  delete data.seedingMode

  if (f.btAutoDownloadContent) {
    data.pauseMetadata = false
  } else {
    data.pauseMetadata = true
  }

  data.keepSeeding = f.seedingMode === 'manual-stop'
  data.btTracker = convertLineToComma(f.btTracker)

  return data
}
