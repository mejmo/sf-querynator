import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import type { SfRecord } from '../../../shared/types'
import { cellToString } from '../../../soql/export'
import { isSubqueryCell, type FlatCell, type FlatTable } from '../../../soql/flatten'

const ROW_HEIGHT = 26
const CHAR_WIDTH = 7.4
const MIN_COL = 70
const MAX_COL = 420

interface Props {
  table: FlatTable
  onOpenSubquery(column: string, records: SfRecord[]): void
}

/** Width from the header and a sample of values. */
function columnWidths(table: FlatTable): number[] {
  const sample = table.rows.slice(0, 100)
  return table.columns.map((c) => {
    const longest = Math.max(c.length, ...sample.map((r) => (isSubqueryCell(r[c]) ? 10 : cellToString(r[c]).length)))
    return Math.min(MAX_COL, Math.max(MIN_COL, Math.round(longest * CHAR_WIDTH + 18)))
  })
}

function Cell({ value, column, onOpenSubquery }: { value: FlatCell | undefined; column: string; onOpenSubquery: Props['onOpenSubquery'] }) {
  if (value === null || value === undefined) return <span className="null">null</span>
  if (isSubqueryCell(value)) {
    return (
      <button className="link" onClick={() => onOpenSubquery(column, value.subquery)}>
        {value.totalSize} record{value.totalSize === 1 ? '' : 's'}
      </button>
    )
  }
  return <>{String(value)}</>
}

export function DataTable({ table, onOpenSubquery }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const widths = useMemo(() => columnWidths(table), [table])
  const rowNumWidth = Math.max(40, String(table.rows.length).length * 8 + 16)
  const totalWidth = rowNumWidth + widths.reduce((a, b) => a + b, 0)

  const virtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  return (
    <div className="table-scroll" ref={scrollRef}>
      <div style={{ width: totalWidth, height: ROW_HEIGHT + virtualizer.getTotalSize(), position: 'relative' }}>
        <div className="thead" style={{ height: ROW_HEIGHT, width: totalWidth }}>
          <div className="th rownum" style={{ width: rowNumWidth }}>
            #
          </div>
          {table.columns.map((c, i) => (
            <div key={c} className="th" style={{ width: widths[i] }} title={c}>
              {c}
            </div>
          ))}
        </div>
        {virtualizer.getVirtualItems().map((v) => {
          const row = table.rows[v.index]
          return (
            <div key={v.key} className="tr" style={{ top: ROW_HEIGHT + v.start, height: ROW_HEIGHT, width: totalWidth }}>
              <div className="td rownum" style={{ width: rowNumWidth }}>
                {v.index + 1}
              </div>
              {table.columns.map((c, i) => (
                <div key={c} className="td" style={{ width: widths[i] }} title={isSubqueryCell(row[c]) ? undefined : cellToString(row[c])}>
                  <Cell value={row[c]} column={c} onOpenSubquery={onOpenSubquery} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
