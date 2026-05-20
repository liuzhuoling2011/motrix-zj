/**
 * @fileoverview Verifies literal i18n keys used by source files exist.
 *
 * Locale parity alone only proves every locale matches en-US. This catches the
 * other failure mode: code calling a key that no locale defines.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC_DIR = join(__dirname, '..', '..')
const EN_US_DIR = join(__dirname, '..', 'locales', 'en-US')

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walkFiles(path)
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function extractLocaleKeys(namespace: string): Set<string> {
  const filePath = join(EN_US_DIR, `${namespace}.js`)
  const content = readFileSync(filePath, 'utf-8')
  const quoted = Array.from(content.matchAll(/^\s*'([^']+)'\s*:/gm), (m) => m[1])
  const bare = Array.from(content.matchAll(/^\s*([A-Za-z_$][\w$-]*)\s*:/gm), (m) => m[1])
  return new Set([...quoted, ...bare])
}

describe('i18n source usage', () => {
  it('only references literal keys that exist in en-US locales', () => {
    const namespaces = new Map<string, Set<string>>()
    for (const file of readdirSync(EN_US_DIR)) {
      if (file === 'index.js' || !file.endsWith('.js')) continue
      const namespace = file.replace(/\.js$/, '')
      namespaces.set(namespace, extractLocaleKeys(namespace))
    }

    const missing: string[] = []
    const callRe = /(?:\b\w+\.)?\bt\(\s*(['"])([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\1/g

    for (const filePath of walkFiles(SRC_DIR)) {
      const content = readFileSync(filePath, 'utf-8')
      let match: RegExpExecArray | null
      while ((match = callRe.exec(content)) !== null) {
        const [, , namespace, key] = match
        const keys = namespaces.get(namespace)
        if (keys?.has(key)) continue
        const line = content.slice(0, match.index).split('\n').length
        missing.push(`${relative(SRC_DIR, filePath)}:${line} ${namespace}.${key}`)
      }
    }

    expect(missing).toEqual([])
  })
})
