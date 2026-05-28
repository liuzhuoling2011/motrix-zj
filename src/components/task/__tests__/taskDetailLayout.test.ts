import { describe, expect, it } from 'vitest'

describe('task detail layout', () => {
  it('uses one Status tab label for protocol-specific detail tabs', async () => {
    const source = (await import('@/components/task/TaskDetail.vue?raw')).default

    expect(source).toContain("labelKey: 'task.task-tab-status'")
    expect(source.match(/labelKey: 'task\.task-tab-status'/g)).toHaveLength(1)
    expect(source).not.toContain("labelKey: 'task.task-tab-health'")
    expect(source).not.toContain("labelKey: 'task.task-tab-ed2k'")
  })

  it('keeps secondary inline values at the same font size as primary values', async () => {
    const source = (await import('@/components/task/TaskDetail.vue?raw')).default
    const mutedInlineBlock = source.match(/\.muted-inline\s*\{[^}]+\}/)?.[0] ?? ''

    expect(mutedInlineBlock).toContain('font-size: inherit')
    expect(mutedInlineBlock).not.toContain('font-size: 12px')
  })
})
