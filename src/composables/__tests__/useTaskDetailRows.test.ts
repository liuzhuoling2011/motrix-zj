import { describe, expect, it } from 'vitest'
import type { Aria2Task } from '@shared/types'
import {
  buildPeerDetailRows,
  buildSourceDetailRows,
  peerRowsSignature,
  sourceRowsSignature,
} from '../useTaskDetailRows'

function makeTask(uri: string): Aria2Task {
  return {
    gid: 'gid-1',
    status: 'active',
    totalLength: '100',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/file.bin',
        length: '100',
        completedLength: '0',
        selected: 'true',
        uris: [
          { uri, status: 'used' },
          { uri: `${uri}?mirror=2`, status: 'waiting' },
        ],
      },
    ],
  }
}

describe('buildSourceDetailRows', () => {
  it('uses short stable keys instead of full URLs', () => {
    const longUrl = `https://example.com/${'segment-'.repeat(80)}file.bin`
    const rows = buildSourceDetailRows(makeTask(longUrl))

    expect(rows.map((row) => row.key)).toEqual(['1-0', '1-1'])
    expect(rows[0].uri).toBe(longUrl)
  })

  it('signs source rows by shape so URL churn does not rebuild the table', () => {
    expect(sourceRowsSignature(makeTask('https://a.example/file.bin'))).toBe(
      sourceRowsSignature(makeTask('https://b.example/file.bin')),
    )
  })
})

describe('buildPeerDetailRows', () => {
  it('sorts peers by host and exposes IP separately for GeoIP lookup', () => {
    const rows = buildPeerDetailRows([
      {
        peerId: '-TR3000-abcdefghijkl',
        ip: '203.0.113.2',
        port: '6881',
        bitfield: 'ff',
        amChoking: 'true',
        peerChoking: 'false',
        downloadSpeed: '0',
        uploadSpeed: '10',
        seeder: 'true',
      },
      {
        peerId: '-qB5000-abcdefghijkl',
        ip: '198.51.100.1',
        port: '6881',
        bitfield: '',
        amChoking: 'false',
        peerChoking: 'true',
        downloadSpeed: '20',
        uploadSpeed: '0',
        seeder: 'false',
      },
    ])

    expect(rows.map((row) => row.host)).toEqual(['198.51.100.1:6881', '203.0.113.2:6881'])
    expect(rows.map((row) => row.ip)).toEqual(['198.51.100.1', '203.0.113.2'])
  })

  it('signs peers by endpoint only for active-tab GeoIP gating', () => {
    const a = [{ ip: '198.51.100.1', port: '6881' }]
    const b = [{ ip: '198.51.100.1', port: '6881' }]

    expect(peerRowsSignature(a as never)).toBe(peerRowsSignature(b as never))
  })
})
