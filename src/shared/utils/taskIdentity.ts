/** @fileoverview Stable task identity helpers for deduplicating live tasks and history records. */
import type { Aria2Task } from '@shared/types'

export interface TaskIdentityBuckets {
  gids: string[]
  btInfoHashes: string[]
  ed2kHashes: string[]
  ed2kLinks: string[]
}

function addUnique(values: Set<string>, value: string | undefined): void {
  const normalized = value?.trim()
  if (normalized) values.add(normalized)
}

export function collectTaskIdentityBuckets(tasks: Aria2Task[]): TaskIdentityBuckets {
  const gids = new Set<string>()
  const btInfoHashes = new Set<string>()
  const ed2kHashes = new Set<string>()
  const ed2kLinks = new Set<string>()

  for (const task of tasks) {
    addUnique(gids, task.gid)
    addUnique(btInfoHashes, task.infoHash)
    addUnique(ed2kHashes, task.ed2k?.hash)
    addUnique(ed2kLinks, task.ed2k?.ed2kLink)
  }

  return {
    gids: [...gids],
    btInfoHashes: [...btInfoHashes],
    ed2kHashes: [...ed2kHashes],
    ed2kLinks: [...ed2kLinks],
  }
}
