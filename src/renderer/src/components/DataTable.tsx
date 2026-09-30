import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { SfRecord } from '../../../shared/types'
import { cellToString } from '../../../soql/export'
import { isSubqueryCell, type FlatCell, type FlatTable } from '../../../soql/flatten'
import { MAX_AUTO_COLUMN_WIDTH, MIN_COLUMN_WIDTH, mergeColumnOrder, moveColumn, resizeWidth } from '../columnLayout'

const ROW_HEIGHT = 26
const CHAR_WIDTH = 7.4

/** Width from the header and a sample of values. */
function autoWidth(table: FlatTable, column: string): number {
  const sample = table.rows.slice(0, 100)
  const longest = Math.max(column.length, ...sample.map((r) => (isSubqueryCell(r[column]) ? 10 : cellToString(r[column]).length)))
  return Math.min(MAX_AUTO_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH + 20, Math.round(longest * CHAR_WIDTH + 18)))
}

export interface ColumnLayout {
  /** Columns in display order */
  order: string[]
  widths: Record<string, number>
  setWidth(column: string, width: number): void
  autoFit(column: string): void
  move(column: string, target: string, side: 'before' | 'after'): void
}

/**
 * User-adjustable column order and widths. Survives "Load more" (new columns are appended); a result with a
 * different set of columns keeps whatever still applies.
 */
export function useColumnLayout(table: FlatTable): ColumnLayout {
  const [order, setOrder] = useState<string[]>(table.columns)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const columnsKey = table.columns.join('\u0000')

  useEffect(() => {
    setOrder((prev) => mergeColumnOrder(prev, table.columns))
    setWidths((prev) => {
      const next: Record<string, number> = {}
      for (const c of table.columns) next[c] = prev[c] ?? autoWidth(table, c)
      return next
    })
    // Only when the set of columns changes; rows alone (Load more) keep the widths.
  }, [columnsKey])

  return {
    // Before the effect runs for a new result, fall back to the table's own columns.
    order: order.length && order.every((c) => table.columns.includes(c)) ? mergeColumnOrder(order, table.columns) : table.columns,
    widths,
    setWidth: (column, width) => setWidths((w) => ({ ...w, [column]: width })),
    autoFit: (column) => setWidths((w) => ({ ...w, [column]: autoWidth(table, column) })),
    move: (column, target, side) => setOrder((o) => moveColumn(mergeColumnOrder(o, table.columns), column, target, side))
  }
}

interface Props {
  table: FlatTable
  layout: ColumnLayout
  onOpenSubquery(column: string, records: SfRecord[]): void
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

export function DataTable({ table, layout, onOpenSubquery }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // A mouse press on a resize grip must not turn into a header drag (reorder).
  const resizing = useRef(false)
  const [dropTarget, setDropTarget] = useState<{ column: string; side: 'before' | 'after' } | null>(null)
  const columns = layout.order
  const widthOf = (c: string) => layout.widths[c] ?? autoWidth(table, c)
  const rowNumWidth = Math.max(40, String(table.rows.length).length * 8 + 16)
  const totalWidth = useMemo(() => rowNumWidth + columns.reduce((sum, c) => sum + widthOf(c), 0), [columns, layout.widths, rowNumWidth])

  const virtualizer = useVirtualizer({
    count: table.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  const startResize = (e: ReactMouseEvent, column: string) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widthOf(column)
    resizing.current = true
    document.body.classList.add('col-resizing')
    const onMove = (ev: MouseEvent) => layout.setWidth(column, resizeWidth(startWidth, ev.clientX - startX))
    const onUp = () => {
      resizing.current = false
      document.body.classList.remove('col-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const sideFor = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  }

  return (
    <div className="table-scroll" ref={scrollRef}>
      <div style={{ width: totalWidth, height: ROW_HEIGHT + virtualizer.getTotalSize(), position: 'relative' }}>
        <div className="thead" style={{ height: ROW_HEIGHT, width: totalWidth }}>
          <div className="th rownum" style={{ width: rowNumWidth }}>
            #
          </div>
          {columns.map((c) => {
            const drop = dropTarget?.column === c && dragging !== c ? dropTarget.side : null
            return (
              <div
                key={c}
                className={`th${dragging === c ? ' dragging' : ''}${drop ? ` drop-${drop}` : ''}`}
                style={{ width: widthOf(c) }}
                title={`${c} — drag to reorder`}
                draggable
                onDragStart={(e) => {
                  if (resizing.current) {
                    e.preventDefault()
                    return
                  }
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', c)
                  setDragging(c)
                }}
                onDragOver={(e) => {
                  if (!dragging) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const side = sideFor(e)
                  if (dropTarget?.column !== c || dropTarget.side !== side) setDropTarget({ column: c, side })
                }}
                onDragLeave={() => setDropTarget((t) => (t?.column === c ? null : t))}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragging) layout.move(dragging, c, sideFor(e))
                  setDragging(null)
                  setDropTarget(null)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDropTarget(null)
                }}
              >
                <span className="th-label">{c}</span>
                <span
                  className="col-resizer"
                  title="Drag to resize · double-click to fit"
                  draggable={false}
                  onMouseDown={(e) => startResize(e, c)}
                  onDoubleClick={() => layout.autoFit(c)}
                  onDragStart={(e) => e.preventDefault()}
                />
              </div>
            )
          })}
        </div>
        {virtualizer.getVirtualItems().map((v) => {
          const row = table.rows[v.index]
          return (
            <div key={v.key} className="tr" style={{ top: ROW_HEIGHT + v.start, height: ROW_HEIGHT, width: totalWidth }}>
              <div className="td rownum" style={{ width: rowNumWidth }}>
                {v.index + 1}
              </div>
              {columns.map((c) => (
                <div key={c} className="td" style={{ width: widthOf(c) }} title={isSubqueryCell(row[c]) ? undefined : cellToString(row[c])}>
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
