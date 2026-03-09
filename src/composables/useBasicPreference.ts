/**
 * @fileoverview Pure functions extracted from Basic.vue for testability.
 *
 * Contains the basic preference form building and system config transforms.
 * The btAutoDownloadContent ↔ followTorrent/followMetalink/pauseMetadata
 * mapping is the key business logic tested here.
 */
import type { AppConfig } from '@shared/types'

// ── Types ───────────────────────────────────────────────────────────

export interface BasicForm {
  [key: string]: unknown
  autoCheckUpdate: boolean
  autoCheckUpdateInterval: number
  lastCheckUpdateTime: number
  updateChannel: string
  dir: string
  locale: string
  theme: string
  openAtLogin: boolean
  keepWindowState: boolean
  resumeAllWhenAppLaunched: boolean
  autoHideWindow: boolean
  minimizeToTrayOnClose: boolean
  showProgressBar: boolean
  traySpeedometer: boolean
  dockBadgeSpeed: boolean
  taskNotification: boolean
  newTaskShowDownloading: boolean
  noConfirmBeforeDeleteTask: boolean
  maxConcurrentDownloads: number
  maxConnectionPerServer: number
  maxOverallDownloadLimit: string
  maxOverallUploadLimit: string
  btSaveMetadata: boolean
  btAutoDownloadContent: boolean
  btForceEncryption: boolean
  keepSeeding: boolean
  seedRatio: number
  seedTime: number
  continue: boolean
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the basic form state from the preference store config.
 * The btAutoDownloadContent field merges three separate config values.
 */
export function buildBasicForm(config: AppConfig, defaultDir: string = ''): BasicForm {
  const followTorrent = config.followTorrent !== false
  const followMetalink = config.followMetalink !== false
  const pauseMetadata = !!config.pauseMetadata
  const btAutoDownloadContent = followTorrent && followMetalink && !pauseMetadata

  return {
    autoCheckUpdate: config.autoCheckUpdate !== false,
    autoCheckUpdateInterval: Number(config.autoCheckUpdateInterval) || 24,
    lastCheckUpdateTime: config.lastCheckUpdateTime || 0,
    updateChannel: config.updateChannel || 'stable',
    dir: config.dir || defaultDir,
    locale: config.locale || 'en-US',
    theme: config.theme ?? 'auto',
    openAtLogin: !!config.openAtLogin,
    keepWindowState: !!config.keepWindowState,
    resumeAllWhenAppLaunched: !!config.resumeAllWhenAppLaunched,
    autoHideWindow: !!config.autoHideWindow,
    minimizeToTrayOnClose: !!config.minimizeToTrayOnClose,
    showProgressBar: !!config.showProgressBar,
    traySpeedometer: !!config.traySpeedometer,
    dockBadgeSpeed: config.dockBadgeSpeed !== false,
    taskNotification: config.taskNotification !== false,
    newTaskShowDownloading: config.newTaskShowDownloading !== false,
    noConfirmBeforeDeleteTask: !!config.noConfirmBeforeDeleteTask,
    maxConcurrentDownloads: config.maxConcurrentDownloads || 5,
    maxConnectionPerServer: config.maxConnectionPerServer || 16,
    maxOverallDownloadLimit: String(config.maxOverallDownloadLimit || '0'),
    maxOverallUploadLimit: String(config.maxOverallUploadLimit || '0'),
    btSaveMetadata: !!config.btSaveMetadata,
    btAutoDownloadContent,
    btForceEncryption: !!config.btForceEncryption,
    keepSeeding: config.keepSeeding !== false,
    seedRatio: config.seedRatio || 1,
    seedTime: config.seedTime || 60,
    continue: config.continue !== false,
  }
}

/**
 * Converts the basic form into aria2 system config key-value pairs.
 * Handles the btAutoDownloadContent → follow-torrent/follow-metalink/pause-metadata expansion.
 */
export function buildBasicSystemConfig(f: BasicForm): Record<string, string> {
  const autoContent = !!f.btAutoDownloadContent
  return {
    dir: f.dir,
    'max-concurrent-downloads': String(f.maxConcurrentDownloads),
    'max-connection-per-server': String(f.maxConnectionPerServer),
    'max-overall-download-limit': f.maxOverallDownloadLimit,
    'max-overall-upload-limit': f.maxOverallUploadLimit,
    'bt-save-metadata': String(!!f.btSaveMetadata),
    'bt-force-encryption': String(!!f.btForceEncryption),
    'seed-ratio': String(f.seedRatio),
    'seed-time': String(f.seedTime),
    'keep-seeding': String(!!f.keepSeeding),
    'follow-torrent': String(autoContent),
    'follow-metalink': String(autoContent),
    'pause-metadata': String(!autoContent),
    continue: String(f.continue !== false),
  }
}

/**
 * Transforms the basic form for store persistence.
 * Expands btAutoDownloadContent back into followTorrent/followMetalink/pauseMetadata.
 */
export function transformBasicForStore(f: BasicForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>
  delete data.btAutoDownloadContent
  if (f.btAutoDownloadContent) {
    data.followTorrent = true
    data.followMetalink = true
    data.pauseMetadata = false
  } else {
    data.followTorrent = false
    data.followMetalink = false
    data.pauseMetadata = true
  }
  return data
}
