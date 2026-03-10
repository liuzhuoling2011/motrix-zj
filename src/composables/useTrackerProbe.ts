/** @fileoverview Composable for probing BitTorrent tracker reachability via Rust backend. */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type TrackerStatus = 'checking' | 'online' | 'offline' | 'unknown'

export interface TrackerRow {
  url: string
  tier: number
  protocol: string
  status: TrackerStatus
}

/**
 * Extracts the protocol scheme from a tracker URL.
 * Exported for unit testing.
 */
export function parseTrackerProtocol(url: string): string {
  const match = url.match(/^(\w+):\/\//)
  return match ? match[1] : 'unknown'
}

/**
 * Builds structured tracker rows from aria2's nested announceList.
 * Each inner array is a tier; URLs within the same tier share a tier index.
 * Exported for unit testing.
 */
export function buildTrackerRows(announceList: string[][] | undefined): TrackerRow[] {
  if (!announceList || announceList.length === 0) return []

  const seen = new Set<string>()
  const rows: TrackerRow[] = []

  announceList.forEach((tierUrls, tierIndex) => {
    for (const url of tierUrls) {
      if (seen.has(url)) continue
      seen.add(url)
      rows.push({
        url,
        tier: tierIndex + 1,
        protocol: parseTrackerProtocol(url),
        status: 'unknown',
      })
    }
  })

  return rows
}

/**
 * Reactive composable that manages tracker probe state.
 * Calls the Rust `probe_trackers` IPC command to bypass browser CORS.
 */
export function useTrackerProbe() {
  const statuses = ref<Record<string, TrackerStatus>>({})
  const probing = ref(false)

  async function probeAll(urls: string[]) {
    probing.value = true
    for (const url of urls) {
      statuses.value[url] = 'checking'
    }
    try {
      const result = await invoke<Record<string, string>>('probe_trackers', { urls })
      for (const [url, status] of Object.entries(result)) {
        statuses.value[url] = status as TrackerStatus
      }
    } catch {
      for (const url of urls) {
        if (statuses.value[url] === 'checking') {
          statuses.value[url] = 'unknown'
        }
      }
    } finally {
      probing.value = false
    }
  }

  return { statuses, probing, probeAll }
}
