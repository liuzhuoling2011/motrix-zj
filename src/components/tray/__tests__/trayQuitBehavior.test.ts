/**
 * @fileoverview Structural tests for tray quit direct-exit behavior.
 *
 * Industry standard (Discord, Telegram, Slack, Steam):
 *   - Tray right-click → Quit → directly exits (no confirmation dialog)
 *   - Window X button → may show minimize/quit dialog
 *
 * Architecture: All three platforms use native menus. The "tray-quit" menu
 * event in Rust emits a 'tray-menu-action' event with payload 'quit'.
 * MainLayout.vue handles this by calling handleExitConfirm() directly
 * WITHOUT showing the exit dialog or the main window.
 *
 * Verifies:
 * 1. Rust: tray-quit emits tray-menu-action (not app.exit)
 * 2. Vue: tray quit case does NOT set showExitDialog
 * 3. Vue: tray quit case does NOT call mainWindow.show()
 * 4. Vue: tray quit case calls handleExitConfirm (direct exit)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const MAIN_LAYOUT = path.join(PROJECT_ROOT, 'src', 'layouts', 'MainLayout.vue')
const TRAY_RS = path.join(PROJECT_ROOT, 'src-tauri', 'src', 'tray.rs')

// ═══════════════════════════════════════════════════════════════════
// Group 1: Rust — tray-quit emits event (not direct exit)
// ═══════════════════════════════════════════════════════════════════

describe('tray.rs — quit emits tray-menu-action', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_RS, 'utf-8')
  })

  it('handles tray-quit in on_menu_event', () => {
    expect(source).toContain('"tray-quit"')
  })

  it('emits tray-menu-action with "quit" payload', () => {
    // Extract the on_menu_event block
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()

    // Find the tray-quit arm
    const quitIdx = menuEventBlock!.indexOf('"tray-quit"')
    expect(quitIdx).toBeGreaterThan(-1)

    // Extract from tray-quit to the next match arm (or end of block)
    const nextArmOrEnd = menuEventBlock!.indexOf('_ =>', quitIdx)
    const endIdx = nextArmOrEnd !== -1 ? nextArmOrEnd : menuEventBlock!.length
    const afterQuit = menuEventBlock!.slice(quitIdx, endIdx)
    expect(afterQuit).toContain('tray-menu-action')
    expect(afterQuit).toContain('"quit"')
  })

  it('does NOT call app.exit() directly in quit handler', () => {
    const menuEventBlock = extractOnMenuEvent(source)
    expect(menuEventBlock).toBeTruthy()

    const quitIdx = menuEventBlock!.indexOf('"tray-quit"')
    // Find the next match arm or closing brace to scope the check
    const nextArmIdx = menuEventBlock!.indexOf('_ =>', quitIdx)
    const quitSlice = menuEventBlock!.slice(quitIdx, nextArmIdx !== -1 ? nextArmIdx : quitIdx + 300)

    expect(quitSlice).not.toMatch(/app\.exit\(/)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: Vue — MainLayout.vue handles tray quit
// ═══════════════════════════════════════════════════════════════════

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
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toContain('showExitDialog')
  })

  it('does NOT call mainWindow.show() on tray quit', () => {
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toMatch(/mainWindow\.show\(\)|\.show\(\)/)
  })

  it('does NOT call mainWindow.setFocus() on tray quit', () => {
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).not.toMatch(/setFocus/)
  })

  it('calls handleExitConfirm() for direct exit', () => {
    expect(quitCaseBlock).toBeTruthy()
    expect(quitCaseBlock).toContain('handleExitConfirm')
  })

  it('onCloseRequested still allows showExitDialog for window close', () => {
    const closeHandler = extractCloseRequestedHandler(source)
    expect(closeHandler).toBeTruthy()
    expect(closeHandler).toContain('showExitDialog')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the 'quit' case block from the tray-menu-action listener.
 */
function extractTrayQuitCase(source: string): string | null {
  const trayListenerIdx = source.indexOf("'tray-menu-action'")
  if (trayListenerIdx === -1) return null
  const quitCaseIdx = source.indexOf("case 'quit':", trayListenerIdx)
  if (quitCaseIdx === -1) return null
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

/**
 * Extract the .on_menu_event(...) handler block from Rust source.
 */
function extractOnMenuEvent(source: string): string | null {
  const marker = '.on_menu_event('
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(idx, i + 1)
  }
  return null
}
