/**
 * @fileoverview Composable for managing per-task proxy toggle in the Task Detail drawer.
 *
 * Reads the current task's `all-proxy` option via `getTaskOption`, exposes a
 * reactive checkbox model, and applies changes via `changeTaskOption`.
 *
 * Pure dependency-injection design — no direct store/API imports — fully testable.
 */
import { ref, computed, watch, type Ref } from 'vue'
import { isEngineReady } from '@/api/aria2'
import { isGlobalProxyConfigured } from '@/composables/useAddTaskSubmit'
import { TASK_STATUS } from '@shared/constants'
import type { Aria2Task, Aria2EngineOptions, ProxyConfig } from '@shared/types'
import { logger } from '@shared/logger'

/** Statuses where aria2 allows option modification. */
const MODIFIABLE_STATUSES = new Set([TASK_STATUS.ACTIVE, TASK_STATUS.WAITING, TASK_STATUS.PAUSED])

export interface UseTaskDetailProxyOptions {
  task: Ref<Aria2Task | null>
  getTaskOption: (gid: string) => Promise<Record<string, string>>
  changeTaskOption: (payload: { gid: string; options: Aria2EngineOptions }) => Promise<void>
  proxyConfig: () => ProxyConfig
  message: {
    success: (content: string) => void
    error: (content: string) => void
  }
  t: (key: string) => string
}

export function useTaskDetailProxy(options: UseTaskDetailProxyOptions) {
  const { task, getTaskOption, changeTaskOption, proxyConfig, message, t } = options

  // ── Reactive state ──────────────────────────────────────────────

  const useProxy = ref(false)
  const applying = ref(false)
  /** The proxy value that was last loaded from the engine (baseline for dirty). */
  const loadedProxy = ref(false)

  // ── Computed ────────────────────────────────────────────────────

  const canModify = computed(() => {
    if (!task.value) return false
    if (!isEngineReady()) return false
    return MODIFIABLE_STATUSES.has(task.value.status)
  })

  const globalProxyAvailable = computed(() => isGlobalProxyConfigured(proxyConfig()))

  const proxyAddress = computed(() => proxyConfig()?.server ?? '')

  const dirty = computed(() => useProxy.value !== loadedProxy.value)

  // ── Load current task proxy state ───────────────────────────────

  async function loadCurrentProxy(gid: string) {
    try {
      const opts = await getTaskOption(gid)
      const current = opts.allProxy ?? ''
      const hasProxy = current.length > 0
      useProxy.value = hasProxy
      loadedProxy.value = hasProxy
    } catch (err) {
      logger.debug('[useTaskDetailProxy] getTaskOption failed', err)
      useProxy.value = false
      loadedProxy.value = false
    }
  }

  // Watch task gid — reload proxy state when task changes
  watch(
    () => task.value?.gid,
    (gid) => {
      if (gid && canModify.value) {
        void loadCurrentProxy(gid)
      } else {
        useProxy.value = false
        loadedProxy.value = false
      }
    },
    { immediate: true },
  )

  // ── Apply proxy change ──────────────────────────────────────────

  async function applyProxy(): Promise<void> {
    if (applying.value) return
    if (!task.value) return
    if (!dirty.value) return

    applying.value = true
    try {
      const proxyValue = useProxy.value ? proxyAddress.value : ''
      await changeTaskOption({
        gid: task.value.gid,
        options: { 'all-proxy': proxyValue } as Aria2EngineOptions,
      })

      loadedProxy.value = useProxy.value

      // Active tasks restart internally when proxy changes
      const toastKey =
        task.value.status === TASK_STATUS.ACTIVE ? t('task.proxy-applied-restart') : t('task.proxy-applied')
      message.success(toastKey)
    } catch (err) {
      logger.debug('[useTaskDetailProxy] changeTaskOption failed', err)
      message.error(t('task.proxy-apply-failed'))
    } finally {
      applying.value = false
    }
  }

  return {
    useProxy,
    canModify,
    globalProxyAvailable,
    proxyAddress,
    dirty,
    applying,
    applyProxy,
  }
}
