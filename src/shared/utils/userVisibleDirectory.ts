import { appDataDir, downloadDir, homeDir, join } from '@tauri-apps/api/path'
import { exists } from '@tauri-apps/plugin-fs'

export type UserVisibleDirectorySource = 'configured' | 'system-downloads' | 'home-downloads' | 'home' | 'app-data'

export interface ResolvedUserVisibleDirectory {
  path: string
  source: UserVisibleDirectorySource
  usedFallback: boolean
}

export interface UserVisibleDirectoryDeps {
  downloadDir: () => Promise<string>
  homeDir: () => Promise<string>
  appDataDir: () => Promise<string>
  exists: (path: string) => Promise<boolean>
  join: (...paths: string[]) => Promise<string>
}

export interface ResolveUserVisibleDownloadDirOptions {
  configuredDir?: string
  deps?: UserVisibleDirectoryDeps
}

const defaultDeps: UserVisibleDirectoryDeps = {
  downloadDir,
  homeDir,
  appDataDir,
  exists,
  join,
}

function cleanPath(path: string | undefined): string {
  return (path ?? '').trim()
}

function normalizeForCompare(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

async function pathExists(deps: UserVisibleDirectoryDeps, path: string): Promise<boolean> {
  try {
    return await deps.exists(path)
  } catch {
    return false
  }
}

export async function resolveUserVisibleDownloadDir(
  options: ResolveUserVisibleDownloadDirOptions = {},
): Promise<ResolvedUserVisibleDirectory> {
  const deps = options.deps ?? defaultDeps
  const configuredDir = cleanPath(options.configuredDir)
  if (configuredDir && (await pathExists(deps, configuredDir))) {
    return { path: configuredDir, source: 'configured', usedFallback: false }
  }

  let home = ''
  let homeDownloads = ''
  try {
    home = cleanPath(await deps.homeDir())
    if (home) homeDownloads = await deps.join(home, 'Downloads')
  } catch {
    home = ''
    homeDownloads = ''
  }

  let systemDownloads = ''
  try {
    systemDownloads = cleanPath(await deps.downloadDir())
  } catch {
    systemDownloads = ''
  }

  const homeDownloadsExists = homeDownloads ? await pathExists(deps, homeDownloads) : false
  const systemDownloadsExists = systemDownloads ? await pathExists(deps, systemDownloads) : false
  const systemIsHome = !!systemDownloads && !!home && normalizeForCompare(systemDownloads) === normalizeForCompare(home)

  if (systemDownloads && systemDownloadsExists && !systemIsHome) {
    return { path: systemDownloads, source: 'system-downloads', usedFallback: false }
  }

  if (homeDownloads && homeDownloadsExists) {
    return { path: homeDownloads, source: 'home-downloads', usedFallback: true }
  }

  if (systemDownloads && systemDownloadsExists) {
    return { path: systemDownloads, source: 'system-downloads', usedFallback: false }
  }

  if (home) {
    return { path: home, source: 'home', usedFallback: true }
  }

  return { path: await deps.appDataDir(), source: 'app-data', usedFallback: true }
}
