import { PROXY_SCOPES } from '@shared/constants'
import type { ProxyConfig } from '@shared/types'
import { buildProxyUrlWithCredentials } from '@shared/utils/proxyUrl'

export type AppProxyScope = (typeof PROXY_SCOPES)[keyof typeof PROXY_SCOPES]

export function resolveAppProxyUrl(proxy: Partial<ProxyConfig> | undefined, scope: AppProxyScope): string | null {
  if (!proxy || proxy.mode !== 'manual') return null
  if (!proxy.server?.trim()) return null
  if (!Array.isArray(proxy.scope) || !proxy.scope.includes(scope)) return null
  return buildProxyUrlWithCredentials(proxy)
}
