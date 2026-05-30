import { describe, expect, it } from 'vitest'
import { buildDownloadProxyOptions, buildTaskProxyOptions } from '@shared/utils/proxyPolicy'

describe('proxyPolicy', () => {
  it('does not emit proxy-mode because aria2-next 2.4.0 does not support it', () => {
    expect(
      buildDownloadProxyOptions({
        enable: true,
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
      'http-proxy': '',
      'https-proxy': '',
      'ftp-proxy': '',
      'no-proxy': '',
    })
  })
})
