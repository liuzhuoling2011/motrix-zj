/**
 * @fileoverview TDD structural tests for Phase 5: task.ts reduction.
 *
 * Tests verify:
 * 1. TaskApi interface lives in shared/types.ts (not inline in task.ts)
 * 2. taskOperations.ts contains extracted CRUD functions
 * 3. task.ts stays ≤ 300 lines
 * 4. taskOperations.ts exports correct function signatures
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..')

describe('Phase 5: task.ts ≤ 300 lines', () => {
  let taskSource: string

  beforeAll(() => {
    taskSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'stores', 'task.ts'), 'utf-8')
  })

  it('task.ts is ≤ 300 lines', () => {
    const lines = taskSource.split('\n').length
    expect(lines).toBeLessThanOrEqual(300)
  })

  it('task.ts does NOT define TaskApi interface inline', () => {
    // TaskApi should live in shared/types.ts, not in the store
    expect(taskSource).not.toMatch(/^interface TaskApi \{/m)
  })

  it('task.ts imports TaskApi from shared/types', () => {
    expect(taskSource).toContain("from '@shared/types'")
    expect(taskSource).toMatch(/TaskApi/)
  })
})

describe('shared/types.ts — TaskApi interface', () => {
  let typesSource: string

  beforeAll(() => {
    typesSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'shared', 'types.ts'), 'utf-8')
  })

  it('exports TaskApi interface', () => {
    expect(typesSource).toMatch(/export interface TaskApi/)
  })

  it('TaskApi has fetchTaskList method', () => {
    expect(typesSource).toContain('fetchTaskList')
  })

  it('TaskApi has addUri method', () => {
    expect(typesSource).toContain('addUri')
  })

  it('TaskApi has saveSession method', () => {
    expect(typesSource).toContain('saveSession')
  })
})

describe('stores/taskOperations.ts — extracted CRUD', () => {
  let opsSource: string

  beforeAll(() => {
    opsSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'stores', 'taskOperations.ts'), 'utf-8')
  })

  it('file exists and is non-empty', () => {
    expect(opsSource.length).toBeGreaterThan(0)
  })

  it('exports createTaskOperations factory', () => {
    expect(opsSource).toMatch(/export function createTaskOperations/)
  })

  it('contains removeTask operation', () => {
    expect(opsSource).toContain('removeTask')
  })

  it('contains pauseTask operation', () => {
    expect(opsSource).toContain('pauseTask')
  })

  it('contains resumeTask operation', () => {
    expect(opsSource).toContain('resumeTask')
  })

  it('contains pauseAllTask operation', () => {
    expect(opsSource).toContain('pauseAllTask')
  })

  it('contains resumeAllTask operation', () => {
    expect(opsSource).toContain('resumeAllTask')
  })

  it('contains toggleTask operation', () => {
    expect(opsSource).toContain('toggleTask')
  })

  it('contains stopSeeding operation', () => {
    expect(opsSource).toContain('stopSeeding')
  })

  it('contains removeTaskRecord operation', () => {
    expect(opsSource).toContain('removeTaskRecord')
  })

  it('contains purgeTaskRecord operation', () => {
    expect(opsSource).toContain('purgeTaskRecord')
  })

  it('contains batchRemoveTask operation', () => {
    expect(opsSource).toContain('batchRemoveTask')
  })

  it('uses dependency injection (accepts api parameter)', () => {
    // Should accept TaskApi or similar deps object, not import from api/aria2
    expect(opsSource).not.toContain("from '@/api/aria2'")
  })

  it('is ≤ 200 lines', () => {
    const lines = opsSource.split('\n').length
    expect(lines).toBeLessThanOrEqual(200)
  })
})
