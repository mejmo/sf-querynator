/**
 * The environment entries in an import: an export file (`{ environments: [...] }`), a bare array, or a single
 * environment object. Entries are not validated here; the main process does that on import.
 */
export function environmentEntries(data: unknown): unknown[] {
  if (data && typeof data === 'object' && 'environments' in data && Array.isArray((data as { environments: unknown }).environments)) {
    return (data as { environments: unknown[] }).environments
  }
  return Array.isArray(data) ? data : data == null ? [] : [data]
}

export interface ImportPreviewItem {
  name: string
  authType: string
  /** An environment with this name (case-insensitive) already exists and will be updated. */
  updatesExisting: boolean
}

/** What pasted JSON would import, for the preview in the import dialog. Throws with a readable message. */
export function previewImport(text: string, existingNames: string[]): ImportPreviewItem[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const entries = environmentEntries(data)
  if (entries.length === 0) throw new Error('The JSON contains no environments.')
  const existing = new Set(existingNames.map((n) => n.toLowerCase()))
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Environment #${i + 1} is not an object.`)
    const e = entry as { name?: unknown; authType?: unknown; authUrl?: unknown }
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!name) throw new Error(`Environment #${i + 1} has no name.`)
    const authType = typeof e.authType === 'string' ? e.authType : e.authUrl ? 'azure' : 'salesforce'
    return { name, authType, updatesExisting: existing.has(name.toLowerCase()) }
  })
}
