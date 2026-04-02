/**
 * @fileoverview Tests for JSONRPCClient HTTP transport error handling.
 *
 * The existing JSONRPCClient tests only exercise the WebSocket path.
 * These tests cover the httpSend fallback (used when no WebSocket is
 * connected) and verify that:
 *
 *  1. Non-2xx HTTP responses reject the pending deferred immediately
 *     (not after 15 s timeout) for both call() and batch().
 *  2. Invalid JSON response bodies reject the deferred immediately.
 *  3. An 'error' event is emitted on both paths for diagnostic
 *     consistency with the WebSocket error flow.
 *  4. call() and batch() produce a single rejection path — no dangling
 *     unhandled rejections from dual throw+reject.
 *
 * Mock strategy:
 *  - Stub global `fetch` (transport boundary) — everything inside
 *    (message routing, deferred management) runs REAL code.
 *  - WebSocket is NOT opened so _send falls through to httpSend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { JSONRPCClient } from '../lib/JSONRPCClient'

// ── helpers ────────────────────────────────────────────────────────

/** Build a minimal Response stub accepted by httpSend. */
function fakeResponse(body: string, init: { status: number; statusText: string; ok: boolean }): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText,
    json: () => Promise.resolve(JSON.parse(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

/** Build a Response whose .json() rejects (simulates non-JSON body). */
function fakeNonJsonResponse(status: number, statusText: string, ok: boolean): Response {
  return {
    ok,
    status,
    statusText,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    headers: new Headers({ 'content-type': 'text/html' }),
  } as unknown as Response
}

// ═══════════════════════════════════════════════════════════════════
// httpSend — call() and batch() paths
// ═══════════════════════════════════════════════════════════════════

describe('JSONRPCClient httpSend (HTTP transport)', () => {
  let client: JSONRPCClient
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    client = new JSONRPCClient({ host: '127.0.0.1', port: 6800 })
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ─── Non-2xx HTTP responses ──────────────────────────────────────

  describe('non-2xx HTTP response', () => {
    it('rejects call() on HTTP 400', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('{"error": "bad"}', {
          status: 400,
          statusText: 'Bad Request',
          ok: false,
        }),
      )

      await expect(client.call('aria2.addUri', [['http://x.com/f']])).rejects.toThrow('aria2 HTTP error 400')
    })

    it('rejects call() on HTTP 500', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
          ok: false,
        }),
      )

      await expect(client.call('aria2.getVersion')).rejects.toThrow('aria2 HTTP error 500')
    })

    it('rejects call() on HTTP 404', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('Not Found', {
          status: 404,
          statusText: 'Not Found',
          ok: false,
        }),
      )

      await expect(client.call('aria2.noSuchMethod')).rejects.toThrow('aria2 HTTP error 404')
    })

    it('includes status code and statusText in the error message', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('', {
          status: 502,
          statusText: 'Bad Gateway',
          ok: false,
        }),
      )

      await expect(client.call('aria2.getVersion')).rejects.toThrow('aria2 HTTP error 502: Bad Gateway')
    })

    it('emits an error event for diagnostic consistency', async () => {
      const errorHandler = vi.fn()
      client.on('error', errorHandler)

      fetchSpy.mockResolvedValueOnce(
        fakeResponse('', {
          status: 503,
          statusText: 'Service Unavailable',
          ok: false,
        }),
      )

      await expect(client.call('aria2.getVersion')).rejects.toThrow()
      expect(errorHandler).toHaveBeenCalledOnce()
      expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(Error)
      expect((errorHandler.mock.calls[0][0] as Error).message).toContain('503')
    })
  })

  // ─── Invalid JSON body ───────────────────────────────────────────

  describe('invalid JSON response body', () => {
    it('rejects call() when body is not valid JSON', async () => {
      fetchSpy.mockResolvedValueOnce(fakeNonJsonResponse(200, 'OK', true))

      await expect(client.call('aria2.getVersion')).rejects.toThrow()
    })

    it('emits an error event when JSON parsing fails', async () => {
      const errorHandler = vi.fn()
      client.on('error', errorHandler)

      fetchSpy.mockResolvedValueOnce(fakeNonJsonResponse(200, 'OK', true))

      await expect(client.call('aria2.getVersion')).rejects.toThrow()
      expect(errorHandler).toHaveBeenCalledOnce()
    })
  })

  // ─── Successful request (control test) ───────────────────────────

  describe('successful HTTP request', () => {
    it('resolves call() on HTTP 200 with valid JSON-RPC response', async () => {
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        return fakeResponse(
          JSON.stringify({
            id: body.id,
            jsonrpc: '2.0',
            result: { version: '1.37.0' },
          }),
          { status: 200, statusText: 'OK', ok: true },
        )
      })

      const result = await client.call('aria2.getVersion')

      expect(result).toEqual({ version: '1.37.0' })
    })
  })

  // ─── batch() path ────────────────────────────────────────────────

  describe('batch() with non-2xx HTTP response', () => {
    it('returns promises that reject on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('Bad Gateway', {
          status: 502,
          statusText: 'Bad Gateway',
          ok: false,
        }),
      )

      const promises = await client.batch([['aria2.getVersion'], ['aria2.getGlobalStat']])

      await expect(promises[0]).rejects.toThrow('aria2 HTTP error 502')
      await expect(promises[1]).rejects.toThrow('aria2 HTTP error 502')
    })
  })

  // ─── No dangling unhandled rejections ────────────────────────────

  describe('rejection path safety', () => {
    it('call() produces exactly one rejection (no dangling deferred)', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('', {
          status: 500,
          statusText: 'Internal Server Error',
          ok: false,
        }),
      )

      // If call() both throws AND leaves a dangling rejected deferred,
      // Vitest will report an unhandled rejection error. This test
      // verifies a single clean rejection path.
      const result = client.call('aria2.getVersion')
      await expect(result).rejects.toThrow('aria2 HTTP error 500')
    })

    it('batch() returns rejected promises without throwing', async () => {
      fetchSpy.mockResolvedValueOnce(
        fakeResponse('', {
          status: 500,
          statusText: 'Internal Server Error',
          ok: false,
        }),
      )

      // batch() should return the promises array (not throw) so callers
      // can inspect individual results. Each promise rejects individually.
      const promises = await client.batch([['aria2.method1'], ['aria2.method2']])
      expect(promises).toHaveLength(2)
      await expect(promises[0]).rejects.toThrow('aria2 HTTP error 500')
      await expect(promises[1]).rejects.toThrow('aria2 HTTP error 500')
    })
  })
})
