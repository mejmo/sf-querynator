import { useEffect, useRef, useState } from 'react'
import type { AiSuggestion, AppError } from '../../../shared/types'
import { monaco, SOQL, THEME } from '../monaco/setup'
import { useStore } from '../store'
import { Modal } from './Modal'

export function AiFixDialog() {
  const { envId, query, queryError, loadQuery, setAiOpen, setSettingsOpen } = useStore()
  // Snapshot what we asked about, so edits behind the dialog don't change the diff.
  const [original] = useState(query)
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const close = () => setAiOpen(false)

  useEffect(() => {
    if (!envId) return
    let stale = false
    setSuggestion(null)
    setError(null)
    void window.api.fixQuery(envId, original, queryError).then((r) => {
      if (stale) return
      if (r.ok) setSuggestion(r.value)
      else setError(r.error)
    })
    return () => {
      stale = true
    }
  }, [envId, original, queryError, attempt])

  useEffect(() => {
    if (!suggestion || !hostRef.current) return
    const diff = monaco.editor.createDiffEditor(hostRef.current, {
      theme: THEME,
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
      wordWrap: 'on',
      fontSize: 13,
      scrollBeyondLastLine: false
    })
    const models = { original: monaco.editor.createModel(original, SOQL), modified: monaco.editor.createModel(suggestion.query, SOQL) }
    diff.setModel(models)
    diffRef.current = diff
    return () => {
      diff.dispose()
      models.original.dispose()
      models.modified.dispose()
      diffRef.current = null
    }
  }, [suggestion, original])

  const accept = () => {
    // The right-hand side is editable, so take whatever the user left there.
    const text = diffRef.current?.getModifiedEditor().getValue() ?? suggestion?.query
    if (text) loadQuery(text)
    close()
  }

  return (
    <Modal
      title="✨ Fix with AI"
      className="aidialog"
      onClose={close}
      footer={
        <>
          {error && <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
          <button onClick={close}>Reject</button>
          <button className="primary" onClick={accept} disabled={!suggestion}>
            Accept
          </button>
        </>
      }
    >
      {!suggestion && !error && (
        <div className="muted">
          <span className="spinner" /> Asking OpenAI{queryError ? ' about the error' : ''}…
        </div>
      )}
      {error && (
        <div className="form-error">
          {error.message}
          {error.kind === 'config' && (
            <>
              {' '}
              <button
                className="link"
                onClick={() => {
                  close()
                  setSettingsOpen(true)
                }}
              >
                Open Settings
              </button>
            </>
          )}
        </div>
      )}
      {suggestion && (
        <>
          <div className="explanation">{suggestion.explanation || 'Suggested query:'}</div>
          <div className="diff-host" ref={hostRef} />
        </>
      )}
    </Modal>
  )
}
