import { describe, expect, it } from 'vitest'
import {
  buildDownloadProxyOptions,
  buildTaskProxyOptions,
  getDefaultTaskProxyMode,
  normalizeProxyMode,
  proxySwitchValueToMode,
} from '@shared/utils/proxyPolicy'

describe('proxyPolicy', () => {
  it('normalizes legacy environment proxy mode to direct', () => {
    expect(normalizeProxyMode('auto')).toBe('direct')
  })

  it('uses manual mode when the proxy switch is enabled', () => {
    expect(proxySwitchValueToMode(true)).toBe('manual')
    expect(proxySwitchValueToMode(false)).toBe('direct')
  })

  it('does not emit proxy-mode because aria2-next 2.4.0 does not support it', () => {
    expect(
      buildDownloadProxyOptions({
        mode: 'manual',
        server: 'http://127.0.0.1:7890',
        bypass: 'localhost',
        scope: ['download'],
      }),
    ).toEqual({
      'all-proxy': 'http://127.0.0.1:7890',
      'no-proxy': 'localhost',
    })
  })

  it('clears standard aria2 proxy keys for direct task mode', () => {
    expect(buildTaskProxyOptions('direct', '')).toEqual({
      'all-proxy': '',
      'all-proxy-user': '',
      'all-proxy-passwd': '',
      'http-proxy': '',
      'http-proxy-user': '',
      'http-proxy-passwd': '',
      'https-proxy': '',
      'https-proxy-user': '',
      'https-proxy-passwd': '',
      'ftp-proxy': '',
      'ftp-proxy-user': '',
      'ftp-proxy-passwd': '',
      'no-proxy': '',
    })
  })

  it('defaults task proxy mode to direct when download scope is excluded', () => {
    expect(
      getDefaultTaskProxyMode({
        mode: 'manual',
        server: 'http://127.0.0.1:7890',
        scope: ['update-app'],
      }),
    ).toBe('direct')
  })

  it('defaults task proxy mode to manual when download scope is included', () => {
    expect(
      getDefaultTaskProxyMode({
        mode: 'manual',
        server: '',
        scope: ['download'],
      }),
    ).toBe('manual')
  })
})
