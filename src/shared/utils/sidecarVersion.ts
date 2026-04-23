import { invoke } from '@tauri-apps/api/core'
import { ref, readonly, type Ref } from 'vue'

export type SidecarName = 'ytdlp' | 'ffmpeg' | 'ffprobe'

type VersionMap = Record<SidecarName, string | null>

const cache = ref<VersionMap>({ ytdlp: null, ffmpeg: null, ffprobe: null })
let loaded = false

function extract(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/version\s+([^\s,]+)/i)
  return m ? m[1] : raw.trim() || null
}

/**
 * One-shot fetch of the startup-populated sidecar version cache from Rust.
 * Call from `main.ts` after `wait_for_engine`. Subsequent calls are no-ops.
 */
export async function preloadSidecarVersions(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = await invoke<Record<string, string | null>>('get_sidecar_versions')
    cache.value = {
      ytdlp: extract(raw.ytdlp ?? null),
      ffmpeg: extract(raw.ffmpeg ?? null),
      ffprobe: extract(raw.ffprobe ?? null),
    }
  } catch {
    // Swallow — components already handle null as "unavailable".
    loaded = false
  }
}

/** Reactive read-only handle to the cached versions. Safe to use in templates. */
export function useSidecarVersions(): Readonly<Ref<VersionMap>> {
  return readonly(cache) as Readonly<Ref<VersionMap>>
}
