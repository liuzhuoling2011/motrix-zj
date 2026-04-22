import { invoke } from '@tauri-apps/api/core'

export type SidecarName = 'ytdlp' | 'ffmpeg' | 'ffprobe'

export async function fetchSidecarVersion(name: SidecarName): Promise<string> {
  const raw = await invoke<string>('get_sidecar_version', { name })
  const m = raw.match(/version\s+([^\s,]+)/i)
  return m ? m[1] : raw.trim()
}
