import type { GlobalDescribeEntry, SObjectDescribe } from '../../shared/types'
import type { MetadataSource } from '../../soql/completions'

/** In-memory cache in front of the main-process disk cache, so typing doesn't spam IPC. Failures are retried later. */
export function createMetadataSource(envId: string): MetadataSource {
  let global: Promise<GlobalDescribeEntry[] | null> | null = null
  const objects = new Map<string, Promise<SObjectDescribe | null>>()

  return {
    getGlobal() {
      global ??= window.api.describeGlobal(envId).then((r) => {
        if (r.ok) return r.value
        global = null
        return null
      })
      return global
    },
    describe(name) {
      const key = name.toLowerCase()
      let p = objects.get(key)
      if (!p) {
        p = window.api.describeSObject(envId, name).then((r) => {
          if (r.ok) return r.value
          objects.delete(key)
          return null
        })
        objects.set(key, p)
      }
      return p
    }
  }
}

export const emptyMetadata: MetadataSource = {
  getGlobal: async () => null,
  describe: async () => null
}

let active: MetadataSource = emptyMetadata

export function setActiveMetadata(source: MetadataSource | null) {
  active = source ?? emptyMetadata
}

export function getActiveMetadata(): MetadataSource {
  return active
}
