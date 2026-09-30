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
  const theadRef = useRef<HTMLDivElement>(null)
  /** Column being dragged to a new position (reordered live while the mouse moves). */
  const [dragging, setDragging] = useState<string | null>(null)
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
    document.body.classList.add('col-resizing')
    const onMove = (ev: MouseEvent) => layout.setWidth(column, resizeWidth(startWidth, ev.clientX - startX))
    const onUp = () => {
      document.body.classList.remove('col-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /**
   * Live reorder: after a few pixels of movement the pressed header follows the mouse; whenever the pointer crosses
   * the middle of another header, the column jumps to that side of it (data cells move with it immediately).
   */
  const startReorder = (e: ReactMouseEvent, column: string) => {
    if (e.button !== 0) return
    const startX = e.clientX
    let active = false
    const onMove = (ev: MouseEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 4) return
        active = true
        setDragging(column)
        document.body.classList.add('col-dragging')
      }
      autoScroll(ev.clientX)
      const head = theadRef.current
      if (!head) return
      const headers = [...head.querySelectorAll<HTMLElement>('[data-col]')]
      const from = headers.findIndex((h) => h.dataset.col === column)
      const target = headers.find((h) => {
        const r = h.getBoundingClientRect()
        return ev.clientX >= r.left && ev.clientX < r.right
      })
      if (!target || target.dataset.col === column) return
      const to = headers.indexOf(target)
      const r = target.getBoundingClientRect()
      const mid = r.left + r.width / 2
      if (from < to && ev.clientX > mid) layout.move(column, target.dataset.col!, 'after')
      else if (from > to && ev.clientX < mid) layout.move(column, target.dataset.col!, 'before')
    }
    const onUp = () => {
      setDragging(null)
      document.body.classList.remove('col-dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Scroll horizontally while dragging near the grid's left or right edge. */
  const autoScroll = (clientX: number) => {
    const el = scrollRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (clientX < r.left + 40) el.scrollLeft -= 20
    else if (clientX > r.right - 40) el.scrollLeft += 20
  }

  return (
    <div className="table-scroll" ref={scrollRef}>
      <div style={{ width: totalWidth, height: ROW_HEIGHT + virtualizer.getTotalSize(), position: 'relative' }}>
        <div className="thead" ref={theadRef} style={{ height: ROW_HEIGHT, width: totalWidth }}>
          <div className="th rownum" style={{ width: rowNumWidth }}>
            #
          </div>
          {columns.map((c) => (
            <div
              key={c}
              data-col={c}
              className={`th${dragging === c ? ' dragging' : ''}`}
              style={{ width: widthOf(c) }}
              title={`${c} — drag to reorder`}
              onMouseDown={(e) => startReorder(e, c)}
            >
              <span className="th-label">{c}</span>
              <span
                className="col-resizer"
                title="Drag to resize · double-click to fit"
                onMouseDown={(e) => startResize(e, c)}
                onDoubleClick={() => layout.autoFit(c)}
              />
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
              {columns.map((c) => (
                <div key={c} className={`td${dragging === c ? ' dragging' : ''}`} style={{ width: widthOf(c) }} title={isSubqueryCell(row[c]) ? undefined : cellToString(row[c])}>
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
