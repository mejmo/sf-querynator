import type { SfRecord } from '../shared/types'

export interface SubqueryCell {
  subquery: SfRecord[]
  totalSize: number
}

export type FlatCell = string | number | boolean | null | SubqueryCell

export type FlatRow = Record<string, FlatCell>

export interface FlatTable {
  columns: string[]
  rows: FlatRow[]
}

export function isSubqueryCell(v: unknown): v is SubqueryCell {
  return typeof v === 'object' && v !== null && 'subquery' in v
}

function isQueryResult(v: object): v is { records: SfRecord[]; totalSize: number } {
  return Array.isArray((v as { records?: unknown }).records)
}

function isRelationship(v: object): v is SfRecord {
  return 'attributes' in v
}

function flattenInto(record: SfRecord, prefix: string, row: FlatRow, columns: string[], seen: Set<string>) {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue
    const col = prefix + key
    if (value !== null && typeof value === 'object') {
      if (isQueryResult(value)) {
        addColumn(col, columns, seen)
        row[col] = { subquery: value.records, totalSize: value.totalSize }
        continue
      }
      if (isRelationship(value)) {
        flattenInto(value, `${col}.`, row, columns, seen)
        continue
      }
      // Compound fields (address, geolocation) are shown as JSON.
      addColumn(col, columns, seen)
      row[col] = JSON.stringify(value)
      continue
    }
    addColumn(col, columns, seen)
    row[col] = value as FlatCell
  }
}

function addColumn(col: string, columns: string[], seen: Set<string>) {
  if (!seen.has(col)) {
    seen.add(col)
    columns.push(col)
  }
}

/**
 * Turn Salesforce records into rows with dotted relationship columns (`Owner.Name`).
 * Child subquery results become SubqueryCell values. A null parent (e.g. `Account: null`) produces
 * no column of its own when other rows supply `Account.*` columns.
 */
export function flattenRecords(records: SfRecord[]): FlatTable {
  const columns: string[] = []
  const seen = new Set<string>()
  const rows = records.map((r) => {
    const row: FlatRow = {}
    flattenInto(r, '', row, columns, seen)
    return row
  })
  const filtered = columns.filter((c) => !columns.some((other) => other.startsWith(`${c}.`)))
  return { columns: filtered, rows }
}

/** Remove `attributes` everywhere (for JSON export and subquery cells). */
export function stripAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAttributes)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'attributes') out[k] = stripAttributes(v)
    }
    return out
  }
  return value
}
