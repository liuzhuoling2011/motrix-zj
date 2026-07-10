import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

interface LinuxBundleConfig {
  deb?: {
    desktopTemplate?: string
  }
  rpm?: {
    desktopTemplate?: string
  }
}

interface TauriConfig {
  bundle?: {
    linux?: LinuxBundleConfig
  }
}

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const TAURI_ROOT = resolve(PROJECT_ROOT, 'src-tauri')
const LOCALES_ROOT = resolve(PROJECT_ROOT, 'src/shared/locales')
const DESKTOP_LOCALE_ALIASES = ['pt', 'zh', 'zh_HK']
const config = JSON.parse(readFileSync(resolve(TAURI_ROOT, 'tauri.conf.json'), 'utf-8')) as TauriConfig

function getDesktopTemplatePath(): string {
  const template = config.bundle?.linux?.deb?.desktopTemplate
  if (!template) {
    throw new Error('bundle.linux.deb.desktopTemplate is missing')
  }
  return resolve(TAURI_ROOT, template)
}

describe('Linux desktop entry localization', () => {
  it('covers every supported application locale', () => {
    const template = readFileSync(getDesktopTemplatePath(), 'utf-8')
    const expectedLocales = readdirSync(LOCALES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'en-US')
      .map((entry) => entry.name.replace('-', '_'))
      .concat(DESKTOP_LOCALE_ALIASES)
      .sort()
    const localizedComments = [...template.matchAll(/^Comment\[([^\]]+)\]=.+$/gm)].map((match) => match[1]).sort()

    expect(template).toMatch(/^Comment=\{\{comment\}\}$/m)
    expect(localizedComments).toEqual(expectedLocales)
  })

  it('uses one shared template for Debian and RPM bundles', () => {
    const linux = config.bundle?.linux

    expect(linux?.deb?.desktopTemplate).toBe('linux/motrix-next.desktop.hbs')
    expect(linux?.rpm?.desktopTemplate).toBe(linux?.deb?.desktopTemplate)
  })
})
