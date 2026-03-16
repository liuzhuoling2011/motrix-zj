/**
 * @fileoverview Extracted task CRUD operations from the Pinia task store.
 *
 * Contains: removeTask, pauseTask, resumeTask, pauseAllTask, resumeAllTask,
 * toggleTask, stopSeeding, stopAllSeeding, removeTaskRecord, purgeTaskRecord,
 * batchRemoveTask.
 *
 * Uses dependency injection — accepts API + store refs instead of importing
 * them directly, enabling testability and keeping the task store thin.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, checkTaskIsSeeder } from '@shared/utils'
import { logger } from '@shared/logger'
import { buildHistoryRecord } from '@/composables/useTaskLifecycle'
import { useHistoryStore } from '@/stores/history'
import type { Aria2Task, TaskApi } from '@shared/types'
import type { Ref } from 'vue'

interface TaskOperationsDeps {
  api: TaskApi
  taskList: Ref<Aria2Task[]>
  currentTaskGid: Ref<string>
  hideTaskDetail: () => void
  fetchList: () => Promise<void>
}

export function createTaskOperations(deps: TaskOperationsDeps) {
  const { api, taskList, currentTaskGid, hideTaskDetail, fetchList } = deps

  async function removeTask(task: Aria2Task) {
    if (task.gid === currentTaskGid.value) hideTaskDetail()
    try {
      await api.removeTask({ gid: task.gid })
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  async function pauseTask(task: Aria2Task) {
    const isBT = checkTaskIsBT(task)
    const promise = isBT ? api.forcePauseTask({ gid: task.gid }) : api.pauseTask({ gid: task.gid })
    try {
      await promise
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  async function resumeTask(task: Aria2Task) {
    try {
      await api.resumeTask({ gid: task.gid })
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  async function pauseAllTask() {
    try {
      await api.forcePauseAllTask()
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  async function resumeAllTask() {
    try {
      await api.resumeAllTask()
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  function toggleTask(task: Aria2Task) {
    const { status } = task
    if (status === TASK_STATUS.ACTIVE) return pauseTask(task)
    if (status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) return resumeTask(task)
  }

  async function stopSeeding(task: Aria2Task) {
    const { gid } = task
    await api.forcePauseTask({ gid })
    await api.removeTask({ gid })
    const record = buildHistoryRecord(task)
    record.status = 'complete'
    const historyStore = useHistoryStore()
    await historyStore.addRecord(record)
  }

  async function stopAllSeeding(): Promise<number> {
    const seeders = taskList.value.filter(checkTaskIsSeeder)
    if (seeders.length === 0) return 0
    await Promise.allSettled(seeders.map((t) => stopSeeding(t)))
    return seeders.length
  }

  async function removeTaskRecord(task: Aria2Task) {
    const { gid, status } = task
    if (gid === currentTaskGid.value) hideTaskDetail()
    const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
    if ([ERROR, COMPLETE, REMOVED].indexOf(status) === -1) return
    const historyStore = useHistoryStore()
    await historyStore.removeRecord(gid)
    try {
      await api.removeTaskRecord({ gid })
    } catch (e) {
      logger.debug('TaskStore.removeTaskRecord.aria2', e)
    }
    await fetchList()
  }

  async function purgeTaskRecord() {
    const historyStore = useHistoryStore()
    await historyStore.clearRecords()
    try {
      await api.purgeTaskRecord()
    } catch (e) {
      logger.debug('TaskStore.purgeTaskRecord.aria2', e)
    }
    await fetchList()
  }

  async function batchRemoveTask(gids: string[]) {
    try {
      await api.batchRemoveTask({ gids })
    } finally {
      await fetchList()
      api.saveSession()
    }
  }

  async function hasActiveTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.ACTIVE || t.status === TASK_STATUS.WAITING)
    } catch {
      return false
    }
  }

  async function hasPausedTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.PAUSED)
    } catch {
      return false
    }
  }

  function saveSession() {
    api.saveSession()
  }

  return {
    removeTask,
    pauseTask,
    resumeTask,
    pauseAllTask,
    resumeAllTask,
    toggleTask,
    stopSeeding,
    stopAllSeeding,
    removeTaskRecord,
    purgeTaskRecord,
    batchRemoveTask,
    hasActiveTasks,
    hasPausedTasks,
    saveSession,
  }
}
