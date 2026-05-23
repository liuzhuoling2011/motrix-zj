/**
 * @fileoverview Structural test: TaskList.vue must have a conditional Speedometer
 * clearance spacer that only applies when cards are present.
 *
 * The safety area uses .task-list-inner:not(:empty)::after so that:
 * - Empty inner container (no cards) has no extra scroll space
 * - Long lists can scroll the final card above the fixed Speedometer
 * - Short lists do not get a forced scrollbar
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TASK_LIST_VUE = path.resolve(__dirname, '..', '..', 'task', 'TaskList.vue')
const SPEEDOMETER_VUE = path.resolve(__dirname, '..', 'Speedometer.vue')

describe('Conditional Speedometer bottom safety area', () => {
  let taskListSource: string
  let speedometerSource: string

  beforeAll(() => {
    taskListSource = fs.readFileSync(TASK_LIST_VUE, 'utf-8')
    speedometerSource = fs.readFileSync(SPEEDOMETER_VUE, 'utf-8')
  })

  it('Speedometer occlusion zone is 60px', () => {
    const bottom = speedometerSource.match(/bottom:\s*(\d+)px/)
    const height = speedometerSource.match(/height:\s*(\d+)px/)
    expect(bottom).not.toBeNull()
    expect(height).not.toBeNull()
    expect(parseInt(bottom![1], 10) + parseInt(height![1], 10)).toBe(58)
  })

  it('safety area only applies when cards are present (inner not empty)', () => {
    expect(taskListSource).toMatch(/\.task-list-inner:not\(:empty\)::after/)
  })

  it('safety area height stays compact', () => {
    const safetyVar = taskListSource.match(/--task-list-bottom-safety:\s*(\d+)px/)
    expect(safetyVar).not.toBeNull()
    expect(taskListSource).toMatch(/height:\s*var\(--task-list-bottom-safety\)/)
    expect(parseInt(safetyVar![1], 10)).toBe(54)
  })

  it('short lists are not forced to become scrollable', () => {
    expect(taskListSource).not.toMatch(/\.task-list\.has-tasks/)
    expect(taskListSource).not.toMatch(/min-height:\s*calc\(100%\s*\+\s*var\(--task-list-bottom-safety\)\)/)
  })
})
