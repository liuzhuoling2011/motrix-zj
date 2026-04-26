import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ref, readonly, type Ref } from 'vue'

export type SidecarName = 'ytdlp' | 'ffmpeg' | 'ffprobe'

type VersionMap = Record<SidecarName, string | null>
type RawMap = Record<string, string | null>

const cache = ref<VersionMap>({ ytdlp: null, ffmpeg: null, ffprobe: null })

function extract(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/version\s+([^\s,]+)/i)
  return m ? m[1] : raw.trim() || null
}

function applySnapshot(raw: RawMap | null | undefined): void {
  if (!raw) return
  // Merge: only overwrite a slot when we actually got a value, so a late
  // snapshot doesn't blow away an earlier successful probe.
  const next: VersionMap = { ...cache.value }
  const ytdlp = extract(raw.ytdlp ?? null)
  const ffmpeg = extract(raw.ffmpeg ?? null)
  const ffprobe = extract(raw.ffprobe ?? null)
  if (ytdlp) next.ytdlp = ytdlp
  if (ffmpeg) next.ffmpeg = ffmpeg
  if (ffprobe) next.ffprobe = ffprobe
  cache.value = next
}

// Install the Rust → frontend event bridge once at module load. The
// backend emits `sidecar-versions-ready` after every probe has settled
// (yt-dlp's first-launch PyInstaller unpack can take 3-5s, easily later
// than the initial `preloadSidecarVersions` snapshot). Importing this
// module is enough to subscribe — no component lifecycle wiring needed.
let listenerInstalled = false
async function ensureListener(): Promise<void> {
  if (listenerInstalled) return
  listenerInstalled = true
  try {
    await listen<RawMap>('sidecar-versions-ready', ({ payload }) => applySnapshot(payload))
  } catch {
    listenerInstalled = false
  }
}
void ensureListener()

/**
 * Snapshots the startup-populated sidecar version cache from Rust. Safe
 * to call repeatedly — each call merges values into the reactive cache,
 * so an early call (before slow probes finish) is harmless and a later
 * call refreshes any newly-populated slots. The push-based listener
 * installed at module load is the primary update path.
 */
export async function preloadSidecarVersions(): Promise<void> {
  await ensureListener()
  try {
    const raw = await invoke<RawMap>('get_sidecar_versions')
    applySnapshot(raw)
  } catch {
    // Swallow — components already handle null as "unavailable".
  }
}

/** Reactive read-only handle to the cached versions. Safe to use in templates. */
export function useSidecarVersions(): Readonly<Ref<VersionMap>> {
  return readonly(cache) as Readonly<Ref<VersionMap>>
}
