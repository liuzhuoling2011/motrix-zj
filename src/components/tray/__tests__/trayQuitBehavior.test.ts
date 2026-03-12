/**
 * @fileoverview Structural tests for tray quit direct-exit behavior.
 *
 * Industry standard (Discord, Telegram, Slack, Steam):
 *   - Tray right-click → Quit → directly exits (no confirmation dialog)
 *   - Window X button → may show minimize/quit dialog
 *
 * The Vue custom tray menu emits 'tray-menu-action' with payload 'quit'.
 * The handler in MainLayout.vue must call handleExitConfirm() directly
 * WITHOUT showing the exit dialog or the main window.
 *
 * Verifies:
 * 1. tray quit case does NOT set showExitDialog
 * 2. tray quit case does NOT call mainWindow.show()
 * 3. tray quit case calls handleExitConfirm (direct exit)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MAIN_LAYOUT = path.join(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue')

describe('MainLayout.vue — tray quit direct exit', () => {
  let source: string
  let quitCaseBlock: string | null

  beforeAll(() => {
    source = fs.readFileSync(MAIN_LAYOUT, 'utf-8')
    quitCaseBlock = extractTrayQuitCase(source)
  })

  it('has a quit case in the tray-menu-action handler', () => {
    expect(quitCaseBlock).toBeTruthy()
  })

  it('does NOT show the exit dialog on tray quit', () => {
    // Tray quit must bypass the dialog — unlike window close (X button)
    // which may still show the dialog for user choice.
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toContain('showExitDialog')
  })

  it('does NOT call mainWindow.show() on tray quit', () => {
    // Bringing the window to front before quitting is disorienting —
    // the user expects the app to simply vanish.
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toMatch(/mainWindow\.show\(\)|\.show\(\)/)
  })

  it('does NOT call mainWindow.setFocus() on tray quit', () => {
    // No reason to focus a window that is about to close.
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toMatch(/setFocus/)
  })

  it('calls handleExitConfirm() for direct exit', () => {
    // handleExitConfirm() performs the full exit sequence:
    // isExiting → exit animation → exit(0).
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).toContain('handleExitConfirm')
  })

  // Ensure window X button still has separate behavior (not affected)
  it('onCloseRequested still allows showExitDialog for window close', () => {
    // The window close handler must retain its dialog path —
    // only the tray quit path should bypass it.
    const closeHandler = extractCloseRequestedHandler(source)
    expect(closeHandler).toBeTruthy()
    expect(closeHandler).toContain('showExitDialog')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the 'quit' case block from the tray-menu-action listener.
 * Looks for `case 'quit':` and extracts until the next `break`.
 */
function extractTrayQuitCase(source: string): string | null {
  // Find the tray-menu-action listener context
  const trayListenerIdx = source.indexOf("'tray-menu-action'")
  if (trayListenerIdx === -1) return null

  // Find case 'quit' within the listener
  const quitCaseIdx = source.indexOf("case 'quit':", trayListenerIdx)
  if (quitCaseIdx === -1) return null

  // Extract from case 'quit': to the next break
  const breakIdx = source.indexOf('break', quitCaseIdx)
  if (breakIdx === -1) return null

  return source.slice(quitCaseIdx, breakIdx + 'break'.length)
}

/**
 * Extract the onCloseRequested handler body.
 */
function extractCloseRequestedHandler(source: string): string | null {
  const marker = 'onCloseRequested(async'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(idx, end + 1)
}
