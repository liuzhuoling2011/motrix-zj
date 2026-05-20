import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

/**
 * Sidecar Binary Structural Tests
 *
 * Validates that all platform-specific Aria2 Next sidecar binaries are present,
 * correctly named for Tauri's externalBin resolution, and contain valid
 * executable content.
 *
 * Tauri resolves sidecars by appending the Rust target triple to the base
 * name specified in tauri.conf.json's externalBin array. For example:
 *   "binaries/motrix-next-engine" → "binaries/motrix-next-engine-aarch64-apple-darwin"
 *
 * Missing or corrupt sidecar binaries cause silent build failures or
 * runtime crashes — these tests catch both classes of defect.
 */

const BINARIES_DIR = resolve(__dirname, '..', '..', '..', 'src-tauri', 'binaries')

/**
 * Every Rust target triple that the CI release matrix builds for.
 * This list MUST stay in sync with .github/workflows/release.yml matrix.
 */
const EXPECTED_TARGETS = [
  // macOS
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  // Windows
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
  // Linux
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
] as const

/** Minimum valid sidecar size in bytes (1 MB). Anything smaller is likely corrupt. */
const MIN_SIDECAR_SIZE = 1_000_000

/**
 * Returns the expected filename for a given target triple.
 * Windows targets get a .exe extension; others do not.
 */
function sidecarFilename(target: string): string {
  const ext = target.includes('windows') ? '.exe' : ''
  return `motrix-next-engine-${target}${ext}`
}

describe('sidecar binaries', () => {
  describe('presence and naming', () => {
    for (const target of EXPECTED_TARGETS) {
      const filename = sidecarFilename(target)

      it(`${filename} exists`, () => {
        const fullPath = resolve(BINARIES_DIR, filename)
        expect(existsSync(fullPath)).toBe(true)
      })
    }
  })

  describe('file size (corruption guard)', () => {
    for (const target of EXPECTED_TARGETS) {
      const filename = sidecarFilename(target)

      it(`${filename} is larger than ${(MIN_SIDECAR_SIZE / 1_000_000).toFixed(0)} MB`, () => {
        const fullPath = resolve(BINARIES_DIR, filename)
        if (!existsSync(fullPath)) return // skip if presence test already fails
        const stat = statSync(fullPath)
        expect(stat.size).toBeGreaterThan(MIN_SIDECAR_SIZE)
      })
    }
  })

  describe('Aria2 Next 2.1.2 binary refresh', () => {
    const expectedSha256: Record<string, string> = {
      'motrix-next-engine-aarch64-apple-darwin': 'df88d034c923fd671fe968257ae0c08a097e2fc41e01451e081a70afea3536da',
      'motrix-next-engine-x86_64-apple-darwin': 'de6af9b4157258f3961e339fa9ed9ac6284605ba395382071b68081eb1b68866',
      'motrix-next-engine-aarch64-pc-windows-msvc.exe':
        '661303dbb7f4cd09e89ceb2b2a031f7b8720517bee250b08622f39903d9ad1df',
      'motrix-next-engine-x86_64-pc-windows-msvc.exe':
        '7e72d9f3bd65cc7c4ee2e34b16fedcfa0cb8b67c51c933887ac5278508f9653f',
      'motrix-next-engine-aarch64-unknown-linux-gnu':
        '728915cb88e3084410468c7965834eeef19e88554945476b188855ee725d3c1a',
      'motrix-next-engine-x86_64-unknown-linux-gnu': '65a562e9a47bb8a4a3c2af6acbf78e7a53ad1530fbf03d2bfa91a50272c225a0',
    }

    for (const [filename, expected] of Object.entries(expectedSha256)) {
      it(`${filename} matches the checked Aria2 Next 2.1.2 SHA-256`, async () => {
        const { createHash } = await import('node:crypto')
        const fullPath = resolve(BINARIES_DIR, filename)
        if (!existsSync(fullPath)) return
        const actual = createHash('sha256').update(readFileSync(fullPath)).digest('hex')
        expect(actual).toBe(expected)
      })
    }
  })

  describe('binary format validation', () => {
    for (const target of EXPECTED_TARGETS) {
      const filename = sidecarFilename(target)

      if (target.includes('windows')) {
        it(`${filename} has PE (MZ) magic bytes`, () => {
          const fullPath = resolve(BINARIES_DIR, filename)
          if (!existsSync(fullPath)) return
          const buf = readFileSync(fullPath)
          // PE executables start with "MZ" (0x4D 0x5A)
          expect(buf[0]).toBe(0x4d)
          expect(buf[1]).toBe(0x5a)
        })
      } else if (target.includes('linux')) {
        it(`${filename} has ELF magic bytes`, () => {
          const fullPath = resolve(BINARIES_DIR, filename)
          if (!existsSync(fullPath)) return
          const buf = readFileSync(fullPath)
          // ELF binaries start with 0x7F 'E' 'L' 'F'
          expect(buf[0]).toBe(0x7f)
          expect(buf[1]).toBe(0x45) // 'E'
          expect(buf[2]).toBe(0x4c) // 'L'
          expect(buf[3]).toBe(0x46) // 'F'
        })
      } else if (target.includes('apple')) {
        it(`${filename} has Mach-O magic bytes`, () => {
          const fullPath = resolve(BINARIES_DIR, filename)
          if (!existsSync(fullPath)) return
          const buf = readFileSync(fullPath)
          // Mach-O 64-bit: 0xFEEDFACF (big-endian) or 0xCFFAEDFE (little-endian)
          const magic = buf.readUInt32LE(0)
          const MACHO_64_LE = 0xfeedfacf
          const MACHO_64_BE = 0xcffaedfe
          expect([MACHO_64_LE, MACHO_64_BE]).toContain(magic)
        })
      }
    }
  })

  describe('architecture match', () => {
    for (const target of EXPECTED_TARGETS) {
      if (!target.includes('linux')) continue // ELF arch detection is most portable
      const filename = sidecarFilename(target)

      it(`${filename} targets the correct ELF architecture`, () => {
        const fullPath = resolve(BINARIES_DIR, filename)
        if (!existsSync(fullPath)) return
        const buf = readFileSync(fullPath)
        // ELF e_machine at offset 18 (2 bytes LE)
        const machine = buf.readUInt16LE(18)
        if (target.includes('x86_64')) {
          // EM_X86_64 = 62
          expect(machine).toBe(62)
        } else if (target.includes('aarch64')) {
          // EM_AARCH64 = 183
          expect(machine).toBe(183)
        }
      })
    }

    for (const target of EXPECTED_TARGETS) {
      if (!target.includes('apple')) continue
      const filename = sidecarFilename(target)

      it(`${filename} targets the correct Mach-O CPU type`, () => {
        const fullPath = resolve(BINARIES_DIR, filename)
        if (!existsSync(fullPath)) return
        const buf = readFileSync(fullPath)
        // Mach-O cputype at offset 4 (4 bytes LE for LE magic)
        const magic = buf.readUInt32LE(0)
        const isLE = magic === 0xfeedfacf
        const cputype = isLE ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
        if (target.includes('x86_64')) {
          // CPU_TYPE_X86_64 = 0x01000007
          expect(cputype).toBe(0x01000007)
        } else if (target.includes('aarch64')) {
          // CPU_TYPE_ARM64 = 0x0100000c
          expect(cputype).toBe(0x0100000c)
        }
      })
    }

    for (const target of EXPECTED_TARGETS) {
      if (!target.includes('windows')) continue
      const filename = sidecarFilename(target)

      it(`${filename} targets the correct PE machine type`, () => {
        const fullPath = resolve(BINARIES_DIR, filename)
        if (!existsSync(fullPath)) return
        const buf = readFileSync(fullPath)
        // PE signature offset is at file offset 0x3C (4 bytes LE)
        const peOffset = buf.readUInt32LE(0x3c)
        // PE signature = "PE\0\0" at peOffset
        expect(buf.readUInt32LE(peOffset)).toBe(0x00004550) // "PE\0\0"
        // Machine type at peOffset + 4 (2 bytes LE)
        const machine = buf.readUInt16LE(peOffset + 4)
        if (target.includes('x86_64')) {
          // IMAGE_FILE_MACHINE_AMD64 = 0x8664
          expect(machine).toBe(0x8664)
        } else if (target.includes('aarch64')) {
          // IMAGE_FILE_MACHINE_ARM64 = 0xAA64
          expect(machine).toBe(0xaa64)
        }
      })
    }
  })

  describe('tauri.conf.json consistency', () => {
    it('externalBin references the sidecar base name used by these binaries', () => {
      const tauriConf = JSON.parse(readFileSync(resolve(BINARIES_DIR, '..', 'tauri.conf.json'), 'utf-8'))
      const externalBin: string[] = tauriConf.bundle?.externalBin ?? []
      // At least one entry should match the sidecar base path
      expect(externalBin).toContain('binaries/motrix-next-engine')
    })
  })

  describe('CI matrix sync guard', () => {
    it('release.yml matrix covers every expected target', () => {
      const releaseYml = readFileSync(resolve(BINARIES_DIR, '..', '..', '.github', 'workflows', 'release.yml'), 'utf-8')
      for (const target of EXPECTED_TARGETS) {
        expect(releaseYml).toContain(target)
      }
    })
  })
})
