/** @fileoverview Sanitized diagnostics for external download inputs. */
import type { LogFields } from '@shared/logger'

let traceSequence = 0

function nextTraceSequence(): number {
  traceSequence = (traceSequence % 9999) + 1
  return traceSequence
}

function getExtension(pathname: string): string {
  const match = pathname.match(/\.([A-Za-z0-9]{1,16})$/)
  return match?.[1]?.toLowerCase() ?? 'none'
}

function summarizeRemoteUrl(value: string): string {
  const lower = value.toLowerCase()
  if (lower.startsWith('magnet:')) return `scheme=magnet length=${value.length}`
  if (lower.startsWith('thunder://')) return `scheme=thunder length=${value.length}`

  try {
    const parsed = new URL(value)
    const scheme = parsed.protocol.replace(':', '') || 'unknown'
    const host = parsed.hostname || 'none'
    const ext = getExtension(parsed.pathname)
    return `scheme=${scheme} host=${host} ext=${ext} hasQuery=${parsed.search ? 'true' : 'false'} length=${value.length}`
  } catch {
    return `parseable=false length=${value.length}`
  }
}

/** Returns a privacy-preserving summary that never includes query values or cookies. */
export function summarizeExternalInput(value: string): string {
  try {
    const parsed = new URL(value)
    const scheme = parsed.protocol.replace(':', '') || 'unknown'

    if (scheme !== 'motrixnext') {
      return summarizeRemoteUrl(value)
    }

    const downloadUrl = parsed.searchParams.get('url') || ''
    const action = parsed.hostname || 'none'
    return [
      `scheme=motrixnext`,
      `action=${action}`,
      `target=${downloadUrl ? summarizeRemoteUrl(downloadUrl) : 'none'}`,
      `hasReferer=${parsed.searchParams.has('referer') ? 'true' : 'false'}`,
      `hasCookie=${parsed.searchParams.has('cookie') ? 'true' : 'false'}`,
      `hasFilename=${parsed.searchParams.has('filename') ? 'true' : 'false'}`,
      `length=${value.length}`,
    ].join(' ')
  } catch {
    return summarizeRemoteUrl(value)
  }
}

export function summarizeExternalInputBatch(urls: string[]): LogFields {
  return {
    count: urls.length,
    hasNewTask: urls.some((url) => url.toLowerCase().startsWith('motrixnext://new')),
    hasCookie: urls.some((url) => {
      try {
        return new URL(url).searchParams.has('cookie')
      } catch {
        return false
      }
    }),
    first: urls[0] ? summarizeExternalInput(urls[0]) : 'none',
  }
}

export function createExternalInputTraceId(): string {
  return `external-input-${Date.now().toString(36)}-${nextTraceSequence()}`
}
