import type { SfRecord } from '../shared/types'
import { isSubqueryCell, stripAttributes, type FlatCell, type FlatTable } from './flatten'

export function cellToString(cell: FlatCell | undefined): string {
  if (cell === null || cell === undefined) return ''
  if (isSubqueryCell(cell)) return JSON.stringify(stripAttributes(cell.subquery))
  return String(cell)
}

function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** RFC 4180 CSV with CRLF line endings. */
export function toCsv(table: FlatTable): string {
  const lines = [table.columns.map(csvEscape).join(',')]
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => csvEscape(cellToString(row[c]))).join(','))
  }
  return lines.join('\r\n')
}

/** Tab-separated, for pasting into spreadsheets. */
export function toTsv(table: FlatTable): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  const lines = [table.columns.map(clean).join('\t')]
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => clean(cellToString(row[c]))).join('\t'))
  }
  return lines.join('\n')
}

export function toJson(records: SfRecord[]): string {
  return JSON.stringify(stripAttributes(records), null, 2)
}
