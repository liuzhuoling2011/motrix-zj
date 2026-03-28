/**
 * @fileoverview TDD tests for useTaskDetailProxy composable.
 *
 * Tests cover:
 * - Reading current task proxy state via getTaskOption
 * - Applying proxy changes via changeTaskOption
 * - Edge cases: stopped tasks, engine down, RPC failure, global proxy unconfigured
 * - Toast notifications on success and failure
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import { useTaskDetailProxy } from '@/composables/useTaskDetailProxy'
import type { Aria2Task, ProxyConfig } from '@shared/types'
import { TASK_STATUS } from '@shared/constants'

// ── Mock modules ────────────────────────────────────────────────────

vi.mock('@/api/aria2', () => ({
  isEngineReady: vi.fn(() => true),
}))

const { isEngineReady } = await import('@/api/aria2')

// ── Factory helpers ─────────────────────────────────────────────────

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: TASK_STATUS.ACTIVE as Aria2Task['status'],
    totalLength: '1000000',
    completedLength: '500000',
    uploadLength: '0',
    downloadSpeed: '10000',
    uploadSpeed: '0',
    connections: '5',
    dir: '/downloads',
    files: [],
    ...overrides,
  }
}

function makeProxy(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    enable: true,
    server: 'http://127.0.0.1:7890',
    scope: ['download', 'update-app'],
    ...overrides,
  }
}

interface MockDeps {
  task: Ref<Aria2Task | null>
  getTaskOption: Mock
  changeTaskOption: Mock
  proxyConfig: ProxyConfig
  successFn: Mock
  errorFn: Mock
  t: (key: string) => string
}

function createMocks(overrides: Partial<MockDeps> = {}): MockDeps {
  return {
    task: ref<Aria2Task | null>(makeTask()),
    getTaskOption: vi.fn().mockResolvedValue({ allProxy: '' }),
    changeTaskOption: vi.fn().mockResolvedValue(undefined),
    proxyConfig: makeProxy(),
    successFn: vi.fn(),
    errorFn: vi.fn(),
    t: (key: string) => key,
    ...overrides,
  }
}

function setup(mocks: MockDeps) {
  return useTaskDetailProxy({
    task: mocks.task,
    getTaskOption: mocks.getTaskOption,
    changeTaskOption: mocks.changeTaskOption,
    proxyConfig: () => mocks.proxyConfig,
    message: { success: mocks.successFn, error: mocks.errorFn },
    t: mocks.t,
  })
}

// ── Tests ───────────────────────────────────────────────────────────

describe('useTaskDetailProxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isEngineReady as Mock).mockReturnValue(true)
  })

  // ── Initial state ───────────────────────────────────────────────

  describe('initial state', () => {
    it('returns useProxy as false by default', () => {
      const mocks = createMocks()
      const { useProxy } = setup(mocks)
      expect(useProxy.value).toBe(false)
    })

    it('returns canModify as true for active tasks', () => {
      const mocks = createMocks()
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(true)
    })

    it('returns canModify as true for waiting tasks', () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.WAITING as Aria2Task['status'] })),
      })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(true)
    })

    it('returns canModify as true for paused tasks', () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.PAUSED as Aria2Task['status'] })),
      })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(true)
    })

    it('returns canModify as false for completed tasks', () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.COMPLETE as Aria2Task['status'] })),
      })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(false)
    })

    it('returns canModify as false for error tasks', () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.ERROR as Aria2Task['status'] })),
      })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(false)
    })

    it('returns canModify as false for removed tasks', () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.REMOVED as Aria2Task['status'] })),
      })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(false)
    })

    it('returns canModify as false when engine is not ready', () => {
      ;(isEngineReady as Mock).mockReturnValue(false)
      const mocks = createMocks()
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(false)
    })

    it('returns canModify as false when task is null', () => {
      const mocks = createMocks({ task: ref(null) })
      const { canModify } = setup(mocks)
      expect(canModify.value).toBe(false)
    })

    it('returns globalProxyAvailable as true when proxy is configured', () => {
      const mocks = createMocks()
      const { globalProxyAvailable } = setup(mocks)
      expect(globalProxyAvailable.value).toBe(true)
    })

    it('returns globalProxyAvailable as false when proxy is disabled', () => {
      const mocks = createMocks({ proxyConfig: makeProxy({ enable: false }) })
      const { globalProxyAvailable } = setup(mocks)
      expect(globalProxyAvailable.value).toBe(false)
    })

    it('returns globalProxyAvailable as false when server is empty', () => {
      const mocks = createMocks({ proxyConfig: makeProxy({ server: '' }) })
      const { globalProxyAvailable } = setup(mocks)
      expect(globalProxyAvailable.value).toBe(false)
    })

    it('returns proxyAddress from global config', () => {
      const mocks = createMocks()
      const { proxyAddress } = setup(mocks)
      expect(proxyAddress.value).toBe('http://127.0.0.1:7890')
    })
  })

  // ── Loading current proxy state ─────────────────────────────────

  describe('loadCurrentProxy', () => {
    it('calls getTaskOption when task changes', async () => {
      const mocks = createMocks()
      setup(mocks)
      await nextTick()
      expect(mocks.getTaskOption).toHaveBeenCalledWith('abc123')
    })

    it('sets useProxy to true when task has all-proxy set', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockResolvedValue({ allProxy: 'http://127.0.0.1:7890' }),
      })
      const { useProxy } = setup(mocks)
      await nextTick()
      expect(useProxy.value).toBe(true)
    })

    it('sets useProxy to false when task has no all-proxy', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockResolvedValue({ allProxy: '' }),
      })
      const { useProxy } = setup(mocks)
      await nextTick()
      expect(useProxy.value).toBe(false)
    })

    it('sets useProxy to false when allProxy key is missing', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockResolvedValue({}),
      })
      const { useProxy } = setup(mocks)
      await nextTick()
      expect(useProxy.value).toBe(false)
    })

    it('does not call getTaskOption for null task', async () => {
      const mocks = createMocks({ task: ref(null) })
      setup(mocks)
      await nextTick()
      expect(mocks.getTaskOption).not.toHaveBeenCalled()
    })

    it('does not call getTaskOption for completed tasks', async () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.COMPLETE as Aria2Task['status'] })),
      })
      setup(mocks)
      await nextTick()
      expect(mocks.getTaskOption).not.toHaveBeenCalled()
    })

    it('reloads proxy when task gid changes', async () => {
      const mocks = createMocks()
      const taskRef = mocks.task
      setup(mocks)
      await nextTick()
      expect(mocks.getTaskOption).toHaveBeenCalledTimes(1)

      taskRef.value = makeTask({ gid: 'xyz789' })
      await nextTick()
      expect(mocks.getTaskOption).toHaveBeenCalledTimes(2)
      expect(mocks.getTaskOption).toHaveBeenLastCalledWith('xyz789')
    })

    it('handles getTaskOption failure gracefully', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockRejectedValue(new Error('RPC error')),
      })
      const { useProxy } = setup(mocks)
      await nextTick()
      // Should remain false and not throw
      expect(useProxy.value).toBe(false)
    })
  })

  // ── Dirty state ─────────────────────────────────────────────────

  describe('dirty tracking', () => {
    it('dirty is false initially', async () => {
      const mocks = createMocks()
      const { dirty } = setup(mocks)
      await nextTick()
      expect(dirty.value).toBe(false)
    })

    it('dirty becomes true when useProxy is toggled', async () => {
      const mocks = createMocks()
      const { useProxy, dirty } = setup(mocks)
      await nextTick()
      useProxy.value = true
      expect(dirty.value).toBe(true)
    })

    it('dirty becomes false when toggled back to original', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockResolvedValue({ allProxy: '' }),
      })
      const { useProxy, dirty } = setup(mocks)
      await nextTick() // original = false
      useProxy.value = true
      expect(dirty.value).toBe(true)
      useProxy.value = false
      expect(dirty.value).toBe(false)
    })
  })

  // ── Apply proxy ─────────────────────────────────────────────────

  describe('applyProxy', () => {
    it('calls changeTaskOption with all-proxy when enabling', async () => {
      const mocks = createMocks()
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick()
      useProxy.value = true
      await applyProxy()

      expect(mocks.changeTaskOption).toHaveBeenCalledWith({
        gid: 'abc123',
        options: { 'all-proxy': 'http://127.0.0.1:7890' },
      })
    })

    it('calls changeTaskOption with empty all-proxy when disabling', async () => {
      const mocks = createMocks({
        getTaskOption: vi.fn().mockResolvedValue({ allProxy: 'http://127.0.0.1:7890' }),
      })
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick() // loads as true
      useProxy.value = false
      await applyProxy()

      expect(mocks.changeTaskOption).toHaveBeenCalledWith({
        gid: 'abc123',
        options: { 'all-proxy': '' },
      })
    })

    it('shows success toast for active task (with restart hint)', async () => {
      const mocks = createMocks()
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick()
      useProxy.value = true
      await applyProxy()

      expect(mocks.successFn).toHaveBeenCalledWith('task.proxy-applied-restart')
    })

    it('shows success toast for paused task (no restart hint)', async () => {
      const mocks = createMocks({
        task: ref(makeTask({ status: TASK_STATUS.PAUSED as Aria2Task['status'] })),
      })
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick()
      useProxy.value = true
      await applyProxy()

      expect(mocks.successFn).toHaveBeenCalledWith('task.proxy-applied')
    })

    it('shows error toast on RPC failure', async () => {
      const mocks = createMocks({
        changeTaskOption: vi.fn().mockRejectedValue(new Error('RPC failed')),
      })
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick()
      useProxy.value = true
      await applyProxy()

      expect(mocks.errorFn).toHaveBeenCalledWith('task.proxy-apply-failed')
    })

    it('resets dirty state after successful apply', async () => {
      const mocks = createMocks()
      const { useProxy, applyProxy, dirty } = setup(mocks)
      await nextTick()
      useProxy.value = true
      expect(dirty.value).toBe(true)
      await applyProxy()
      expect(dirty.value).toBe(false)
    })

    it('keeps dirty state after failed apply', async () => {
      const mocks = createMocks({
        changeTaskOption: vi.fn().mockRejectedValue(new Error('fail')),
      })
      const { useProxy, applyProxy, dirty } = setup(mocks)
      await nextTick()
      useProxy.value = true
      await applyProxy()
      expect(dirty.value).toBe(true)
    })

    it('sets applying to true during RPC call', async () => {
      let resolveRpc!: () => void
      const mocks = createMocks({
        changeTaskOption: vi.fn().mockReturnValue(new Promise<void>((r) => (resolveRpc = r))),
      })
      const { useProxy, applyProxy, applying } = setup(mocks)
      await nextTick()
      useProxy.value = true

      const promise = applyProxy()
      expect(applying.value).toBe(true)

      resolveRpc()
      await promise
      expect(applying.value).toBe(false)
    })

    it('prevents concurrent apply calls', async () => {
      let resolveRpc!: () => void
      const mocks = createMocks({
        changeTaskOption: vi.fn().mockReturnValue(new Promise<void>((r) => (resolveRpc = r))),
      })
      const { useProxy, applyProxy } = setup(mocks)
      await nextTick()
      useProxy.value = true

      const p1 = applyProxy()
      const p2 = applyProxy() // should be a no-op

      resolveRpc()
      await p1
      await p2

      expect(mocks.changeTaskOption).toHaveBeenCalledTimes(1)
    })

    it('does not call changeTaskOption when task is null', async () => {
      const mocks = createMocks({ task: ref(null) })
      const { applyProxy } = setup(mocks)
      await applyProxy()
      expect(mocks.changeTaskOption).not.toHaveBeenCalled()
    })

    it('does not call changeTaskOption when not dirty', async () => {
      const mocks = createMocks()
      const { applyProxy } = setup(mocks)
      await nextTick()
      // dirty is false because we haven't toggled
      await applyProxy()
      expect(mocks.changeTaskOption).not.toHaveBeenCalled()
    })
  })
})
