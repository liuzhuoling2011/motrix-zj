/**
 * @fileoverview Tray menu action handler extracted from useAppEvents.
 *
 * The tray menu is the system-tray right-click menu. Its 'resume-all' and
 * 'pause-all' actions involve confirmation dialogs with loading state,
 * making them the largest single handler block in the IPC layer.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { isEngineReady } from '@/api/aria2'
import type { Ref } from 'vue'

interface TrayHandlerDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  appStore: { showAddTaskDialog: () => void }
  taskStore: {
    hasPausedTasks: () => Promise<boolean>
    hasActiveTasks: () => Promise<boolean>
    resumeAllTask: () => Promise<unknown>
    pauseAllTask: () => Promise<unknown>
    fetchList: () => Promise<unknown>
  }
  message: {
    success: (msg: string) => void
    error: (msg: string, opts?: Record<string, unknown>) => void
    warning: (msg: string) => void
    info: (msg: string, opts?: Record<string, unknown>) => void
  }
  navDialog: ReturnType<typeof import('naive-ui').useDialog>
  isExiting: Ref<boolean>
  handleExitConfirm: () => Promise<void>
}

export async function setupTrayListener(deps: TrayHandlerDeps) {
  const { t, appStore, taskStore, message, navDialog, handleExitConfirm } = deps

  return listen<string>('tray-menu-action', async (event) => {
    const action = event.payload
    const mainWindow = getCurrentWindow()
    switch (action) {
      case 'show':
        await mainWindow.show()
        await mainWindow.setFocus()
        break
      case 'new-task':
        await mainWindow.show()
        await mainWindow.setFocus()
        appStore.showAddTaskDialog()
        break
      case 'resume-all':
        await mainWindow.show()
        await mainWindow.setFocus()
        if (!(await taskStore.hasPausedTasks())) {
          message.info(t('task.no-paused-tasks'))
          break
        }
        if (!isEngineReady()) {
          message.warning(t('app.engine-not-ready'))
        } else {
          navDialog.warning({
            title: t('task.resume-all-task'),
            content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
            positiveText: t('app.yes'),
            negativeText: t('app.no'),
            onPositiveClick: () => {
              taskStore
                .resumeAllTask()
                .then(() => message.success(t('task.resume-all-task-success')))
                .catch(() => message.error(t('task.resume-all-task-fail')))
            },
          })
        }
        break
      case 'pause-all':
        await mainWindow.show()
        await mainWindow.setFocus()
        if (!(await taskStore.hasActiveTasks())) {
          message.info(t('task.no-active-tasks'))
          break
        }
        if (!isEngineReady()) {
          message.warning(t('app.engine-not-ready'))
        } else {
          const d = navDialog.warning({
            title: t('task.pause-all-task'),
            content: t('task.pause-all-task-confirm') || 'Pause all tasks?',
            positiveText: t('app.yes'),
            negativeText: t('app.no'),
            onPositiveClick: () => {
              d.loading = true
              d.negativeButtonProps = { disabled: true }
              d.closable = false
              d.maskClosable = false
              taskStore
                .pauseAllTask()
                .then(async () => {
                  await new Promise((r) => setTimeout(r, 500))
                  await taskStore.fetchList()
                  message.success(t('task.pause-all-task-success'))
                  d.destroy()
                })
                .catch(() => {
                  message.error(t('task.pause-all-task-fail'))
                  d.destroy()
                })
              return false
            },
          })
        }
        break
      case 'quit':
        await handleExitConfirm()
        break
    }
  })
}
