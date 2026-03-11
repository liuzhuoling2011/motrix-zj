/**
 * @fileoverview Pure function tests for tray menu item definitions.
 *
 * HONESTY NOTE: These test REAL exported constants and pure functions.
 * No mocks of the module under test.
 */
import { describe, it, expect } from 'vitest'
import { TRAY_MENU_ITEMS, type TrayMenuItem } from '@/components/tray/trayMenuItems'

describe('TRAY_MENU_ITEMS', () => {
  it('contains all required menu actions', () => {
    const ids = TRAY_MENU_ITEMS.map((item) => item.id)
    expect(ids).toContain('show')
    expect(ids).toContain('new-task')
    expect(ids).toContain('resume-all')
    expect(ids).toContain('pause-all')
    expect(ids).toContain('quit')
  })

  it('has exactly 5 actionable items (excluding separators)', () => {
    const actionItems = TRAY_MENU_ITEMS.filter((item) => item.type !== 'separator')
    expect(actionItems).toHaveLength(5)
  })

  it('includes separators for visual grouping', () => {
    const separators = TRAY_MENU_ITEMS.filter((item) => item.type === 'separator')
    expect(separators.length).toBeGreaterThanOrEqual(1)
  })

  it('every action item has a label key and icon', () => {
    const actionItems = TRAY_MENU_ITEMS.filter((item): item is TrayMenuItem & { type: 'item' } => item.type === 'item')
    for (const item of actionItems) {
      expect(item.labelKey).toBeTruthy()
      expect(item.labelKey).toMatch(/^app\./)
      expect(item.icon).toBeTruthy()
    }
  })

  it('quit item is the last actionable item', () => {
    const actionItems = TRAY_MENU_ITEMS.filter((item) => item.type !== 'separator')
    const last = actionItems[actionItems.length - 1]
    expect(last.id).toBe('quit')
  })

  it('quit item has danger variant', () => {
    const quit = TRAY_MENU_ITEMS.find((item) => item.id === 'quit')
    expect(quit).toBeDefined()
    expect((quit as TrayMenuItem & { type: 'item' }).variant).toBe('danger')
  })
})
