/**
 * @fileoverview Tracker source URL options for BT tracker synchronization.
 *
 * Extracted from Advanced.vue to reduce component file size.
 * Contains grouped select options for ngosang/trackerslist and
 * XIU2/TrackersListCollection repositories.
 */
import { h } from 'vue'
import { NTag } from 'naive-ui'
import { TRACKER_SOURCE_OPTIONS } from '@shared/constants'

/** Creates a label VNode with a CDN tag indicator. */
function cdnLabel(text: string) {
  return () =>
    h('span', {}, [
      h('span', {}, `${text} `),
      h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
    ])
}

export const trackerSourceOptions = TRACKER_SOURCE_OPTIONS.map((group) => ({
  type: 'group' as const,
  label: group.label,
  key: group.label,
  children: group.options.map((option) => ({
    label: option.cdn ? cdnLabel(option.label) : option.label,
    value: option.value,
  })),
}))
