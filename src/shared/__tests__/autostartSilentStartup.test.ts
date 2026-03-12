/**
 * @fileoverview Structural tests for autostart-only silent startup.
 *
 * Industry standard (Discord, Telegram, Steam, Clash Verge):
 *   - System autostart → minimize to tray (silent)
 *   - Manual user launch → show main window
 *
 * The Tauri autostart plugin passes `--autostart` as a CLI arg when the
 * OS triggers an auto-launch.  The setup() function in lib.rs must check
 * for this arg before hiding the window or the macOS Dock icon.
 *
 * Verifies:
 * 1. autostart plugin is initialized with `--autostart` arg (not None)
 * 2. auto-hide window block checks `--autostart` via std::env::args
 * 3. macOS Dock-hide block also checks `--autostart`
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
const TAURI_ROOT = path.join(PROJECT_ROOT, 'src-tauri')

describe('lib.rs — autostart-only silent startup', () => {
  let libSource: string

  beforeAll(() => {
    libSource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
  })

  // ─── Test 1: autostart plugin passes --autostart arg ─────────────

  describe('autostart plugin initialization', () => {
    it('passes "--autostart" arg to tauri_plugin_autostart::init', () => {
      // The init call must use Some(vec!["--autostart"]) not None
      // This ensures the OS auto-launch entry includes the flag
      expect(libSource).toContain('tauri_plugin_autostart::init')
      // Must NOT use None as the args parameter
      const initBlock = extractAutoStartInitBlock(libSource)
      expect(initBlock).toBeTruthy()
      expect(initBlock).toContain('"--autostart"')
      expect(initBlock).not.toMatch(/\bNone\b/)
    })

    it('uses Some(vec![...]) to wrap the autostart arg', () => {
      const initBlock = extractAutoStartInitBlock(libSource)
      expect(initBlock).toBeTruthy()
      // Must wrap args in Some(vec![...]) per Tauri plugin API
      expect(initBlock).toContain('Some(vec!')
    })
  })

  // ─── Test 2: auto-hide window block checks --autostart ───────────

  describe('auto-hide window logic', () => {
    it('reads --autostart from std::env::args in the auto-hide block', () => {
      // The auto-hide block must check for --autostart before hiding.
      // This ensures manual launches always show the window.
      const autoHideBlock = extractAutoHideBlock(libSource)
      expect(autoHideBlock).toBeTruthy()
      expect(autoHideBlock).toContain('"--autostart"')
    })

    it('combines autoHideWindow preference AND --autostart check', () => {
      // Both conditions must be true: user opted in AND launched by OS
      const autoHideBlock = extractAutoHideBlock(libSource)
      expect(autoHideBlock).toBeTruthy()
      expect(autoHideBlock).toContain('autoHideWindow')
      expect(autoHideBlock).toContain('is_autostart')
    })

    it('only hides window when BOTH auto_hide AND is_autostart are true', () => {
      // The if-condition must use && (logical AND), not ||
      const autoHideBlock = extractAutoHideBlock(libSource)
      expect(autoHideBlock).toBeTruthy()
      expect(autoHideBlock).toMatch(/auto_hide\s*&&\s*is_autostart/)
    })
  })

  // ─── Test 3: macOS Dock-hide also checks --autostart ─────────────

  describe('macOS Dock-hide logic', () => {
    it('reads --autostart in the macOS Dock-hide block', () => {
      // The Dock-hide block (ActivationPolicy::Accessory) must also
      // respect --autostart — hiding the Dock icon on manual launch
      // would confuse users.
      const dockBlock = extractDockHideBlock(libSource)
      expect(dockBlock).toBeTruthy()
      expect(dockBlock).toContain('"--autostart"')
    })

    it('combines dock_hide AND is_autostart for Dock hiding', () => {
      const dockBlock = extractDockHideBlock(libSource)
      expect(dockBlock).toBeTruthy()
      expect(dockBlock).toContain('is_autostart')
      expect(dockBlock).toMatch(/hide_dock\s*&&\s*is_autostart/)
    })
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the tauri_plugin_autostart::init(...) call block.
 * Returns the full init() invocation including both arguments.
 */
function extractAutoStartInitBlock(source: string): string | null {
  const idx = source.indexOf('tauri_plugin_autostart::init(')
  if (idx === -1) return null
  const openParen = source.indexOf('(', idx)
  let depth = 0
  let end = openParen
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(idx, end + 1)
}

/**
 * Extract the auto-hide window block (the one that calls window.hide()).
 * Identified by the comment "Auto-hide the main window".
 */
function extractAutoHideBlock(source: string): string | null {
  const marker = 'Auto-hide the main window'
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
 * Extract the macOS Dock-hide block.
 * Identified by the comment "Hide Dock icon on startup".
 */
function extractDockHideBlock(source: string): string | null {
  const marker = 'Hide Dock icon on startup'
  const idx = source.indexOf(marker)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  // Need to go into the outer cfg block
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
