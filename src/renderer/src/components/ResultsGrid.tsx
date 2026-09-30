import { useMemo, useState } from 'react'
import type { SfRecord } from '../../../shared/types'
import { toCsv, toJson, toTsv } from '../../../soql/export'
import { flattenRecords } from '../../../soql/flatten'
import { useStore } from '../store'
import { DataTable } from './DataTable'
import { Modal } from './Modal'

export function ResultsGrid() {
  const { result, loadingMore, running, loadMore, cancel, notify } = useStore()
  const [subquery, setSubquery] = useState<{ column: string; records: SfRecord[] } | null>(null)
  const table = useMemo(() => flattenRecords(result?.records ?? []), [result?.records])
  const subTable = useMemo(() => (subquery ? flattenRecords(subquery.records) : null), [subquery])

  if (!result) {
    return (
      <div className="results">
        <div className="empty-state">{running ? 'Running…' : 'Run a query (Ctrl+Enter) to see results.'}</div>
      </div>
    )
  }

  const save = async (name: string, content: string) => {
    const r = await window.api.saveFile(name, content)
    if (r.ok && r.value) notify(`Saved ${name}`)
    else if (!r.ok) notify(r.error.message)
  }

  const copy = async () => {
    await navigator.clipboard.writeText(toTsv(table))
    notify(`Copied ${table.rows.length} rows — paste into a spreadsheet`)
  }

  const loaded = result.records.length

  return (
    <div className="results">
      <div className="results-bar">
        <span className="stats">
          {result.totalSize.toLocaleString()} total · {loaded.toLocaleString()} loaded · {result.durationMs} ms
        </span>
        {result.nextRecordsUrl &&
          (loadingMore ? (
            <button onClick={() => void cancel()}>
              <span className="spinner" /> Cancel
            </button>
          ) : (
            <button onClick={() => void loadMore()}>Load more</button>
          ))}
        <button onClick={() => void save('results.csv', toCsv(table))} disabled={loaded === 0}>
          CSV
        </button>
        <button onClick={() => void save('results.json', toJson(result.records))} disabled={loaded === 0}>
          JSON
        </button>
        <button onClick={() => void copy()} disabled={loaded === 0}>
          Copy
        </button>
      </div>
      {loaded === 0 ? (
        <div className="empty-state">No rows returned.</div>
      ) : (
        <DataTable table={table} onOpenSubquery={(column, records) => setSubquery({ column, records })} />
      )}
      {subquery && subTable && (
        <Modal title={`${subquery.column} (${subquery.records.length})`} className="subquery" onClose={() => setSubquery(null)}>
          <DataTable table={subTable} onOpenSubquery={(column, records) => setSubquery({ column, records })} />
        </Modal>
      )}
    </div>
  )
}
