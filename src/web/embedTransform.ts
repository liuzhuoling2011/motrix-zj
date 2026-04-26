/**
 * Maps a public site URL to an iframe-friendly equivalent when the original
 * page sets `X-Frame-Options: DENY` or a strict CSP that blocks embedding.
 *
 * The address bar continues to display the original URL (used for the
 * download button); only the iframe `src` swaps to the embed endpoint.
 *
 * Currently handles:
 *   - bilibili.com video pages → `player.bilibili.com/player.html?bvid=...`
 *
 * Returns the original URL unchanged when no transformation applies (or when
 * the input is not a parseable URL).
 */
export function transformEmbedUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const bilibili = transformBilibili(parsed)
  if (bilibili) return bilibili

  return rawUrl
}

function transformBilibili(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase()
  // Only main / mobile bilibili pages need the embed swap; the player
  // endpoint itself already supports iframe (no-op for it).
  if (host !== 'www.bilibili.com' && host !== 'bilibili.com' && host !== 'm.bilibili.com') {
    return null
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'video' || !segments[1]) return null

  // BV id is path segment 1, possibly with trailing query/fragment already
  // stripped by `new URL`. Strip a possible page suffix like `BVxxx?p=2`.
  const bvid = segments[1].split('?')[0].split('#')[0]
  if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return null

  const embed = new URL('https://player.bilibili.com/player.html')
  embed.searchParams.set('bvid', bvid)
  embed.searchParams.set('high_quality', '1')
  // The user reached this URL via an explicit click/paste in the address
  // bar (a user gesture), so the WebView2 autoplay policy will let the
  // player start without an extra click. Showing a black "click to play"
  // surface for an empty reason is what users complain about.
  embed.searchParams.set('autoplay', '1')

  // Carry through `?p=` (multi-part videos) so the right episode plays.
  const page = parsed.searchParams.get('p')
  if (page && /^\d+$/.test(page)) {
    embed.searchParams.set('page', page)
  }

  return embed.toString()
}
