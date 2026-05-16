/**
 * @fileoverview Guards the user-facing Aria2 Next brand presentation.
 *
 * Protocol names, RPC method names, `.aria2` control files, and `aria2c`
 * command references intentionally remain lowercase aria2. This test only
 * covers labels and copy text users see in the UI.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..')

function readProjectFile(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8')
}

describe('Aria2 Next user-facing branding', () => {
  it('uses Aria2 Next in English fallback locale labels and messages', () => {
    const about = readProjectFile('src/shared/locales/en-US/about.js')
    const app = readProjectFile('src/shared/locales/en-US/app.js')
    const preferences = readProjectFile('src/shared/locales/en-US/preferences.js')
    const task = readProjectFile('src/shared/locales/en-US/task.js')

    expect(about).toContain("'aria2-version': 'Aria2 Next Version'")
    expect(app).toContain("'engine-ready': 'Aria2 Next engine is ready'")
    expect(app).toContain("'engine-crashed': 'Aria2 Next download engine disconnected'")
    expect(preferences).toContain("'engine-section': 'Aria2 Next Download Engine'")
    expect(preferences).toContain("'engine-restart-title': 'Restart Aria2 Next Engine'")
    expect(preferences).toContain(
      "'proxy-http-only-hint': 'Aria2 Next supports HTTP proxy only. SOCKS proxy is not supported.'",
    )
    expect(task).toContain(
      "'proxy-unsupported-protocol': 'Unsupported proxy protocol. Aria2 Next only supports HTTP proxies.'",
    )
  })

  it('copies Aria2 Next version text from About and General settings', () => {
    const aboutPanel = readProjectFile('src/components/about/AboutPanel.vue')
    const general = readProjectFile('src/components/preference/General.vue')

    expect(aboutPanel).toContain("copyToClipboard(`Aria2 Next v${aria2Version}`, 'Aria2 Next')")
    expect(general).toContain("copyVersionToClipboard(`Aria2 Next v${sysAria2Version}`, 'Aria2 Next')")
  })
})
