import { useMemo, useState } from 'react'
import { useStore } from '../store'

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString()
}

export function HistoryPanel() {
  const history = useStore((s) => s.history)
  const loadQuery = useStore((s) => s.loadQuery)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return needle ? history.filter((h) => h.query.toLowerCase().includes(needle)) : history
  }, [history, search])

  return (
    <div className="history">
      <div className="section-title">History</div>
      <input type="search" placeholder="Search history…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul>
        {filtered.length === 0 && <li className="muted">{history.length ? 'No matches' : 'Queries you run appear here'}</li>}
        {filtered.map((h) => (
          <li key={h.ranAt + h.query} onClick={() => loadQuery(h.query)} title={h.error ? `${h.query}\n\n${h.error}` : h.query}>
            <div className="q">{h.query}</div>
            <div className="meta">
              {h.error ? <span className="fail">✗ error</span> : <span className="okmark">✓ {h.rowCount} rows</span>} · {h.durationMs} ms ·{' '}
              {relativeTime(h.ranAt)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
