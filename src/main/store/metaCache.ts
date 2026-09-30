import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { GlobalDescribeEntry, SObjectDescribe } from '../../shared/types'
import { readJson, writeJson } from './jsonFile'

const SAFE_NAME = /^[A-Za-z0-9_]+$/

/** Bump when the cached describe shape changes; older entries are then refetched. */
export const META_CACHE_VERSION = 2

interface Entry<T> {
  v: number
  data: T
}

async function readEntry<T>(file: string): Promise<T | null> {
  const entry = await readJson<Entry<T> | null>(file, null)
  return entry && entry.v === META_CACHE_VERSION ? entry.data : null
}

const writeEntry = <T>(file: string, data: T) => writeJson(file, { v: META_CACHE_VERSION, data } satisfies Entry<T>)

export class MetaCache {
  constructor(private readonly dir: string) {}

  private objectFile(envId: string, name: string) {
    if (!SAFE_NAME.test(name)) throw new Error(`Invalid object name: ${name}`)
    return join(this.dir, envId, `${name.toLowerCase()}.json`)
  }

  getGlobal(envId: string): Promise<GlobalDescribeEntry[] | null> {
    return readEntry(join(this.dir, envId, '_global.json'))
  }

  setGlobal(envId: string, list: GlobalDescribeEntry[]): Promise<void> {
    return writeEntry(join(this.dir, envId, '_global.json'), list)
  }

  async getObject(envId: string, name: string): Promise<SObjectDescribe | null> {
    return readEntry(this.objectFile(envId, name))
  }

  async setObject(envId: string, describe: SObjectDescribe): Promise<void> {
    return writeEntry(this.objectFile(envId, describe.name), describe)
  }

  clear(envId: string): Promise<void> {
    return rm(join(this.dir, envId), { recursive: true, force: true })
  }
}
