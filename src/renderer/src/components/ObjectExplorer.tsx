import { Fragment, useEffect, useMemo, useState } from 'react'
import type { AppError, FieldDescribe, GlobalDescribeEntry, SObjectDescribe } from '../../../shared/types'
import { buildSelect, fieldFlags, formatFieldType } from '../../../soql/schema'
import { useStore } from '../store'

const matches = (needle: string, ...values: (string | null | undefined)[]) =>
  !needle || values.some((v) => v?.toLowerCase().includes(needle))

export function ObjectExplorer({ active }: { active: boolean }) {
  const { envId, status, metadataVersion, explorerObject, setExplorerObject, loadQuery, setTab, notify } = useStore()
  const connected = status === 'connected'

  const [objects, setObjects] = useState<GlobalDescribeEntry[] | null>(null)
  const [objectsError, setObjectsError] = useState<AppError | null>(null)
  const [objectFilter, setObjectFilter] = useState('')
  const [customOnly, setCustomOnly] = useState(false)

  const [describe, setDescribe] = useState<SObjectDescribe | null>(null)
  const [describeError, setDescribeError] = useState<AppError | null>(null)
  const [fieldFilter, setFieldFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)

  // Object list: loaded when the tab is first shown for an environment (and after "⟳ Metadata").
  useEffect(() => {
    setObjects(null)
    setObjectsError(null)
  }, [envId, metadataVersion])

  useEffect(() => {
    if (!active || !connected || !envId || objects) return
    let stale = false
    void window.api.describeGlobal(envId).then((r) => {
      if (stale) return
      if (r.ok) setObjects(r.value)
      else setObjectsError(r.error)
    })
    return () => {
      stale = true
    }
  }, [active, connected, envId, objects])

  // Selected object's describe.
  useEffect(() => {
    setDescribe(null)
    setDescribeError(null)
    setSelected(new Set())
    setExpanded(null)
    setFieldFilter('')
    if (!envId || !connected || !explorerObject) return
    let stale = false
    void window.api.describeSObject(envId, explorerObject).then((r) => {
      if (stale) return
      if (r.ok) setDescribe(r.value)
      else setDescribeError(r.error)
    })
    return () => {
      stale = true
    }
  }, [envId, connected, explorerObject, metadataVersion])

  const visibleObjects = useMemo(() => {
    const needle = objectFilter.trim().toLowerCase()
    return (objects ?? []).filter((o) => o.queryable && (!customOnly || o.custom) && matches(needle, o.name, o.label))
  }, [objects, objectFilter, customOnly])

  const visibleFields = useMemo(() => {
    const needle = fieldFilter.trim().toLowerCase()
    return (describe?.fields ?? []).filter((f) => matches(needle, f.name, f.label, f.type, f.relationshipName))
  }, [describe, fieldFilter])

  if (!connected) return <div className="empty-state">Log in to browse objects and fields.</div>

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const allVisibleSelected = visibleFields.length > 0 && visibleFields.every((f) => selected.has(f.name))
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const f of visibleFields) {
        if (allVisibleSelected) next.delete(f.name)
        else next.add(f.name)
      }
      return next
    })

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text)
    notify(`Copied ${what}`)
  }

  const querySelected = () => {
    if (!describe) return
    // Keep describe order rather than click order.
    const fields = describe.fields.map((f) => f.name).filter((n) => selected.has(n))
    loadQuery(buildSelect(describe.name, fields))
    setTab('query')
  }

  return (
    <div className="explorer">
      <aside className="explorer-objects">
        <input type="search" placeholder="Search objects…" value={objectFilter} onChange={(e) => setObjectFilter(e.target.value)} autoFocus />
        <label className="muted">
          <input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} /> Custom objects only
        </label>
        {objectsError && <div className="form-error">{objectsError.message}</div>}
        {!objects && !objectsError && (
          <div className="muted">
            <span className="spinner" /> Loading objects…
          </div>
        )}
        <ul>
          {visibleObjects.map((o) => (
            <li key={o.name} className={o.name === explorerObject ? 'active' : ''} onClick={() => setExplorerObject(o.name)} title={o.name}>
              <div>{o.label}</div>
              <div className="api-name">{o.name}</div>
            </li>
          ))}
        </ul>
        {objects && <div className="muted count">{visibleObjects.length} objects</div>}
      </aside>

      <section className="explorer-detail">
        {!explorerObject && <div className="empty-state">Pick an object to see its fields.</div>}
        {explorerObject && describeError && <div className="form-error">{describeError.message}</div>}
        {explorerObject && !describe && !describeError && (
          <div className="empty-state">
            <span className="spinner" /> Loading {explorerObject}…
          </div>
        )}
        {describe && (
          <>
            <div className="explorer-head">
              <div>
                <div className="object-title">{describe.label}</div>
                <div className="api-name">
                  {describe.name} · {describe.fields.length} fields · {describe.childRelationships.length} child relationships
                </div>
              </div>
              <span className="spacer" />
              <input type="search" placeholder="Filter fields…" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} />
              <button onClick={() => void copy(visibleFields.map((f) => f.name).join(', '), `${visibleFields.length} field names`)}>
                Copy names
              </button>
              <button className="primary" onClick={querySelected} title="Write a SELECT with the ticked fields and switch to the Query tab">
                Query selected{selected.size ? ` (${selected.size})` : ''}
              </button>
            </div>

            <div className="explorer-scroll">
              <table className="fields">
                <thead>
                  <tr>
                    <th className="check">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} title="Select all shown fields" />
                    </th>
                    <th>Field</th>
                    <th>Label</th>
                    <th>Type</th>
                    <th>Flags</th>
                    <th>Help text</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFields.map((f) => (
                    <FieldRow
                      key={f.name}
                      field={f}
                      checked={selected.has(f.name)}
                      expanded={expanded === f.name}
                      onToggle={() => toggle(f.name)}
                      onExpand={() => setExpanded(expanded === f.name ? null : f.name)}
                      onCopy={() => void copy(f.name, f.name)}
                      onOpenObject={setExplorerObject}
                    />
                  ))}
                  {visibleFields.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No fields match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              {describe.childRelationships.some((r) => r.relationshipName) && (
                <details className="children">
                  <summary>Child relationships (use in subqueries)</summary>
                  <table className="fields">
                    <thead>
                      <tr>
                        <th>Relationship</th>
                        <th>Child object</th>
                        <th>Field</th>
                      </tr>
                    </thead>
                    <tbody>
                      {describe.childRelationships
                        .filter((r) => r.relationshipName)
                        .map((r) => (
                          <tr key={`${r.relationshipName}-${r.childSObject}`}>
                            <td className="mono" onClick={() => void copy(r.relationshipName!, r.relationshipName!)} title="Click to copy">
                              {r.relationshipName}
                            </td>
                            <td>
                              <button className="link" onClick={() => setExplorerObject(r.childSObject)}>
                                {r.childSObject}
                              </button>
                            </td>
                            <td className="mono">{r.field}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

interface FieldRowProps {
  field: FieldDescribe
  checked: boolean
  expanded: boolean
  onToggle(): void
  onExpand(): void
  onCopy(): void
  onOpenObject(name: string): void
}

function FieldRow({ field: f, checked, expanded, onToggle, onExpand, onCopy, onOpenObject }: FieldRowProps) {
  const hasValues = f.picklistValues.length > 0
  return (
    <Fragment>
      <tr className={checked ? 'checked' : ''}>
        <td className="check">
          <input type="checkbox" checked={checked} onChange={onToggle} />
        </td>
        <td className="mono" onClick={onCopy} title="Click to copy">
          {f.name}
          {f.relationshipName && <div className="api-name">{f.relationshipName}.</div>}
        </td>
        <td>{f.label}</td>
        <td>
          {f.type === 'reference' && f.referenceTo.length ? (
            <>
              Lookup(
              {f.referenceTo.map((r, i) => (
                <Fragment key={r}>
                  {i > 0 && ', '}
                  <button className="link" onClick={() => onOpenObject(r)}>
                    {r}
                  </button>
                </Fragment>
              ))}
              )
            </>
          ) : (
            formatFieldType(f)
          )}
          {hasValues && (
            <button className="link values-toggle" onClick={onExpand}>
              {expanded ? '▾' : '▸'} {f.picklistValues.length} values
            </button>
          )}
        </td>
        <td>
          {fieldFlags(f).map((flag) => (
            <span key={flag} className={`badge badge-${flag.toLowerCase().replace(/\s+/g, '-')}`}>
              {flag}
            </span>
          ))}
        </td>
        <td className="help-text">{f.inlineHelpText ?? ''}</td>
      </tr>
      {expanded && hasValues && (
        <tr className="values-row">
          <td />
          <td colSpan={5}>
            {f.picklistValues.map((v) => (
              <span key={v.value} className={`value ${v.active ? '' : 'inactive'}`} title={v.active ? v.label : `${v.label} (inactive)`}>
                {v.value}
              </span>
            ))}
          </td>
        </tr>
      )}
    </Fragment>
  )
}
