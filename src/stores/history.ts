/** @fileoverview Pinia store for SQLite-backed download history persistence.
 *
 * Stores completed/errored download records independently from the aria2
 * session file (which only tracks active/paused tasks). Records survive
 * app restarts and upgrades.
 *
 * Database: sqlite:history.db (managed by tauri-plugin-sql with migrations).
 */
import { defineStore } from 'pinia'
import Database from '@tauri-apps/plugin-sql'
import type { HistoryRecord } from '@shared/types'

const DB_NAME = 'sqlite:history.db'

export const useHistoryStore = defineStore('history', () => {
  let db: Awaited<ReturnType<typeof Database.load>> | null = null
  let initPromise: Promise<void> | null = null

  /** Initialize the database connection and apply PRAGMA optimizations.
   *  Safe to call multiple times — subsequent calls are no-ops. */
  async function init(): Promise<void> {
    if (db) return
    if (!initPromise) {
      initPromise = (async () => {
        db = await Database.load(DB_NAME)
        // SQLite best practices: WAL for crash resilience + concurrent reads,
        // NORMAL sync for balanced durability/performance,
        // busy_timeout to avoid "database is locked" errors,
        // foreign_keys for referential integrity.
        await db.execute('PRAGMA journal_mode = WAL', [])
        await db.execute('PRAGMA synchronous = NORMAL', [])
        await db.execute('PRAGMA busy_timeout = 5000', [])
        await db.execute('PRAGMA foreign_keys = ON', [])
      })()
    }
    await initPromise
  }

  /** Returns the active database connection, auto-initializing if needed. */
  async function getDb() {
    if (!db) await init()
    return db!
  }

  /** Insert or update a download record (upsert by GID). */
  async function addRecord(record: HistoryRecord): Promise<void> {
    await (
      await getDb()
    ).execute(
      `REPLACE INTO download_history
        (gid, name, uri, dir, total_length, status, task_type, completed_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.gid,
        record.name,
        record.uri ?? null,
        record.dir ?? null,
        record.total_length ?? null,
        record.status,
        record.task_type ?? null,
        record.completed_at ?? null,
        record.meta ?? null,
      ],
    )
  }

  /** Retrieve records, optionally filtered by status. Sorted by completed_at DESC. */
  async function getRecords(status?: string): Promise<HistoryRecord[]> {
    if (status) {
      return (await getDb()).select<HistoryRecord[]>(
        'SELECT * FROM download_history WHERE status = $1 ORDER BY completed_at DESC',
        [status],
      )
    }
    return (await getDb()).select<HistoryRecord[]>('SELECT * FROM download_history ORDER BY completed_at DESC', [])
  }

  /** Remove a single record by GID. */
  async function removeRecord(gid: string): Promise<void> {
    await (await getDb()).execute('DELETE FROM download_history WHERE gid = $1', [gid])
  }

  /** Remove all records, optionally filtered by status. Full reset also VACUUMs. */
  async function clearRecords(status?: string): Promise<void> {
    if (status) {
      await (await getDb()).execute('DELETE FROM download_history WHERE status = $1', [status])
    } else {
      await (await getDb()).execute('DELETE FROM download_history', [])
      // VACUUM reclaims disk space and resets AUTOINCREMENT counter
      await (await getDb()).execute('VACUUM', [])
    }
  }

  /** Remove records whose GIDs are in the provided list (stale file cleanup). */
  async function removeStaleRecords(gids: string[]): Promise<void> {
    if (gids.length === 0) return
    const placeholders = gids.map((_, i) => `$${i + 1}`).join(', ')
    await (await getDb()).execute(`DELETE FROM download_history WHERE gid IN (${placeholders})`, gids)
  }

  /** Run PRAGMA integrity_check and return the result string. */
  async function checkIntegrity(): Promise<string> {
    const result = await (await getDb()).select<{ integrity_check: string }[]>('PRAGMA integrity_check', [])
    return result[0]?.integrity_check ?? 'unknown'
  }

  /** Close the database connection. After calling, all operations will throw. */
  async function closeConnection(): Promise<void> {
    if (db) {
      await db.close()
      db = null
    }
  }

  return {
    init,
    addRecord,
    getRecords,
    removeRecord,
    clearRecords,
    removeStaleRecords,
    checkIntegrity,
    closeConnection,
  }
})
