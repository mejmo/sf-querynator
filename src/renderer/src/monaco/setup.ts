import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DATE_LITERALS, DATE_N_LITERALS, getCompletions, type SuggestionKind } from '../../../soql/completions'
import { getCompletionContext } from '../../../soql/context'
import { beautify } from '../../../soql/format'
import { getActiveMetadata } from '../metadata'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export const SOQL = 'soql'
export const THEME = 'querynator-dark'

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'WITH', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FOR', 'VIEW', 'REFERENCE', 'UPDATE',
  'USING', 'SCOPE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'INCLUDES', 'EXCLUDES', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'NULL', 'TRUE', 'FALSE', 'TYPEOF', 'WHEN', 'THEN', 'ELSE', 'END', 'ROLLUP', 'CUBE', 'SECURITY_ENFORCED', 'USER_MODE',
  'SYSTEM_MODE', 'TRACKING', 'VIEWSTAT', 'ALL', 'ROWS'
]
const FUNCTIONS = [
  'COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'FORMAT', 'TOLABEL', 'CONVERTCURRENCY', 'CALENDAR_MONTH',
  'CALENDAR_QUARTER', 'CALENDAR_YEAR', 'DAY_IN_MONTH', 'DAY_IN_WEEK', 'DAY_IN_YEAR', 'DAY_ONLY', 'FISCAL_MONTH',
  'FISCAL_QUARTER', 'FISCAL_YEAR', 'HOUR_IN_DAY', 'WEEK_IN_MONTH', 'WEEK_IN_YEAR', 'GROUPING', 'FIELDS', 'DISTANCE', 'GEOLOCATION'
]

monaco.languages.register({ id: SOQL })

monaco.languages.setLanguageConfiguration(SOQL, {
  brackets: [['(', ')']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'", notIn: ['string'] }
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" }
  ],
  wordPattern: /[A-Za-z_][\w]*/
})

monaco.languages.setMonarchTokensProvider(SOQL, {
  ignoreCase: true,
  keywords: KEYWORDS,
  functions: FUNCTIONS,
  dateLiterals: [...DATE_LITERALS, ...DATE_N_LITERALS],
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/'/, 'string', '@string'],
      [/:[A-Za-z_]\w*/, 'variable'],
      [/\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?/, 'number.date'],
      [/\d+(\.\d+)?/, 'number'],
      [/[A-Za-z_]\w*(?=\s*\()/, { cases: { '@functions': 'predefined', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@dateLiterals': 'constant', '@default': 'identifier' } }],
      [/[=<>!]+/, 'operator'],
      [/[(),.:]/, 'delimiter']
    ],
    string: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop']
    ]
  }
} as monaco.languages.IMonarchLanguage)

monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'A67CF5', fontStyle: 'bold' },
    { token: 'predefined', foreground: '4EA6F7' },
    { token: 'constant', foreground: '5CC8FF' },
    { token: 'variable', foreground: '9CDCFE', fontStyle: 'italic' },
    { token: 'string', foreground: 'F0A987' },
    { token: 'number', foreground: '8FD6B4' },
    { token: 'number.date', foreground: '8FD6B4' },
    { token: 'operator', foreground: 'C9AEFB' },
    { token: 'identifier', foreground: 'E6E2F0' }
  ],
  colors: {
    'editor.background': '#17151F',
    'editor.foreground': '#E6E2F0',
    'editor.lineHighlightBackground': '#221E30',
    'editor.selectionBackground': '#3A2A66',
    'editor.inactiveSelectionBackground': '#2E2448',
    'editorCursor.foreground': '#A67CF5',
    'editorLineNumber.foreground': '#5A5470',
    'editorLineNumber.activeForeground': '#C9AEFB',
    'editorBracketMatch.background': '#3A2A6680',
    'editorBracketMatch.border': '#8346EC',
    'editorWidget.background': '#1E1B29',
    'editorWidget.border': '#383149',
    'editorSuggestWidget.background': '#1E1B29',
    'editorSuggestWidget.border': '#383149',
    'editorSuggestWidget.selectedBackground': '#3A2A66',
    'editorSuggestWidget.highlightForeground': '#4EA6F7',
    'editorHoverWidget.background': '#1E1B29',
    'editorHoverWidget.border': '#383149',
    'list.hoverBackground': '#312B45',
    'focusBorder': '#8346EC',
    'scrollbarSlider.background': '#8346EC33',
    'scrollbarSlider.hoverBackground': '#8346EC55',
    'scrollbarSlider.activeBackground': '#8346EC77',
    'diffEditor.insertedTextBackground': '#0981E833',
    'diffEditor.removedTextBackground': '#F5556A33'
  }
})

const KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  object: monaco.languages.CompletionItemKind.Class,
  field: monaco.languages.CompletionItemKind.Field,
  relationship: monaco.languages.CompletionItemKind.Reference,
  value: monaco.languages.CompletionItemKind.EnumMember,
  function: monaco.languages.CompletionItemKind.Function
}

monaco.languages.registerCompletionItemProvider(SOQL, {
  triggerCharacters: ['.', ' ', "'", ',', '('],
  async provideCompletionItems(model, position) {
    const offset = model.getOffsetAt(position)
    const ctx = getCompletionContext(model.getValue(), offset)
    const suggestions = await getCompletions(ctx, getActiveMetadata())
    const partialLength = 'partial' in ctx ? ctx.partial.length : 0
    const start = model.getPositionAt(offset - partialLength)
    const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column)
    return {
      suggestions: suggestions.map((s, i) => {
        // "Owner." inserts the dot and immediately opens the next level.
        const drillDown = s.kind === 'relationship' && s.label.endsWith('.')
        return {
          label: { label: s.label, description: s.detail },
          kind: KIND[s.kind],
          insertText: drillDown ? s.label : s.insertText,
          insertTextRules: s.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          filterText: s.label,
          sortText: String(i).padStart(5, '0'),
          range,
          command: drillDown ? { id: 'editor.action.triggerSuggest', title: 'Suggest' } : undefined
        }
      })
    }
  }
})

let onFormatError: (message: string) => void = () => undefined

export function setFormatErrorHandler(fn: (message: string) => void) {
  onFormatError = fn
}

monaco.languages.registerDocumentFormattingEditProvider(SOQL, {
  provideDocumentFormattingEdits(model) {
    const r = beautify(model.getValue())
    if (!r.ok) {
      onFormatError(r.error)
      return []
    }
    return [{ range: model.getFullModelRange(), text: r.text }]
  }
})

export { monaco }
