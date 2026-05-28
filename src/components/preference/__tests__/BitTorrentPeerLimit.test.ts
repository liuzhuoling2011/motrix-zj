import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const componentSource = readFileSync(resolve(process.cwd(), 'src/components/preference/BitTorrent.vue'), 'utf8')

describe('BitTorrent preference peer limit control', () => {
  it('renders the BT discovery controls', () => {
    expect(componentSource).toContain("t('preferences.bt-dht')")
    expect(componentSource).toContain('v-model:value="form.btDhtEnabled"')
    expect(componentSource).toContain("t('preferences.bt-peer-exchange')")
    expect(componentSource).toContain('v-model:value="form.btPeerExchangeEnabled"')
    expect(componentSource).toContain("t('preferences.bt-local-peer-discovery')")
    expect(componentSource).toContain('v-model:value="form.btLocalPeerDiscoveryEnabled"')
  })

  it('renders the BT max peer connections setting', () => {
    expect(componentSource).toContain("t('preferences.bt-max-peers')")
    expect(componentSource).toContain('v-model:value="form.btMaxPeers"')
  })

  it('guards BT peer counts above the recommended limit', () => {
    expect(componentSource).toContain('SAFE_LIMIT_BT_MAX_PEERS')
    expect(componentSource).toContain("'preferences.high-bt-peers-reason'")
  })
})
