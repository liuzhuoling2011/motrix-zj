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
  parseTorrentBufferMock,
  uint8ToBase64Mock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(() => Promise.resolve()),
  successMock: vi.fn(),
  warningMock: vi.fn(),
  errorMock: vi.fn(),
  readFileMock: vi.fn(async () => new Uint8Array([1, 2, 3])),
  openDialogMock: vi.fn(),
  parseTorrentBufferMock: vi.fn(async () => ({
    infoHash: 'hash',
    files: [{ idx: 1, path: 'file.bin', length: 1 }],
  })),
  uint8ToBase64Mock: vi.fn(() => 'base64'),
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

vi.mock('@/composables/useTorrentParser', () => ({
  parseTorrentBuffer: parseTorrentBufferMock,
  uint8ToBase64: uint8ToBase64Mock,
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default ? slots.default() : [])
    },
  })

  const NButton = defineComponent({
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default ? slots.default() : [])
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

const TorrentUploadStub = defineComponent({
  name: 'TorrentUpload',
  props: {
    loaded: { type: Boolean, default: false },
  },
  emits: ['choose'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', [
        props.loaded
          ? slots['file-list']
            ? slots['file-list']()
            : []
          : h('button', { onClick: () => emit('choose') }, 'choose-file'),
        slots.placeholder ? slots.placeholder() : [],
      ])
  },
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
        TorrentUpload: TorrentUploadStub,
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
    parseTorrentBufferMock.mockClear()
    uint8ToBase64Mock.mockClear()
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

    // Batch list should be visible when there are file items
    const batchListBeforeClose = wrapper.find('.batch-list')
    expect(batchListBeforeClose.exists()).toBe(true)

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
    // which writes split=32 to the store via transformBasicForStore
    preferenceStore.$patch({ config: { split: 32, maxConnectionPerServer: 32, engineMaxConnectionPerServer: 32 } })

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

  it('falls back to maxConnectionPerServer when config.split is absent', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    // Simulate legacy store data where split was never saved — explicitly
    // null out split so the ?? fallback to maxConnectionPerServer kicks in.
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
      return val > 0 && val <= 128
    })
    expect(splitInput).toBeDefined()
    expect(Number((splitInput!.element as HTMLInputElement).value)).toBe(48)
  })

  it('re-syncs split on subsequent opens after preference changes', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    preferenceStore.$patch({ config: { split: 64, maxConnectionPerServer: 64, engineMaxConnectionPerServer: 64 } })

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
    preferenceStore.$patch({ config: { split: 16, maxConnectionPerServer: 16, engineMaxConnectionPerServer: 16 } })

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
