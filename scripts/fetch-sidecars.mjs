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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
} from 'node:fs'
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

// ffprobe sources. BtbN's Linux/Windows ffmpeg archives already bundle
// ffprobe, so those targets reuse the FFMPEG entries. macOS upstream ships
// them as separate archives.
const FFPROBE_STANDALONE = {
  'aarch64-apple-darwin': 'https://www.osxexperts.net/ffprobe81arm.zip',
  // evermeet's /ffprobe/getrelease path mistakenly redirects to the
  // ffmpeg archive; /ffmpeg/getrelease/ffprobe/zip is the actual
  // ffprobe endpoint.
  'x86_64-apple-darwin': 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts })
}

/**
 * Move a file across filesystems. renameSync throws EXDEV on Windows when
 * src and dst live on different drives (TMP is on C:, repo is on D: on GH
 * Actions runners). Fall back to copy + unlink in that case.
 */
function moveFile(src, dst) {
  try {
    renameSync(src, dst)
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.errno === -18)) {
      copyFileSync(src, dst)
      rmSync(src, { force: true })
    } else {
      throw err
    }
  }
}

/**
 * Extracts a .zip / .tar.xz archive into `workDir`. On Windows the bundled
 * bsdtar mishandles both drive-letter paths and plain .zip archives, so we
 * fall back to PowerShell's Expand-Archive for zips there. tar handles
 * .tar.xz on all platforms.
 */
function extract(archivePath, workDir) {
  const file = basename(archivePath)
  const isZip = archivePath.toLowerCase().endsWith('.zip')
  if (isZip && process.platform === 'win32') {
    // -Force overwrites existing contents; quoting handles spaces in the path.
    run(
      `powershell -NoProfile -Command "Expand-Archive -Path '${file}' -DestinationPath '.' -Force"`,
      { cwd: workDir },
    )
    return
  }
  run(`tar -xf "${file}"`, { cwd: workDir })
}

/**
 * Download a file via curl. Using curl (vs fetch()) because it's universally
 * available in CI and handles large downloads / redirects reliably.
 *
 * Retry flags: GitHub release CDNs occasionally return transient 5xx
 * (we've seen 502 from objects.githubusercontent.com on the Windows
 * aarch64 runner). `--retry-all-errors` is needed because curl's default
 * retry list excludes HTTP 5xx — without it a single 502 aborts the
 * whole release build.
 */
function download(url, dest) {
  run(
    `curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors --retry-max-time 180 "${url}" -o "${dest}"`,
  )
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
  moveFile(bin, out)
  chmodSync(out, 0o755)
  rmSync(work, { recursive: true, force: true })
}

/**
 * Extracts a named binary from `archiveUrl` into `outPath`. If the archive
 * is missing the requested binary, throws.
 */
function fetchFromArchive(archiveUrl, binName, outPath, label) {
  const work = join(tmpdir(), `motrix-${label}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const ext = archiveUrl.endsWith('.tar.xz') ? 'tar.xz' : 'zip'
  const archive = join(work, `${label}.${ext}`)
  download(archiveUrl, archive)
  extract(archive, work)
  const bin = findFile(work, binName)
  if (!bin) {
    rmSync(work, { recursive: true, force: true })
    throw new Error(`${binName} not found in ${archiveUrl}`)
  }
  moveFile(bin, outPath)
  chmodSync(outPath, 0o755)
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
  console.log(`[fetch-sidecars] ffmpeg → ${out}`)
  const binName = isWindows ? 'ffmpeg.exe' : 'ffmpeg'
  fetchFromArchive(url, binName, out, 'ffmpeg')
}

/**
 * Place ffprobe as `ffprobe[.exe]` in the sidecar dir. yt-dlp looks for a
 * file literally named `ffprobe` next to the ffmpeg binary — so we keep
 * the platform-specific triple in the filename (Tauri's required format)
 * but drop the `motrixnext-` prefix so yt-dlp discovers it.
 */
function fetchFfprobe() {
  const out = join(BIN_DIR, `ffprobe-${target}${exeSuffix}`)
  if (existsSync(out)) {
    console.log(`[fetch-sidecars] ffprobe already present, skipping`)
    return
  }
  console.log(`[fetch-sidecars] ffprobe → ${out}`)
  const binName = isWindows ? 'ffprobe.exe' : 'ffprobe'
  // BtbN Linux/Windows archives bundle ffprobe alongside ffmpeg.
  // macOS upstream ships them separately.
  const standalone = FFPROBE_STANDALONE[target]
  const url = standalone || FFMPEG[target]
  if (!url) throw new Error(`No ffprobe URL for ${target}`)
  fetchFromArchive(url, binName, out, 'ffprobe')
}

// ── Main ──────────────────────────────────────────────────────────────

mkdirSync(BIN_DIR, { recursive: true })

try {
  fetchYtdlp()
  fetchDeno()
  fetchFfmpeg()
  fetchFfprobe()

  console.log('[fetch-sidecars] done')
  const entries = [
    ['ytdlp', `motrixnext-ytdlp-${target}${exeSuffix}`],
    ['deno', `motrixnext-deno-${target}${exeSuffix}`],
    ['ffmpeg', `motrixnext-ffmpeg-${target}${exeSuffix}`],
    ['ffprobe', `ffprobe-${target}${exeSuffix}`],
  ]
  for (const [, file] of entries) {
    const p = join(BIN_DIR, file)
    const sz = (statSync(p).size / (1024 * 1024)).toFixed(1)
    console.log(`  ${p} (${sz} MB)`)
  }
} catch (err) {
  console.error('[fetch-sidecars] failed:', err?.message || err)
  process.exit(1)
}
