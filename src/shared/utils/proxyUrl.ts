/** @fileoverview Shared proxy URL helpers for engine and app-side network requests. */
import type { ProxyConfig } from '@shared/types'

export interface ProxyCredentials {
  username?: string
  password?: string
}

export interface ProxyEndpoint extends ProxyCredentials {
  server?: string
}

export function buildProxyUrlWithCredentials(proxy: ProxyEndpoint): string | null {
  const server = proxy.server?.trim()
  if (!server) return null
  const username = proxy.username?.trim() ?? ''
  const password = proxy.password ?? ''
  if (!username && !password) return server

  const parseTarget = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(server) ? server : `http://${server}`
  try {
    const url = new URL(parseTarget)
    url.username = username
    url.password = password
    return url.toString()
  } catch {
    return server
  }
}

export function hasProxyScope(proxy: Pick<ProxyConfig, 'scope'>, scope: string): boolean {
  return Array.isArray(proxy.scope) && proxy.scope.includes(scope)
}
