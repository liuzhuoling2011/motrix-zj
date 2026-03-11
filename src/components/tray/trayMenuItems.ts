/**
 * @fileoverview Tray menu item definitions for the custom Windows tray popup.
 *
 * Provides a typed, declarative list of menu items used by TrayMenu.vue.
 * macOS and Linux continue to use native menus (tray.rs).
 */

export interface TrayMenuActionItem {
  type: 'item'
  /** Unique action identifier emitted when clicked. */
  id: string
  /** i18n key for the display label (resolved at render time). */
  labelKey: string
  /** Ionicons5 component name (resolved at render time). */
  icon: string
  /** Optional visual variant for emphasis (e.g. quit = danger). */
  variant?: 'default' | 'danger'
}

export interface TrayMenuSeparator {
  type: 'separator'
  id: string
}

export type TrayMenuItem = TrayMenuActionItem | TrayMenuSeparator

/**
 * Declarative definition of all tray menu entries.
 *
 * Order matches the existing native menu in tray.rs:
 *   Show → separator → New Task → Resume All → Pause All → separator → Quit
 */
export const TRAY_MENU_ITEMS: TrayMenuItem[] = [
  {
    type: 'item',
    id: 'show',
    labelKey: 'app.show',
    icon: 'OpenOutline',
  },
  { type: 'separator', id: 'sep-1' },
  {
    type: 'item',
    id: 'new-task',
    labelKey: 'app.tray-new-task',
    icon: 'AddCircleOutline',
  },
  {
    type: 'item',
    id: 'resume-all',
    labelKey: 'app.tray-resume-all',
    icon: 'PlayOutline',
  },
  {
    type: 'item',
    id: 'pause-all',
    labelKey: 'app.tray-pause-all',
    icon: 'PauseOutline',
  },
  { type: 'separator', id: 'sep-2' },
  {
    type: 'item',
    id: 'quit',
    labelKey: 'app.quit',
    icon: 'PowerOutline',
    variant: 'danger',
  },
]
