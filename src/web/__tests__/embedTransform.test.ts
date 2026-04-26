import { describe, expect, it } from 'vitest'
import { transformEmbedUrl } from '../embedTransform'

describe('transformEmbedUrl', () => {
  it('rewrites a bilibili.com video URL to the player.bilibili.com embed', () => {
    const result = transformEmbedUrl('https://www.bilibili.com/video/BV1zhPNz3EZJ')
    expect(result).toMatch(/^https:\/\/player\.bilibili\.com\/player\.html\?/)
    expect(result).toContain('bvid=BV1zhPNz3EZJ')
    expect(result).toContain('high_quality=1')
    expect(result).toContain('autoplay=0')
  })

  it('strips trailing slash and preserves the BV id', () => {
    const result = transformEmbedUrl('https://www.bilibili.com/video/BV1zhPNz3EZJ/')
    expect(result).toContain('bvid=BV1zhPNz3EZJ')
  })

  it('carries through ?p= for multi-part videos', () => {
    const result = transformEmbedUrl('https://www.bilibili.com/video/BV1zhPNz3EZJ?p=3')
    expect(result).toContain('bvid=BV1zhPNz3EZJ')
    expect(result).toContain('page=3')
  })

  it('handles the bare bilibili.com host without subdomain', () => {
    const result = transformEmbedUrl('https://bilibili.com/video/BV1zhPNz3EZJ')
    expect(result).toContain('bvid=BV1zhPNz3EZJ')
  })

  it('leaves bilibili.com homepage unchanged (not a video page)', () => {
    const url = 'https://www.bilibili.com/'
    expect(transformEmbedUrl(url)).toBe(url)
  })

  it('leaves non-bilibili URLs unchanged', () => {
    expect(transformEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
    expect(transformEmbedUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('returns malformed input unchanged instead of throwing', () => {
    expect(transformEmbedUrl('not-a-url')).toBe('not-a-url')
    expect(transformEmbedUrl('')).toBe('')
  })

  it('rejects non-BV path segments', () => {
    const url = 'https://www.bilibili.com/video/notabv/'
    expect(transformEmbedUrl(url)).toBe(url)
  })
})
