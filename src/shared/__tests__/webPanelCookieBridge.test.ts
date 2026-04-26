import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const WEB_BROWSER_RS = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'commands', 'web_browser.rs')
const YTDLP_RS = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'commands', 'ytdlp.rs')
const YTDLP_CLIENT_RS = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'ytdlp', 'client.rs')
const YTDLP_DOWNLOADER_RS = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'ytdlp', 'downloader.rs')
const INTERNAL_BROWSER_PANEL = resolve(PROJECT_ROOT, 'src', 'components', 'layout', 'InternalBrowserPanel.vue')
const MAIN_LAYOUT = resolve(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue')

describe('web panel cookie bridge', () => {
  const rustSource = readFileSync(WEB_BROWSER_RS, 'utf-8')
  const ytdlpSource = readFileSync(YTDLP_RS, 'utf-8')
  const ytdlpClientSource = readFileSync(YTDLP_CLIENT_RS, 'utf-8')
  const ytdlpDownloaderSource = readFileSync(YTDLP_DOWNLOADER_RS, 'utf-8')
  const panelSource = readFileSync(INTERNAL_BROWSER_PANEL, 'utf-8')
  const mainLayoutSource = readFileSync(MAIN_LAYOUT, 'utf-8')

  it('reads cookies from the platform-correct webview when downloading', () => {
    expect(rustSource).toContain('const MAIN_WINDOW_LABEL: &str = "main"')
    expect(rustSource).toContain('const CONTENT_LABEL: &str = "web-browser"')
    // macOS path embeds the page in the child webview, so its cookie store
    // is authoritative; other platforms load via iframe inside the main webview.
    expect(rustSource).toContain('#[cfg(target_os = "macos")]')
    expect(rustSource).toContain('.get_webview(CONTENT_LABEL)')
    expect(rustSource).toContain('.get_webview(MAIN_WINDOW_LABEL)')
    expect(rustSource).toContain('.save_from_webview(cookies)')
  })

  it('persists webview cookies before opening the add-task flow', () => {
    expect(panelSource).toContain("invoke('save_cookies_and_trigger_download'")
    expect(panelSource).toContain("emitTauri('add-task-from-web'")
    expect(rustSource).toContain('fn cookie_header_for_url')
    expect(rustSource).toContain('"cookie": cookie_header')
    expect(rustSource).toContain('"referer": url')
  })

  it('refreshes webview cookies before yt-dlp parse and download commands', () => {
    expect(ytdlpSource).toContain('fn refresh_webview_cookie_store')
    expect(ytdlpSource).toContain('app.get_webview(MAIN_WINDOW_LABEL)')
    expect(ytdlpSource).toContain('store.save_from_webview(cookies)')

    const parseCommand = ytdlpSource.slice(
      ytdlpSource.indexOf('pub async fn ytdlp_parse_url'),
      ytdlpSource.indexOf('ytdlp::client::parse_url'),
    )
    expect(parseCommand).toContain('refresh_webview_cookie_store(&app)')
    expect(parseCommand).toContain('referer: Option<String>')
    expect(parseCommand).toContain('referer,')
    expect(ytdlpClientSource).toContain('pub referer: Option<String>')
    expect(ytdlpClientSource).toContain('"--referer"')
    expect(ytdlpClientSource).toContain('fn prepare_ffmpeg_location')
    expect(ytdlpClientSource).toContain('ffmpeg_tool_name("ffmpeg")')
    expect(ytdlpClientSource).toContain('ffmpeg_tool_name("ffprobe")')
    expect(ytdlpClientSource).toContain('"--socket-timeout"')
    expect(ytdlpDownloaderSource).toContain('"--fragment-retries"')
  })

  it('clears stale pending batch items before opening an internal-browser download task', () => {
    const addFromWebHandler = mainLayoutSource.slice(
      mainLayoutSource.indexOf('listen<{ url: string; referer?: string; cookie?: string }>('),
      mainLayoutSource.indexOf('appStore.handleDeepLinkUrls([payload.url])') + 45,
    )
    expect(addFromWebHandler).toContain('appStore.addTaskFromWebPanel = true')
    expect(addFromWebHandler).toContain('appStore.pendingBatch = []')
    expect(addFromWebHandler.indexOf('appStore.pendingBatch = []')).toBeLessThan(
      addFromWebHandler.indexOf('appStore.handleDeepLinkUrls([payload.url])'),
    )
  })
})
