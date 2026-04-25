import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const WEB_BROWSER_COMMAND = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'commands', 'web_browser.rs')
const WEB_BROWSER_CAPABILITY = resolve(PROJECT_ROOT, 'src-tauri', 'capabilities', 'web-browser.json')

function extractRustLabel(source: string, constName: string): string {
  const match = new RegExp(`const ${constName}: &str = "([^"]+)";`).exec(source)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('web panel capability labels', () => {
  const commandSource = readFileSync(WEB_BROWSER_COMMAND, 'utf-8')
  const capabilitySource = readFileSync(WEB_BROWSER_CAPABILITY, 'utf-8')

  it('matches the browser window label created by Rust', () => {
    const browserLabel = extractRustLabel(commandSource, 'BROWSER_WINDOW_LABEL')

    expect(capabilitySource).toContain(`"${browserLabel}"`)
  })

  it('does not reference obsolete child webview labels', () => {
    expect(capabilitySource).not.toContain('web-browser-toolbar')
    expect(capabilitySource).not.toContain('web-browser-content')
    expect(capabilitySource).not.toContain('web-panel-toolbar')
    expect(capabilitySource).not.toContain('web-panel-content')
  })
})
