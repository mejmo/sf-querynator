import { useEffect, useRef } from 'react'
import { AiFixDialog } from './components/AiFixDialog'
import { EnvironmentBar } from './components/EnvironmentBar'
import { ErrorBanner } from './components/ErrorBanner'
import { HistoryPanel } from './components/HistoryPanel'
import { ObjectExplorer } from './components/ObjectExplorer'
import { ResultsGrid } from './components/ResultsGrid'
import { SettingsDialog } from './components/SettingsDialog'
import { SoqlEditor, type SoqlEditorHandle } from './components/SoqlEditor'
import { Splitter, useEditorHeight } from './components/Splitter'
import { UserCard } from './components/UserCard'
import { createMetadataSource, setActiveMetadata } from './metadata'
import { setFormatErrorHandler } from './monaco/setup'
import { useStore } from './store'

export function App() {
  const s = useStore()
  const editorRef = useRef<SoqlEditorHandle>(null)
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const queryPanelRef = useRef<HTMLDivElement>(null)
  const [editorHeight, setEditorHeight] = useEditorHeight()
  const connected = s.status === 'connected'
  const hasAiKey = !!s.settings?.hasOpenAiKey

  useEffect(() => {
    void useStore.getState().init()
    setFormatErrorHandler((message) => {
      useStore.getState().setQueryError(message)
      useStore.getState().notify(`Can't beautify: ${message}`)
    })
  }, [])

  // Autocomplete metadata follows the active, connected environment.
  useEffect(() => {
    if (!s.envId || !connected) {
      setActiveMetadata(null)
      return
    }
    const source = createMetadataSource(s.envId)
    setActiveMetadata(source)
    void source.getGlobal() // warm up object names in the background
  }, [s.envId, connected, s.metadataVersion])

  const openAi = () => {
    if (!hasAiKey) {
      s.notify('Add your OpenAI API key in Settings first.')
      s.setSettingsOpen(true)
      return
    }
    s.setAiOpen(true)
  }

  return (
    <div className="app">
      <EnvironmentBar />
      <div className="layout">
        <aside className="sidebar">
          <UserCard />
          <HistoryPanel />
        </aside>
        <main className="workspace">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={s.tab === 'query'} className={s.tab === 'query' ? 'active' : ''} onClick={() => s.setTab('query')}>
              Query
            </button>
            <button role="tab" aria-selected={s.tab === 'objects'} className={s.tab === 'objects' ? 'active' : ''} onClick={() => s.setTab('objects')}>
              Objects
            </button>
          </div>
          {/* Both panels stay mounted so the editor keeps its state and undo history. */}
          <div className="tab-panel" hidden={s.tab !== 'objects'}>
            <ObjectExplorer active={s.tab === 'objects'} />
          </div>
          <div className="tab-panel" hidden={s.tab !== 'query'} ref={queryPanelRef}>
          <div className="editor-wrap" ref={editorWrapRef} style={{ height: editorHeight }}>
            <SoqlEditor ref={editorRef} value={s.query} onChange={s.setQuery} onRun={() => void useStore.getState().run()} error={s.queryError} />
          </div>
          <Splitter target={editorWrapRef} container={queryPanelRef} onResize={setEditorHeight} />
          <div className="toolbar">
            {s.running ? (
              <button onClick={() => void s.cancel()}>
                <span className="spinner" /> Cancel
              </button>
            ) : (
              <button className="primary" onClick={() => void s.run()} disabled={!connected} title={connected ? 'Run (Ctrl+Enter)' : 'Log in first'}>
                ▶ Run
              </button>
            )}
            <button onClick={() => editorRef.current?.format()} title="Beautify (Shift+Alt+F)">
              ⇶ Beautify
            </button>
            <button onClick={openAi} disabled={!s.envId} title={hasAiKey ? 'Ask OpenAI to fix this query' : 'Set your OpenAI API key in Settings'}>
              ✨ Fix with AI
            </button>
            <label title="Include deleted and archived records">
              <input type="checkbox" checked={s.queryAll} onChange={(e) => s.setQueryAll(e.target.checked)} /> queryAll
            </label>
            <span className="hint">Ctrl+Enter to run · Ctrl+Space for suggestions</span>
          </div>
          <ErrorBanner onFixWithAi={openAi} />
          <ResultsGrid />
          </div>
        </main>
      </div>
      {s.settingsOpen && <SettingsDialog />}
      {s.aiOpen && <AiFixDialog />}
      {s.notice && <div className="toast">{s.notice}</div>}
    </div>
  )
}
