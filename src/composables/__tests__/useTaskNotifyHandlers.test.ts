/**
 * @fileoverview TDD tests for task lifecycle notification handlers.
 *
 * These tests validate the notification callbacks that TaskView registers on
 * TaskStore. The callback logic is extracted into pure functions in
 * useTaskNotifyHandlers.ts for independent unit testing — following the same
 * pattern as useTaskLifecycle.ts and useDownloadCleanup.ts.
 *
 * Tests written BEFORE implementation per TDD Iron Law.
 *
 * Key behaviors under test:
 *   1. onComplete handler sends in-app toast + OS notification.
 *   2. onBtComplete handler sends in-app toast + OS notification.
 *   3. onError handler sends in-app toast + OS notification with error text.
 *   4. All handlers respect the taskNotification preference gate.
 *   5. Metadata tasks are excluded from completion notifications.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Aria2Task } from '@shared/types'

// ── Mock OS notification helper ──────────────────────────────────────
const mockNotifyOs = vi.fn((_title: string, _body: string): Promise<void> => Promise.resolve())
vi.mock('../useOsNotification', () => ({
  notifyOs: (...args: [string, string]) => mockNotifyOs(...args),
}))

import { handleTaskComplete, handleBtComplete, handleTaskError } from '../useTaskNotifyHandlers'

// ── Test data factory ────────────────────────────────────────────────

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: 'complete',
    totalLength: '1048576',
    completedLength: '1048576',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    numSeeders: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/test-file.zip',
        length: '1048576',
        completedLength: '1048576',
        selected: 'true',
        uris: [{ uri: 'https://example.com/test-file.zip', status: 'used' }],
      },
    ],
    bittorrent: undefined,
    infoHash: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    numPieces: undefined,
    pieceLength: undefined,
    followedBy: undefined,
    following: undefined,
    belongsTo: undefined,
    ...overrides,
  } as Aria2Task
}

import type { NotifyDeps } from '../useTaskNotifyHandlers'

function makeDeps(overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    messageSuccess: vi.fn() as unknown as NotifyDeps['messageSuccess'],
    messageError: vi.fn() as unknown as NotifyDeps['messageError'],
    t: vi.fn((key: string, params?: Record<string, unknown>) => {
      if (key === 'task.download-complete-message' && params?.taskName) {
        return `${params.taskName} completed`
      }
      if (key === 'task.bt-download-complete-message' && params?.taskName) {
        return `${params.taskName} — download complete, seeding...`
      }
      if (key === 'task.error-unknown') return 'Unknown error'
      return key
    }) as unknown as NotifyDeps['t'],
    taskNotification: true,
    ...overrides,
  }
}

// ── handleTaskComplete ───────────────────────────────────────────────

describe('handleTaskComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends success toast with task display name', () => {
    const deps = makeDeps()
    const task = makeTask()

    handleTaskComplete(task, deps)

    expect(deps.messageSuccess).toHaveBeenCalledOnce()
    expect(deps.messageSuccess).toHaveBeenCalledWith('test-file.zip completed')
  })

  it('sends OS notification with task display name', () => {
    const deps = makeDeps()
    const task = makeTask()

    handleTaskComplete(task, deps)

    expect(mockNotifyOs).toHaveBeenCalledOnce()
    expect(mockNotifyOs).toHaveBeenCalledWith('MotrixNext', 'test-file.zip completed')
  })

  it('skips all notifications when taskNotification is false', () => {
    const deps = makeDeps({ taskNotification: false })
    const task = makeTask()

    handleTaskComplete(task, deps)

    expect(deps.messageSuccess).not.toHaveBeenCalled()
    expect(mockNotifyOs).not.toHaveBeenCalled()
  })

  it('skips metadata-only tasks (followedBy present)', () => {
    const deps = makeDeps()
    const task = makeTask({ followedBy: ['follow-gid'] })

    handleTaskComplete(task, deps)

    expect(deps.messageSuccess).not.toHaveBeenCalled()
    expect(mockNotifyOs).not.toHaveBeenCalled()
  })

  it('uses bittorrent info name as display name when available', () => {
    const deps = makeDeps()
    const task = makeTask({ bittorrent: { info: { name: 'Ubuntu 24.04' } } })

    handleTaskComplete(task, deps)

    expect(deps.messageSuccess).toHaveBeenCalledWith('Ubuntu 24.04 completed')
    expect(mockNotifyOs).toHaveBeenCalledWith('MotrixNext', 'Ubuntu 24.04 completed')
  })
})

// ── handleBtComplete ─────────────────────────────────────────────────

describe('handleBtComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends success toast with task display name', () => {
    const deps = makeDeps()
    const task = makeTask({ bittorrent: { info: { name: 'Big Archive' } } })

    handleBtComplete(task, deps)

    expect(deps.messageSuccess).toHaveBeenCalledOnce()
    expect(deps.messageSuccess).toHaveBeenCalledWith('Big Archive — download complete, seeding...')
  })

  it('sends OS notification with task display name', () => {
    const deps = makeDeps()
    const task = makeTask({ bittorrent: { info: { name: 'Big Archive' } } })

    handleBtComplete(task, deps)

    expect(mockNotifyOs).toHaveBeenCalledOnce()
    expect(mockNotifyOs).toHaveBeenCalledWith('MotrixNext', 'Big Archive — download complete, seeding...')
  })

  it('skips all notifications when taskNotification is false', () => {
    const deps = makeDeps({ taskNotification: false })
    const task = makeTask()

    handleBtComplete(task, deps)

    expect(deps.messageSuccess).not.toHaveBeenCalled()
    expect(mockNotifyOs).not.toHaveBeenCalled()
  })
})

// ── handleTaskError ──────────────────────────────────────────────────

describe('handleTaskError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends OS notification with error text', () => {
    const deps = makeDeps()
    const task = makeTask({
      status: 'error',
      errorCode: '6',
      errorMessage: 'Network problem',
    })

    handleTaskError(task, 'test-file.zip: Network problem', deps)

    expect(mockNotifyOs).toHaveBeenCalledOnce()
    expect(mockNotifyOs).toHaveBeenCalledWith('MotrixNext', 'test-file.zip: Network problem')
  })

  it('skips OS notification when taskNotification is false', () => {
    const deps = makeDeps({ taskNotification: false })
    const task = makeTask({ status: 'error', errorCode: '3' })

    handleTaskError(task, 'file: error', deps)

    expect(mockNotifyOs).not.toHaveBeenCalled()
  })
})
