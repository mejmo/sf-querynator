import { useEffect, useMemo, useState } from 'react'
import { previewImport, type ImportPreviewItem } from '../../../shared/environmentFile'
import type { Environment } from '../../../shared/types'
import { useStore } from '../store'
import { Modal } from './Modal'

const AUTH_LABEL: Record<string, string> = { salesforce: 'Salesforce OAuth', azure: 'Azure SSO', token: 'Access token' }

/** Pick environments with checkboxes; the export JSON is built live and can be copied or saved. */
export function ExportDialog({ environments, initialIds, onClose }: { environments: Environment[]; initialIds: string[]; onClose(): void }) {
  const notify = useStore((s) => s.notify)
  const [selected, setSelected] = useState<Set<string>>(new Set(initialIds))
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ids = environments.filter((e) => selected.has(e.id)).map((e) => e.id)
  const idsKey = ids.join(',')

  useEffect(() => {
    if (ids.length === 0) {
      setJson('')
      return
    }
    let stale = false
    void window.api.buildEnvironmentFile(ids).then((r) => {
      if (stale) return
      if (r.ok) {
        setJson(JSON.stringify(r.value, null, 2))
        setError(null)
      } else setError(r.error.message)
    })
    return () => {
      stale = true
    }
  }, [idsKey])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allSelected = ids.length === environments.length
  const fileName = ids.length === 1 ? `${environments.find((e) => e.id === ids[0])!.name.replace(/[^\w.-]+/g, '-')}.querynator.json` : 'environments.querynator.json'

  const copy = async () => {
    await navigator.clipboard.writeText(json)
    notify(`Copied ${ids.length} environment${ids.length === 1 ? '' : 's'} as JSON`)
  }
  const save = async () => {
    const r = await window.api.saveFile(fileName, json)
    if (!r.ok) setError(r.error.message)
    else if (r.value) notify(`Saved ${fileName}`)
  }

  return (
    <Modal
      title="Export environments"
      className="env-transfer"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Close</button>
          <button onClick={() => void save()} disabled={!json}>
            Save to file…
          </button>
          <button className="primary" onClick={() => void copy()} disabled={!json}>
            Copy JSON
          </button>
        </>
      }
    >
      <div className="transfer-layout">
        <div className="transfer-list">
          <label className="select-all">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(environments.map((e) => e.id)))} />
            All environments
          </label>
          <ul>
            {environments.map((e) => (
              <li key={e.id}>
                <label>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                  <span>{e.name}</span>
                  <span className="muted">{AUTH_LABEL[e.authType] ?? e.authType}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="muted">Settings and names only — never secrets or tokens.</p>
        </div>
        <div className="transfer-json">
          {error && <div className="form-error">{error}</div>}
          <textarea className="json-box" readOnly value={json || 'Select at least one environment.'} spellCheck={false} />
        </div>
      </div>
    </Modal>
  )
}

/** Paste export JSON (or load it from a file), preview what it will do, then import. */
export function ImportDialog({ environments, onClose, onImported }: { environments: Environment[]; onClose(): void; onImported(imported: Environment[]): void }) {
  const notify = useStore((s) => s.notify)
  const [text, setText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const preview = useMemo((): { items: ImportPreviewItem[] } | { error: string } | null => {
    if (!text.trim()) return null
    try {
      return { items: previewImport(text, environments.map((e) => e.name)) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [text, environments])
  const items = preview && 'items' in preview ? preview.items : null

  const loadFile = async () => {
    const r = await window.api.openTextFile('Querynator environments', ['json'])
    if (!r.ok) setImportError(r.error.message)
    else if (r.value !== null) {
      setText(r.value)
      setImportError(null)
    }
  }

  const doImport = async () => {
    if (!items) return
    setBusy(true)
    const r = await window.api.importEnvironments(JSON.parse(text))
    setBusy(false)
    if (!r.ok) return setImportError(r.error.message)
    notify(`Imported ${r.value.map((e) => e.name).join(', ')}`)
    onImported(r.value)
  }

  return (
    <Modal
      title="Import environments"
      className="env-transfer"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void doImport()} disabled={!items || busy}>
            {items ? `Import ${items.length} environment${items.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      }
    >
      <p className="muted">
        Paste the JSON from <strong>Export environments</strong> (or a single environment object), or{' '}
        <button className="link" onClick={() => void loadFile()}>
          load it from a file…
        </button>
      </p>
      <textarea
        className="json-box import-box"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setImportError(null)
        }}
        placeholder='{ "format": "querynator-environments", "version": 1, "environments": [ … ] }'
        spellCheck={false}
        autoFocus
      />
      {importError && <div className="form-error">{importError}</div>}
      {preview && 'error' in preview && <div className="form-error">{preview.error}</div>}
      {items && (
        <ul className="import-preview">
          {items.map((it, i) => (
            <li key={i}>
              <span className={`badge ${it.updatesExisting ? 'badge-required' : 'badge-custom'}`}>{it.updatesExisting ? 'updates existing' : 'new'}</span>
              <strong>{it.name}</strong> <span className="muted">{AUTH_LABEL[it.authType] ?? it.authType}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
