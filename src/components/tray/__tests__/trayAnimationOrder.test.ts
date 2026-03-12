/**
 * @fileoverview Structural tests for tray popup animation ordering.
 *
 * Problem: When the app is unfocused on macOS, onWindowShow() must
 * NOT block the animation start with async I/O.  Additionally, CSS
 * animation restart requires a real frame gap — Vue batches synchronous
 * ref changes so `false → true` in the same frame has no effect.
 *
 * Verifies:
 * 1. onWindowShow is NOT async (no `await` at all)
 * 2. Uses requestAnimationFrame for animation restart
 * 3. loadPreference is NOT awaited
 * 4. Focus guard uses window-global (survives HMR)
 * 5. exiting/hiding resets are synchronous
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TRAY_MENU = path.resolve(__dirname, '..', 'TrayMenu.vue')

describe('TrayMenu.vue — animation ordering and focus guard', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(TRAY_MENU, 'utf-8')
  })

  it('onWindowShow exists and is NOT async', () => {
    expect(source).toContain('function onWindowShow')
    // Must NOT be declared as `async function onWindowShow`
    expect(source).not.toMatch(/async\s+function\s+onWindowShow/)
  })

  it('uses requestAnimationFrame for animation restart', () => {
    const fnBody = extractFunctionBody(source, 'onWindowShow')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('requestAnimationFrame')
    // animating.value = true must appear AFTER requestAnimationFrame
    const rafIdx = fnBody!.indexOf('requestAnimationFrame')
    const animTrueIdx = fnBody!.indexOf('animating.value = true')
    expect(animTrueIdx).toBeGreaterThan(rafIdx)
  })

  it('onWindowShow contains no await', () => {
    const fnBody = extractFunctionBody(source, 'onWindowShow')
    expect(fnBody).toBeTruthy()
    expect(fnBody).not.toContain('await')
  })

  it('focus guard uses window-global (__trayFocusGuard)', () => {
    // Must use window-global, not a module-scoped variable or Vue ref
    expect(source).toContain('__trayFocusGuard')
    // Must be set in onWindowShow
    const fnBody = extractFunctionBody(source, 'onWindowShow')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('__trayFocusGuard')
  })

  it('exiting and hiding resets are synchronous', () => {
    const fnBody = extractFunctionBody(source, 'onWindowShow')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('exiting.value = false')
    expect(fnBody).toContain('hiding = false')
  })

  it('loadPreference is fire-and-forget (not awaited)', () => {
    const fnBody = extractFunctionBody(source, 'onWindowShow')
    expect(fnBody).toBeTruthy()
    expect(fnBody).toContain('loadPreference')
    // Must NOT have "await" before loadPreference
    expect(fnBody).not.toMatch(/await\s+[\w.]*loadPreference/)
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

function extractFunctionBody(source: string, fnName: string): string | null {
  const idx = source.indexOf(`function ${fnName}`)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}
