import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry } from '../../shared/types'
import { Mutex, readJson, writeJson } from './jsonFile'

export const HISTORY_LIMIT = 100

export class HistoryStore {
  private mutex = new Mutex()

  constructor(private readonly dir: string) {}

  private file(envId: string) {
    return join(this.dir, `${envId}.json`)
  }

  list(envId: string): Promise<HistoryEntry[]> {
    return readJson<HistoryEntry[]>(this.file(envId), [])
  }

  /** Newest first. Re-running an identical query moves it to the top instead of duplicating it. */
  add(envId: string, entry: HistoryEntry): Promise<void> {
    return this.mutex.run(async () => {
      const key = entry.query.trim()
      const rest = (await this.list(envId)).filter((e) => e.query.trim() !== key)
      await writeJson(this.file(envId), [entry, ...rest].slice(0, HISTORY_LIMIT))
    })
  }

  deleteEnv(envId: string): Promise<void> {
    return this.mutex.run(() => rm(this.file(envId), { force: true }))
  }
}
