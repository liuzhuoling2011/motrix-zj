import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const WEB_BROWSER_COMMAND = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'commands', 'web_browser.rs')
const WEB_BROWSER_CAPABILITY = resolve(PROJECT_ROOT, 'src-tauri', 'capabilities', 'web-browser.json')
const TAURI_CONF = resolve(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json')

function extractRustLabel(source: string, constName: string): string {
  const match = new RegExp(`const ${constName}: &str = "([^"]+)";`).exec(source)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

function parseCspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const [name, ...sources] = tokens
    directives.set(name, sources)
  }
  return directives
}

describe('web panel capability labels', () => {
  const commandSource = readFileSync(WEB_BROWSER_COMMAND, 'utf-8')
  const capabilitySource = readFileSync(WEB_BROWSER_CAPABILITY, 'utf-8')

  it('matches the browser window label created by Rust', () => {
    const browserLabel = extractRustLabel(commandSource, 'CONTENT_LABEL')

    expect(capabilitySource).toContain(`"${browserLabel}"`)
  })

  it('does not reference obsolete child webview labels', () => {
    expect(capabilitySource).not.toContain('web-browser-toolbar')
    expect(capabilitySource).not.toContain('web-browser-content')
    expect(capabilitySource).not.toContain('web-panel-toolbar')
    expect(capabilitySource).not.toContain('web-panel-content')
  })
})

describe('web panel CSP for iframe navigation', () => {
  const tauriConf = JSON.parse(readFileSync(TAURI_CONF, 'utf-8')) as {
    app?: { security?: { csp?: string | null } }
  }
  const csp = tauriConf.app?.security?.csp
  const directives = typeof csp === 'string' ? parseCspDirectives(csp) : new Map<string, string[]>()

  it('declares frame-src so packaged Windows/Linux iframes are not blocked by default-src', () => {
    expect(typeof csp).toBe('string')
    expect(directives.has('frame-src')).toBe(true)
    // Missing frame-src falls back to default-src 'self'. WebView2 then shows
    // Chromium's 「已阻止此内容」 page for every remote iframe navigation.
    expect(directives.get('default-src')).toEqual(["'self'"])
  })

  it('allows https and http documents in the internal-browser iframe without opening wildcard frames', () => {
    const frameSrc = directives.get('frame-src') ?? []
    expect(frameSrc).toEqual(expect.arrayContaining(["'self'", 'https:', 'http:']))
    expect(frameSrc).not.toContain('*')
    expect(frameSrc).not.toContain("'none'")
    expect(frameSrc).not.toContain('data:')
    expect(frameSrc).not.toContain('blob:')
  })
})
