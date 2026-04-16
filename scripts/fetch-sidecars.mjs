#!/usr/bin/env node
/**
 * Fetch sidecar binaries (yt-dlp, deno, ffmpeg) for a target Rust triple
 * and place them under src-tauri/binaries/ with Tauri's expected naming.
 *
 * Usage:
 *   node scripts/fetch-sidecars.mjs [<rust-triple>]
 *
 * With no argument, detects the host triple (dev use). In CI, pass the
 * target explicitly so cross-compile builds grab the right binaries.
 *
 * Idempotent: skips files that already exist. Safe to re-run.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries')

function detectHostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  switch (process.platform) {
    case 'darwin':
      return `${arch}-apple-darwin`
    case 'linux':
      return `${arch}-unknown-linux-gnu`
    case 'win32':
      return `${arch}-pc-windows-msvc`
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

const target = process.argv[2] || detectHostTriple()
const isWindows = target.includes('windows')
const exeSuffix = isWindows ? '.exe' : ''

console.log(`[fetch-sidecars] target=${target}`)

// ── Download URLs per tool × target ───────────────────────────────────
//
// yt-dlp: GitHub releases (single binary per artefact).
// deno: GitHub releases (zip per triple). No native Windows aarch64 —
//       the x64 build works under emulation.
// ffmpeg: multiple sources; native arm64 where possible.
const YTDLP = {
  'aarch64-apple-darwin': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'x86_64-apple-darwin': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'x86_64-unknown-linux-gnu': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
  'aarch64-unknown-linux-gnu':
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64',
  'x86_64-pc-windows-msvc': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  'aarch64-pc-windows-msvc': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
}

const DENO = {
  'aarch64-apple-darwin':
    'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip',
  'x86_64-apple-darwin':
    'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip',
  'x86_64-unknown-linux-gnu':
    'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip',
  'aarch64-unknown-linux-gnu':
    'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-unknown-linux-gnu.zip',
  'x86_64-pc-windows-msvc':
    'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
  'aarch64-pc-windows-msvc':
    'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
}

const FFMPEG = {
  'aarch64-apple-darwin': 'https://www.osxexperts.net/ffmpeg81arm.zip',
  'x86_64-apple-darwin': 'https://evermeet.cx/ffmpeg/getrelease/zip',
  'x86_64-unknown-linux-gnu':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz',
  'aarch64-unknown-linux-gnu':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linuxarm64-gpl-7.1.tar.xz',
  'x86_64-pc-windows-msvc':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip',
  'aarch64-pc-windows-msvc':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip',
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts })
}

/**
 * Extracts a .zip / .tar.xz archive using the system `tar`. Must be invoked
 * with the archive filename (no path) and a cwd so that Windows bsdtar
 * doesn't misinterpret drive letters like "C:" as remote hosts.
 */
function extract(archivePath, workDir) {
  run(`tar -xf "${basename(archivePath)}"`, { cwd: workDir })
}

/**
 * Download a file via curl. Using curl (vs fetch()) because it's universally
 * available in CI and handles large downloads / redirects reliably.
 */
function download(url, dest) {
  run(`curl -fsSL "${url}" -o "${dest}"`)
}

/**
 * Walks a directory and returns the absolute path of the first file named
 * `name` (e.g. "ffmpeg" or "ffmpeg.exe"). Used to locate the binary inside
 * extracted archives whose internal layout varies per upstream.
 */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

function fetchYtdlp() {
  const out = join(BIN_DIR, `motrixnext-ytdlp-${target}${exeSuffix}`)
  if (existsSync(out)) {
    console.log(`[fetch-sidecars] yt-dlp already present, skipping`)
    return
  }
  const url = YTDLP[target]
  if (!url) throw new Error(`No yt-dlp URL for ${target}`)
  console.log(`[fetch-sidecars] yt-dlp → ${out}`)
  download(url, out)
  chmodSync(out, 0o755)
}

function fetchDeno() {
  const out = join(BIN_DIR, `motrixnext-deno-${target}${exeSuffix}`)
  if (existsSync(out)) {
    console.log(`[fetch-sidecars] deno already present, skipping`)
    return
  }
  const url = DENO[target]
  if (!url) throw new Error(`No deno URL for ${target}`)
  const work = join(tmpdir(), `motrix-deno-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const zip = join(work, 'deno.zip')
  console.log(`[fetch-sidecars] deno → ${out}`)
  download(url, zip)
  extract(zip, work)
  const binName = isWindows ? 'deno.exe' : 'deno'
  const bin = findFile(work, binName)
  if (!bin) throw new Error(`deno binary not found in archive`)
  renameSync(bin, out)
  chmodSync(out, 0o755)
  rmSync(work, { recursive: true, force: true })
}

function fetchFfmpeg() {
  const out = join(BIN_DIR, `motrixnext-ffmpeg-${target}${exeSuffix}`)
  if (existsSync(out)) {
    console.log(`[fetch-sidecars] ffmpeg already present, skipping`)
    return
  }
  const url = FFMPEG[target]
  if (!url) throw new Error(`No ffmpeg URL for ${target}`)
  const work = join(tmpdir(), `motrix-ffmpeg-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  console.log(`[fetch-sidecars] ffmpeg → ${out}`)
  if (url.endsWith('.tar.xz')) {
    const tar = join(work, 'ffmpeg.tar.xz')
    download(url, tar)
    extract(tar, work)
  } else {
    const zip = join(work, 'ffmpeg.zip')
    download(url, zip)
    extract(zip, work)
  }
  const binName = isWindows ? 'ffmpeg.exe' : 'ffmpeg'
  const bin = findFile(work, binName)
  if (!bin) throw new Error(`ffmpeg binary not found in archive`)
  renameSync(bin, out)
  chmodSync(out, 0o755)
  rmSync(work, { recursive: true, force: true })
}

// ── Main ──────────────────────────────────────────────────────────────

mkdirSync(BIN_DIR, { recursive: true })

try {
  fetchYtdlp()
  fetchDeno()
  fetchFfmpeg()

  console.log('[fetch-sidecars] done')
  for (const name of ['ytdlp', 'deno', 'ffmpeg']) {
    const p = join(BIN_DIR, `motrixnext-${name}-${target}${exeSuffix}`)
    const sz = (statSync(p).size / (1024 * 1024)).toFixed(1)
    console.log(`  ${p} (${sz} MB)`)
  }
} catch (err) {
  console.error('[fetch-sidecars] failed:', err?.message || err)
  process.exit(1)
}
