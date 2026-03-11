/**
 * @fileoverview Structural tests for the cross-platform custom tray menu.
 *
 * ALL platforms use the custom Vue-based TrayMenu.vue popup, positioned via
 * tauri-plugin-positioner (official Tauri plugin). No native OS menu is used.
 *
 * Verifies:
 * 1. Cargo.toml — tauri-plugin-positioner with tray-icon feature
 * 2. lib.rs — positioner plugin registered
 * 3. tray.rs — uses positioner API, no manual coordinate calculation,
 *    macOS left-click also triggers popup, no cfg gate on popup
 * 4. TrayMenu.vue — emits actions, auto-hides on blur
 * 5. MainLayout.vue — handles all tray-menu-action events
 * 6. trayMenuItems.ts — correct item definitions
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TAURI_ROOT = path.resolve(__dirname, '../../../../src-tauri')
const SRC_ROOT = path.resolve(__dirname, '../../../..')

// ─── Test Group 1: Cargo.toml — positioner dependency ───────────────

describe('Cargo.toml — positioner plugin dependency', () => {
  let cargoToml: string

  beforeAll(() => {
    cargoToml = fs.readFileSync(path.join(TAURI_ROOT, 'Cargo.toml'), 'utf-8')
  })

  it('has tauri-plugin-positioner dependency', () => {
    expect(cargoToml).toContain('tauri-plugin-positioner')
  })

  it('enables tray-icon feature for positioner', () => {
    // Must have features = ["tray-icon"] for tray-relative positioning
    const posLine = cargoToml.split('\n').find((l) => l.includes('tauri-plugin-positioner'))
    expect(posLine).toBeTruthy()
    expect(posLine).toContain('tray-icon')
  })
})

// ─── Test Group 2: lib.rs — plugin registration ────────────────────

describe('lib.rs — positioner plugin registration', () => {
  let libSource: string

  beforeAll(() => {
    libSource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
  })

  it('registers tauri_plugin_positioner', () => {
    expect(libSource).toContain('tauri_plugin_positioner')
  })
})

// ─── Test Group 3: tray.rs — cross-platform custom tray ─────────────

describe('tray.rs — cross-platform custom tray menu', () => {
  let traySource: string

  beforeAll(() => {
    traySource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'tray.rs'), 'utf-8')
  })

  describe('positioner-based positioning (no manual coordinates)', () => {
    it('uses tauri_plugin_positioner for popup positioning', () => {
      expect(traySource).toContain('tauri_plugin_positioner')
    })

    it('calls on_tray_event to feed tray position to positioner', () => {
      // Without on_tray_event, move_window(Position::TrayCenter) panics
      expect(traySource).toContain('on_tray_event')
    })

    it('uses Position::TrayCenter or Position::TrayBottomCenter', () => {
      const hasTrayCenterVariant =
        traySource.includes('Position::TrayCenter') || traySource.includes('Position::TrayBottomCenter')
      expect(hasTrayCenterVariant).toBe(true)
    })

    it('does NOT hardcode popup dimensions for position calculation', () => {
      // No manual y = position.y - popup_height style calculation
      expect(traySource).not.toContain('position.y - popup_height')
      expect(traySource).not.toContain('position.y - 280')
      expect(traySource).not.toContain('position.x - popup_width')
    })
  })

  describe('no native menu on any platform', () => {
    it('does NOT attach builder.menu() on any platform', () => {
      expect(traySource).not.toContain('builder.menu(')
      expect(traySource).not.toContain('builder = builder.menu(')
    })

    it('does NOT gate ensure_tray_popup with cfg(target_os)', () => {
      const fnDef = traySource.indexOf('fn ensure_tray_popup')
      expect(fnDef).toBeGreaterThanOrEqual(0)
      const linesBefore = traySource.slice(Math.max(0, fnDef - 200), fnDef)
      expect(linesBefore).not.toContain('#[cfg(target_os')
    })
  })

  describe('popup lifecycle', () => {
    it('does NOT eagerly create popup at startup', () => {
      const setupStart = traySource.indexOf('pub fn setup_tray')
      const builderStart = traySource.indexOf('TrayIconBuilder::with_id')
      expect(setupStart).toBeGreaterThanOrEqual(0)
      expect(builderStart).toBeGreaterThanOrEqual(0)
      const between = traySource.slice(setupStart, builderStart)
      const codeLines = between.split('\n').filter((l) => !l.trim().startsWith('//'))
      expect(codeLines.join('\n')).not.toContain('ensure_tray_popup(')
    })

    it('creates popup lazily inside click handler (via show_tray_popup)', () => {
      const eventBlock = extractTrayIconEventBlock(traySource)
      expect(eventBlock).toBeTruthy()
      // show_tray_popup calls ensure_tray_popup internally
      expect(eventBlock).toContain('show_tray_popup')
    })

    it('popup starts hidden (visible=false)', () => {
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.visible(false)')
    })

    it('popup has shadow disabled to prevent macOS water stain artifact', () => {
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.shadow(false)')
    })

    it('popup accepts first mouse click without requiring prior focus (macOS)', () => {
      // On macOS, an unfocused window swallows the first click just to gain focus.
      // accept_first_mouse(true) makes buttons respond immediately on show.
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.accept_first_mouse(true)')
    })
  })

  describe('left-click shows main window (all platforms)', () => {
    it('left-click handler shows and focuses main window', () => {
      const leftClickBlock = extractClickBlock(traySource, 'MouseButton::Left')
      expect(leftClickBlock).toBeTruthy()
      expect(leftClickBlock).toContain('window.show()')
      expect(leftClickBlock).toContain('window.set_focus()')
    })
  })

  describe('right-click handler (all platforms)', () => {
    it('handles MouseButton::Right without cfg gate', () => {
      const rightClickIdx = traySource.indexOf('MouseButton::Right')
      expect(rightClickIdx).toBeGreaterThanOrEqual(0)
      const linesBefore = traySource.slice(Math.max(0, rightClickIdx - 200), rightClickIdx)
      expect(linesBefore).not.toContain('#[cfg(target_os')
    })

    it('calls show_tray_popup on right-click', () => {
      const rightClickBlock = extractClickBlock(traySource, 'MouseButton::Right')
      expect(rightClickBlock).toBeTruthy()
      expect(rightClickBlock).toContain('show_tray_popup')
    })
  })
})

// ─── Test Group 4: MainLayout.vue — tray-menu-action handler ───────

describe('MainLayout.vue — tray-menu-action handler', () => {
  let mainLayoutSource: string

  beforeAll(() => {
    mainLayoutSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  it('listens for tray-menu-action event', () => {
    expect(mainLayoutSource).toContain("'tray-menu-action'")
  })

  const EXPECTED_ACTIONS = ['show', 'new-task', 'resume-all', 'pause-all', 'quit']

  for (const action of EXPECTED_ACTIONS) {
    it(`handles "${action}" action`, () => {
      const trayBlock = extractListenerBlock(mainLayoutSource, 'tray-menu-action')
      expect(trayBlock).toBeTruthy()
      expect(trayBlock).toContain(`'${action}'`)
    })
  }

  it('"new-task" calls show + setFocus before showAddTaskDialog', () => {
    const trayBlock = extractListenerBlock(mainLayoutSource, 'tray-menu-action')
    expect(trayBlock).toBeTruthy()
    const newTaskCase = extractCaseBlock(trayBlock!, "'new-task'")
    expect(newTaskCase).toBeTruthy()
    expect(newTaskCase).toContain('.show()')
    expect(newTaskCase).toContain('setFocus')
  })
})

// ─── Test Group 5: TrayMenu.vue — emission and auto-hide ───────────

describe('TrayMenu.vue — menu items and event emission', () => {
  let trayMenuSource: string

  beforeAll(() => {
    trayMenuSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'components', 'tray', 'TrayMenu.vue'), 'utf-8')
  })

  it('emits tray-menu-action on item click', () => {
    expect(trayMenuSource).toContain("emit('tray-menu-action'")
  })

  it('auto-hides popup after click', () => {
    expect(trayMenuSource).toContain('currentWindow.hide()')
  })

  it('closes on Escape key', () => {
    expect(trayMenuSource).toContain("e.key === 'Escape'")
  })

  it('closes on focus loss', () => {
    expect(trayMenuSource).toContain('onFocusChanged')
  })

  it('has focus-change delay guard to prevent race condition freeze', () => {
    // The popup must NOT respond to focus-loss immediately after showing.
    // Without a delay guard, macOS triggers onFocusChanged during show()
    // animation, causing hide/show thrashing and UI freeze.
    expect(trayMenuSource).toContain('focusGuardActive')
  })

  it('sets body background to transparent for proper window rendering', () => {
    // Without this, transparent Tauri window shows white body behind
    // the rounded-corner popup, creating a visible white rectangle.
    expect(trayMenuSource).toContain('background: transparent')
  })
})

// ─── Test Group 6: main.ts — tray-menu window skip ─────────────────

describe('main.ts — tray-menu window skips heavy initialization', () => {
  let mainSource: string

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'main.ts'), 'utf-8')
  })

  it('detects tray-menu window label to skip init', () => {
    // main.ts must check getCurrentWindow().label === 'tray-menu'
    // and skip all engine/store/clipboard initialization
    expect(mainSource).toContain("'tray-menu'")
  })

  it('returns early before heavy initialization for tray-menu window', () => {
    // The tray-menu guard must appear BEFORE preferenceStore.loadPreference()
    const trayMenuIdx = mainSource.indexOf("'tray-menu'")
    const loadPrefIdx = mainSource.indexOf('loadPreference')
    expect(trayMenuIdx).toBeGreaterThan(-1)
    expect(loadPrefIdx).toBeGreaterThan(-1)
    expect(trayMenuIdx).toBeLessThan(loadPrefIdx)
  })
})

// ─── Test Group 7: trayMenuItems.ts — completeness ──────────────────

describe('trayMenuItems.ts — menu item definitions', () => {
  let items: Array<{ type: string; id: string; labelKey?: string; icon?: string }>

  beforeAll(async () => {
    const mod = await import('../trayMenuItems')
    items = mod.TRAY_MENU_ITEMS
  })

  it('has exactly 7 entries (5 actions + 2 separators)', () => {
    expect(items).toHaveLength(7)
  })

  it('has correct action IDs in order', () => {
    const actionIds = items.filter((i) => i.type === 'item').map((i) => i.id)
    expect(actionIds).toEqual(['show', 'new-task', 'resume-all', 'pause-all', 'quit'])
  })

  it('all action items have labelKey and icon', () => {
    for (const item of items.filter((i) => i.type === 'item')) {
      expect(item.labelKey).toBeTruthy()
      expect(item.icon).toBeTruthy()
    }
  })

  it('quit has danger variant', () => {
    const quit = items.find((i) => i.id === 'quit')
    expect(quit).toBeTruthy()
    expect((quit as { variant?: string }).variant).toBe('danger')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract the entire on_tray_icon_event block */
function extractTrayIconEventBlock(source: string): string | null {
  // Use the chained method call form to avoid matching doc comments
  const idx = source.indexOf('.on_tray_icon_event(')
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
  return source.slice(braceStart, end + 1)
}

/** Extract a MouseButton::X click handler block */
function extractClickBlock(source: string, button: string): string | null {
  const idx = source.indexOf(button)
  if (idx === -1) return null
  const arrowIdx = source.indexOf('=>', idx)
  if (arrowIdx === -1) return null
  const braceStart = source.indexOf('{', arrowIdx)
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
  return source.slice(braceStart, end + 1)
}

/** Extract function body by name */
function extractFunctionBody(source: string, fnName: string): string | null {
  const idx = source.indexOf(`fn ${fnName}`)
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
  return source.slice(braceStart, end + 1)
}

/** Extract event listener block from Vue source */
function extractListenerBlock(source: string, eventName: string): string | null {
  const needle = `'${eventName}'`
  const idx = source.indexOf(needle)
  if (idx === -1) return null
  const arrowIdx = source.indexOf('=>', idx)
  if (arrowIdx === -1) return null
  const braceStart = source.indexOf('{', arrowIdx)
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
  return source.slice(braceStart, end + 1)
}

/** Extract a switch-case block */
function extractCaseBlock(source: string, caseValue: string): string | null {
  const needle = `case ${caseValue}:`
  const idx = source.indexOf(needle)
  if (idx === -1) return null
  const afterCase = source.slice(idx)
  const breakIdx = afterCase.indexOf('break')
  const nextCaseIdx = afterCase.indexOf('\n      case ', needle.length)
  let end: number
  if (breakIdx !== -1 && (nextCaseIdx === -1 || breakIdx < nextCaseIdx)) {
    end = breakIdx + 'break'.length
  } else if (nextCaseIdx !== -1) {
    end = nextCaseIdx
  } else {
    end = afterCase.length
  }
  return afterCase.slice(0, end)
}
