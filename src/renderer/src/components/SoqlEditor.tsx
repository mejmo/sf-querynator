import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { toggleLineComments } from '../../../soql/comments'
import { errorDetail, parseErrorPosition } from '../../../soql/format'
import { monaco, SOQL, THEME } from '../monaco/setup'

export interface SoqlEditorHandle {
  format(): void
  focus(): void
}

interface Props {
  value: string
  onChange(value: string): void
  onRun(): void
  /** Salesforce error text; a "Row:x:Column:y" position becomes an error marker. */
  error: string | null
}

/** Ctrl+/: comment or uncomment every line touched by the selection(s), always at column 1. */
function toggleCommentsOnSelection(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel()
  const selections = editor.getSelections()
  if (!model || !selections?.length) return
  // Line ranges per selection; a selection ending at column 1 doesn't include that last line. Overlaps are merged.
  const ranges = selections
    .map((sel) => {
      const end = sel.endLineNumber > sel.startLineNumber && sel.endColumn === 1 ? sel.endLineNumber - 1 : sel.endLineNumber
      return [sel.startLineNumber, end] as [number, number]
    })
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((merged, r) => {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else merged.push([...r])
      return merged
    }, [])
  const edits = ranges.map(([start, end]) => {
    const lines = Array.from({ length: end - start + 1 }, (_, i) => model.getLineContent(start + i))
    return { range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)), text: toggleLineComments(lines).join(model.getEOL()) }
  })
  editor.pushUndoStop()
  editor.executeEdits('toggle-line-comment', edits, () =>
    ranges.map(([start, end]) => new monaco.Selection(start, 1, end, model.getLineMaxColumn(end)))
  )
  editor.pushUndoStop()
}

export const SoqlEditor = forwardRef<SoqlEditorHandle, Props>(function SoqlEditor({ value, onChange, onRun, error }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Latest callbacks without re-creating the editor.
  const callbacks = useRef({ onChange, onRun })
  callbacks.current = { onChange, onRun }

  useEffect(() => {
    const editor = monaco.editor.create(hostRef.current!, {
      value,
      language: SOQL,
      theme: THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace",
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordBasedSuggestions: 'off',
      quickSuggestions: { other: true, strings: true, comments: false },
      suggest: { showWords: false },
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    editor.onDidChangeModelContent(() => callbacks.current.onChange(editor.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => callbacks.current.onRun())
    editor.addAction({
      id: 'querynator.toggleLineComment',
      label: 'Toggle Line Comment',
      // Numpad "/" too: on many non-US layouts "/" isn't on the key Ctrl+/ maps to.
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, monaco.KeyMod.CtrlCmd | monaco.KeyCode.NumpadDivide],
      contextMenuGroupId: '1_modification',
      run: toggleCommentsOnSelection
    })
    editor.focus()
    return () => {
      editor.getModel()?.dispose()
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  // External changes (history click, AI accept) replace the text as an undoable edit.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || model.getValue() === value) return
    editor.pushUndoStop()
    editor.executeEdits('external', [{ range: model.getFullModelRange(), text: value }])
    editor.pushUndoStop()
  }, [value])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const pos = error ? parseErrorPosition(error) : null
    if (!pos || pos.line > model.getLineCount()) {
      monaco.editor.setModelMarkers(model, 'salesforce', [])
      return
    }
    const column = Math.min(pos.column, model.getLineMaxColumn(pos.line))
    const word = model.getWordAtPosition({ lineNumber: pos.line, column })
    monaco.editor.setModelMarkers(model, 'salesforce', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: errorDetail(error!),
        startLineNumber: pos.line,
        startColumn: word?.startColumn ?? column,
        endLineNumber: pos.line,
        endColumn: word?.endColumn ?? column + 1
      }
    ])
  }, [error])

  useImperativeHandle(ref, () => ({
    format: () => void editorRef.current?.getAction('editor.action.formatDocument')?.run(),
    focus: () => editorRef.current?.focus()
  }))

  return <div className="editor-host" ref={hostRef} />
})
