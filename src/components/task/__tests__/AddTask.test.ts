import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import AddTask from '@/components/task/AddTask.vue'
import { useAppStore } from '@/stores/app'
import { createBatchItem, resetBatchIdCounter } from '@shared/utils/batchHelpers'

const {
  pushMock,
  successMock,
  warningMock,
  errorMock,
  readFileMock,
  openDialogMock,
  readTextMock,
  parseTorrentBufferMock,
  uint8ToBase64Mock,
  parseUrlMock,
  downloadDirectMock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(() => Promise.resolve()),
  successMock: vi.fn(),
  warningMock: vi.fn(),
  errorMock: vi.fn(),
  readFileMock: vi.fn(async () => new Uint8Array([1, 2, 3])),
  openDialogMock: vi.fn(),
  readTextMock: vi.fn(async () => ''),
  parseTorrentBufferMock: vi.fn(async () => ({
    infoHash: 'hash',
    files: [{ idx: 1, path: 'file.bin', length: 1 }],
  })),
  uint8ToBase64Mock: vi.fn(() => 'base64'),
  parseUrlMock: vi.fn(async () => ({ type: 'NotMedia' })),
  downloadDirectMock: vi.fn(async () => 'gid'),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({
    success: successMock,
    warning: warningMock,
    error: errorMock,
    info: vi.fn(),
  }),
}))

vi.mock('@/api/aria2', () => ({
  isEngineReady: () => true,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
}))

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: vi.fn(async () => '/Downloads'),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: readFileMock,
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: readTextMock,
}))

vi.mock('@/composables/useTorrentParser', () => ({
  parseTorrentBuffer: parseTorrentBufferMock,
  uint8ToBase64: uint8ToBase64Mock,
}))

vi.mock('@/api/ytdlp', () => ({
  parseUrl: parseUrlMock,
  downloadDirect: downloadDirectMock,
  downloadViaAria2: vi.fn(async () => 'gid'),
  cancelDownload: vi.fn(async () => undefined),
  onLog: vi.fn(async () => () => undefined),
  onProgress: vi.fn(async () => () => undefined),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default ? slots.default() : [])
    },
  })

  const NButton = defineComponent({
    inheritAttrs: false,
    emits: ['click'],
    setup(_, { slots, emit, attrs }) {
      return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default ? slots.default() : [])
    },
  })

  const NInput = defineComponent({
    props: {
      value: { type: String, default: '' },
      type: { type: String, default: 'text' },
      placeholder: { type: String, default: '' },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () =>
        props.type === 'textarea'
          ? h('textarea', {
              value: props.value,
              placeholder: props.placeholder,
              onInput: (e: Event) => emit('update:value', (e.target as HTMLTextAreaElement).value),
            })
          : h('input', {
              value: props.value,
              placeholder: props.placeholder,
              onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value),
            })
    },
  })

  const NInputNumber = defineComponent({
    props: {
      value: { type: Number, default: 0 },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () =>
        h('input', {
          type: 'number',
          value: props.value,
          onInput: (e: Event) => emit('update:value', Number((e.target as HTMLInputElement).value)),
        })
    },
  })

  const NDataTable = defineComponent({
    props: {
      data: { type: Array, default: () => [] },
    },
    setup(props) {
      return () => h('div', { 'data-rows': String((props.data as unknown[]).length) })
    },
  })

  return {
    NModal: passthrough,
    NCard: passthrough,
    NTabs: passthrough,
    NTabPane: passthrough,
    NForm: passthrough,
    NFormItem: passthrough,
    NInput,
    NInputNumber,
    NButton,
    NSpace: passthrough,
    NGrid: passthrough,
    NGridItem: passthrough,
    NIcon: passthrough,
    NInputGroup: passthrough,
    NDataTable,
    NTag: passthrough,
    NEllipsis: passthrough,
    NCheckbox: passthrough,
    NCollapseTransition: passthrough,
  }
})

const AdvancedOptionsStub = defineComponent({
  name: 'AdvancedOptions',
  setup() {
    return () => h('div')
  },
})

function mountDialog() {
  return mount(AddTask, {
    props: { show: false },
    global: {
      stubs: {
        AdvancedOptions: AdvancedOptionsStub,
      },
    },
  })
}

function getTextarea(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('textarea')
}

describe('AddTask batch URI integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
    pushMock.mockClear()
    successMock.mockClear()
    warningMock.mockClear()
    errorMock.mockClear()
    readFileMock.mockClear()
    openDialogMock.mockClear()
    readTextMock.mockClear()
    parseTorrentBufferMock.mockClear()
    uint8ToBase64Mock.mockClear()
    parseUrlMock.mockClear()
    downloadDirectMock.mockClear()
  })

  it('flushes uri batch items into the textarea and drains uri items from pendingBatch on open', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [
      createBatchItem('uri', 'https://a.example/file'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:abc'),
    ]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'magnet:?xt=urn:btih:abc'].join('\n'),
    )
    expect(appStore.pendingBatch).toEqual([])
  })

  it('appends newly added uri batch items while open and deduplicates multiline payloads per line', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('uri', 'https://a.example/file\nhttps://b.example/file')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'https://b.example/file'].join('\n'),
    )

    appStore.pendingBatch = [
      createBatchItem('uri', 'https://b.example/file\nhttps://c.example/file'),
      createBatchItem('uri', 'https://a.example/file'),
    ]

    await nextTick()
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'https://b.example/file', 'https://c.example/file'].join('\n'),
    )
    expect(appStore.pendingBatch).toEqual([])
  })

  it('resets batch list ui state on close so the next open does not leave an empty batch shell behind', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/one.torrent')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    // Torrent panel should be visible when there are file items
    const torrentPanel = wrapper.find('.torrent-panel')
    expect(torrentPanel.exists()).toBe(true)

    // Simulate close: clear batch and hide dialog
    appStore.pendingBatch = []
    appStore.hideAddTaskDialog()
    await wrapper.setProps({ show: false })
    await flushPromises()

    // Re-open with empty batch — textarea should be empty, no stale state
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe('')
  })
})

describe('AddTask split preference sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

  it('syncs form.split from preferenceStore.config.split when dialog opens', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    // Simulate user having saved maxConnectionPerServer=32 in Basic settings
    // which writes split=32 to the store via transformDownloadsForStore
    preferenceStore.$patch({ config: { split: 32, maxConnectionPerServer: 32 } })

    const wrapper = mountDialog()
    await flushPromises()

    // Initially mounted with stale default (64 from DEFAULT_APP_CONFIG)
    // Opening the dialog should sync to the store's latest value
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    // Find the split input (NInputNumber renders as <input type="number">)
    const numberInputs = wrapper.findAll('input[type="number"]')
    // The split input should reflect the store value, not the stale default
    const splitInput = numberInputs.find((i) => Number((i.element as HTMLInputElement).value) <= 64)
    expect(splitInput).toBeDefined()
    expect(Number((splitInput!.element as HTMLInputElement).value)).toBe(32)
  })

  it('preserves current form.split when config.split is absent (no maxConn fallback in v2)', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    // Simulate legacy store data where split was never saved — explicitly
    // null out split so the ?? fallback keeps current form.split.
    // After v2 decoupling, there is no fallback to maxConnectionPerServer.
    preferenceStore.$patch({
      config: { split: undefined as unknown as number, maxConnectionPerServer: 48 },
    })

    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    const numberInputs = wrapper.findAll('input[type="number"]')
    const splitInput = numberInputs.find((i) => {
      const val = Number((i.element as HTMLInputElement).value)
      return val > 0 && val <= 256
    })
    expect(splitInput).toBeDefined()
    // When config.split is undefined, form.split retains its initialization
    // value (from config.split in the reactive form, which is the initial 16).
    // It does NOT fall back to maxConnectionPerServer (v2 decoupling).
    expect(Number((splitInput!.element as HTMLInputElement).value)).not.toBe(48)
  })

  it('re-syncs split on subsequent opens after preference changes', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    preferenceStore.$patch({ config: { split: 64, maxConnectionPerServer: 64 } })

    const wrapper = mountDialog()
    await flushPromises()

    // First open — split should be 64
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    // Close
    await wrapper.setProps({ show: false })
    await flushPromises()

    // User changes preference while dialog is closed
    preferenceStore.$patch({ config: { split: 16, maxConnectionPerServer: 16 } })

    // Re-open — split should now be 16
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    const numberInputs = wrapper.findAll('input[type="number"]')
    const splitInput = numberInputs.find((i) => {
      const val = Number((i.element as HTMLInputElement).value)
      return val > 0 && val <= 128
    })
    expect(splitInput).toBeDefined()
    expect(Number((splitInput!.element as HTMLInputElement).value)).toBe(16)
  })
})

describe('AddTask redesigned layout and animation structure', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
    parseUrlMock.mockClear()
  })

  // ── Layout: dual-tab with NTabs ────────────────────────────────────

  it('uses NTabs dual-tab layout with URI and Torrent tabs', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).toContain('NTabs')
    expect(source).toContain('NTabPane')
    expect(source).toContain('ADD_TASK_TYPE.URI')
    expect(source).toContain('ADD_TASK_TYPE.TORRENT')
  })

  it('does not import TorrentUpload — functionality merged inline', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).not.toContain('TorrentUpload')
  })

  it('renders a textarea for URI input in the URI tab', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(getTextarea(wrapper).exists()).toBe(true)
  })

  it('shows URL and download directory fields for internal browser video downloads', async () => {
    const appStore = useAppStore()
    appStore.addTaskFromWebPanel = true
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('.web-panel-url-section textarea').exists()).toBe(true)
    expect(wrapper.find('.download-settings input').exists()).toBe(true)
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
  })

  it('replaces stale dialog URL with the internal-browser URL instead of clipboard content', async () => {
    readTextMock.mockResolvedValueOnce('https://github.com/AnInsomniacy/motrix-next-extension')
    const appStore = useAppStore()
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      'https://github.com/AnInsomniacy/motrix-next-extension',
    )

    appStore.addTaskFromWebPanel = true
    appStore.pendingBatch = [createBatchItem('uri', 'https://www.bilibili.com/video/BV1LRwyz3EcN/')]
    await flushPromises()
    await nextTick()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      'https://www.bilibili.com/video/BV1LRwyz3EcN/',
    )
  })

  it('passes pending internal-browser cookie into automatic media parsing', async () => {
    const appStore = useAppStore()
    appStore.addTaskFromWebPanel = true
    appStore.pendingCookie = 'SESSDATA=login; buvid3=guest'
    appStore.pendingReferer = 'https://www.bilibili.com/video/BV1LRwyz3EcN/'
    appStore.pendingBatch = [createBatchItem('uri', 'https://www.bilibili.com/video/BV1LRwyz3EcN/')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    expect(parseUrlMock).toHaveBeenCalledWith(
      'https://www.bilibili.com/video/BV1LRwyz3EcN/',
      'SESSDATA=login; buvid3=guest',
      '',
      '',
      'https://www.bilibili.com/video/BV1LRwyz3EcN/',
    )
  })

  it('retries internal-browser automatic media parsing when cookie arrives after the URL', async () => {
    const appStore = useAppStore()
    appStore.addTaskFromWebPanel = true
    appStore.pendingBatch = [createBatchItem('uri', 'https://www.bilibili.com/video/BV1LRwyz3EcN/')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    appStore.pendingCookie = 'SESSDATA=login; buvid3=guest'
    await flushPromises()
    await nextTick()

    expect(parseUrlMock).toHaveBeenCalledWith(
      'https://www.bilibili.com/video/BV1LRwyz3EcN/',
      'SESSDATA=login; buvid3=guest',
      '',
      '',
      '',
    )
  })

  it('retries internal-browser parsing when cookie arrives during an in-flight parse', async () => {
    let resolveFirstParse: (result: { type: 'NotMedia' }) => void = () => undefined
    parseUrlMock.mockImplementationOnce(
      () =>
        new Promise<{ type: 'NotMedia' }>((resolve) => {
          resolveFirstParse = resolve
        }),
    )

    const appStore = useAppStore()
    appStore.addTaskFromWebPanel = true
    appStore.pendingBatch = [createBatchItem('uri', 'https://www.bilibili.com/video/BV1LRwyz3EcN/')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    appStore.pendingCookie = 'SESSDATA=login; buvid3=guest'
    await nextTick()
    resolveFirstParse({ type: 'NotMedia' })
    await flushPromises()
    await nextTick()

    expect(parseUrlMock).toHaveBeenCalledWith(
      'https://www.bilibili.com/video/BV1LRwyz3EcN/',
      'SESSDATA=login; buvid3=guest',
      '',
      '',
      '',
    )
  })

  // ── Torrent panel: conditional rendering ───────────────────────────

  it('does not submit an internal-browser video URL as a normal aria2 task when parsing fails', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    const webPanelGuardIndex = source.indexOf('if (isFromWebPanel.value)')
    const normalSubmitIndex = source.indexOf('await submitNormalBranch(effectiveForm, options)')

    expect(webPanelGuardIndex).toBeGreaterThan(0)
    expect(normalSubmitIndex).toBeGreaterThan(webPanelGuardIndex)
    expect(source).toContain('视频解析失败，未创建普通下载任务')
  })

  it('shows the torrent panel (.torrent-panel) when fileItems exist', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/a.torrent')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('.torrent-panel').exists()).toBe(true)
  })

  it('hides the torrent panel when no fileItems exist', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('.torrent-panel').exists()).toBe(false)
  })

  it('renders batch items inside the torrent panel', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/a.torrent'), createBatchItem('torrent', '/tmp/b.torrent')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.findAll('.batch-item').length).toBe(2)
  })

  // ── Animation: AutoAnimate list transitions ─────────────────────────

  it('uses v-auto-animate directive for batch list instead of TransitionGroup', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    // Must use AutoAnimate — the industry-standard library
    expect(source).toContain('v-auto-animate')
    expect(source).toContain('@formkit/auto-animate')
    // Must NOT use old TransitionGroup names that caused CSS cascade conflicts
    expect(source).not.toContain('name="blist"')
    expect(source).not.toContain('name="bitem"')
    expect(source).not.toContain('name="batch-item"')
    // Must NOT have hand-crafted TransitionGroup CSS classes
    expect(source).not.toContain('.blist-move')
    expect(source).not.toContain('.blist-leave-active')
  })

  it('does not define WAAPI animation hooks (AutoAnimate replaces them)', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).not.toContain('onItemEnter')
    expect(source).not.toContain('onItemLeave')
    expect(source).not.toContain('onBeforeEnter')
    expect(source).not.toContain('onBeforeLeave')
    expect(source).not.toContain('savedContainerHeight')
  })

  // ── Animation: content-fade retained ───────────────────────────────

  it('retains content-fade transition for file detail switching', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).toContain('name="content-fade"')
  })

  // ── No CSS transition class pollution ──────────────────────────────

  it('does not define bitem-* CSS classes (AutoAnimate replaces CSS transitions)', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).not.toContain('.bitem-enter-active')
    expect(source).not.toContain('.bitem-leave-active')
    expect(source).not.toContain('.bitem-enter-from')
    expect(source).not.toContain('.bitem-leave-to')
  })

  it('does not use the old useAddTaskAnimations composable', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).not.toContain('useAddTaskAnimations')
  })
})

describe('AddTask submit flow', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
    pushMock.mockClear()
    warningMock.mockClear()
  })

  it('keeps the dialog open when manual magnet submission reports failures', async () => {
    const source = (await import('@/components/task/AddTask.vue?raw')).default
    expect(source).toContain('manualResult.magnetFailures')
    expect(source).toContain('const failedCount =')
    expect(source).toContain('handleClose()')
  })
})
