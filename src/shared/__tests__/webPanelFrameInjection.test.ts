import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const LIB_RS = resolve(PROJECT_ROOT, 'src-tauri', 'src', 'lib.rs')

describe('web panel frame injection', () => {
  const libSource = readFileSync(LIB_RS, 'utf-8')

  it('injects browser navigation fixes into all frames', () => {
    expect(libSource).toContain('WEB_PANEL_FRAME_INIT_SCRIPT')
    expect(libSource).toContain('js_init_script_on_all_frames')
    expect(libSource).toContain("Object.defineProperty(navigator, 'plugins'")
    expect(libSource).toContain("Object.defineProperty(navigator, 'userAgentData'")
  })

  it('rewrites new tab navigation to the current frame', () => {
    expect(libSource).toContain('window.open')
    expect(libSource).toContain("target === '_blank'")
    expect(libSource).toContain('window.location.href = anchor.href')
  })

  it('reports iframe URL changes back to the parent panel', () => {
    expect(libSource).toContain('source: MESSAGE_SOURCE')
    expect(libSource).toContain('type: MESSAGE_TYPE')
    expect(libSource).toContain('window.top.postMessage')
    expect(libSource).toContain('history.pushState')
    expect(libSource).toContain('history.replaceState')
  })
})
