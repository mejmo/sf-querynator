import { isWord, tokenize, type Token } from './tokenizer'

export type Clause =
  | 'SELECT'
  | 'FROM'
  | 'WHERE'
  | 'WITH'
  | 'GROUP BY'
  | 'HAVING'
  | 'ORDER BY'
  | 'LIMIT'
  | 'OFFSET'
  | 'FOR'
  | 'USING SCOPE'

/** How to find the sObject a (sub)query reads from. */
export type ObjectRef =
  | { kind: 'object'; name: string }
  /** Child-relationship subquery, e.g. `(SELECT Id FROM Contacts)` inside an Account query. */
  | { kind: 'child'; parent: ObjectRef; relationshipName: string }

export type CompletionContext =
  | { kind: 'keyword'; clause: Clause | null; partial: string }
  | { kind: 'object'; partial: string }
  | { kind: 'childRelationship'; parent: ObjectRef; partial: string }
  /** `path` holds relationship names already typed before the partial, e.g. ['Owner'] for `Owner.Na`. */
  | { kind: 'field'; from: ObjectRef | null; path: string[]; clause: Clause; partial: string }
  /** `fieldPath` is the field being compared, e.g. ['Account', 'Type'] for `Account.Type = '`. */
  | { kind: 'value'; from: ObjectRef | null; fieldPath: string[]; partial: string; inString: boolean }
  | { kind: 'none' }

/** Words that are never field names (used to tell "after an operand" from "after a keyword"). */
export const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'WITH', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FOR', 'USING', 'SCOPE',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'INCLUDES', 'EXCLUDES', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'TYPEOF', 'WHEN', 'THEN', 'ELSE', 'END', 'ROLLUP', 'CUBE', 'VIEW', 'REFERENCE', 'UPDATE', 'TRACKING', 'VIEWSTAT'
])

const VALUE_OPERATOR_WORDS = ['LIKE', 'IN', 'INCLUDES', 'EXCLUDES']

interface Scope {
  /** Token index of the opening paren; -1 for the root query. */
  open: number
  /** Token index of the closing paren; tokens.length when root or unclosed. */
  close: number
  parent: Scope | null
  startOffset: number
  endOffset: number
}

class Analysis {
  readonly tokens: Token[]
  readonly scopes: Scope[]

  constructor(readonly text: string) {
    this.tokens = tokenize(text)
    this.scopes = this.buildScopes()
  }

  private buildScopes(): Scope[] {
    const root: Scope = { open: -1, close: this.tokens.length, parent: null, startOffset: 0, endOffset: Infinity }
    const scopes = [root]
    const stack: Array<Scope | null> = []
    let current = root
    this.tokens.forEach((t, i) => {
      if (t.type === 'lparen') {
        if (isWord(this.tokens[i + 1], 'SELECT')) {
          const s: Scope = { open: i, close: this.tokens.length, parent: current, startOffset: t.end, endOffset: Infinity }
          scopes.push(s)
          stack.push(s)
          current = s
        } else {
          stack.push(null)
        }
      } else if (t.type === 'rparen') {
        const top = stack.pop()
        if (top) {
          top.close = i
          top.endOffset = t.start
          current = top.parent ?? root
        }
      }
    })
    return scopes
  }

  /** Innermost (sub)query containing the offset. Later scopes are nested deeper, so take the last match. */
  scopeAt(offset: number): Scope {
    let found = this.scopes[0]
    for (const s of this.scopes) {
      if (s.startOffset <= offset && offset <= s.endOffset) found = s
    }
    return found
  }

  /** Tokens belonging to this scope, excluding tokens of nested subqueries. */
  scopeTokens(scope: Scope): Token[] {
    const children = this.scopes.filter((s) => s.parent === scope)
    const result: Token[] = []
    for (let i = scope.open + 1; i < scope.close; i++) {
      const child = children.find((c) => c.open <= i && i <= c.close)
      if (child) {
        i = child.close
        continue
      }
      result.push(this.tokens[i])
    }
    return result
  }

  fromOf(scope: Scope): ObjectRef | null {
    const toks = this.scopeTokens(scope)
    const idx = toks.findIndex((t) => isWord(t, 'FROM'))
    const target = toks[idx + 1]
    if (idx < 0 || !target || target.type !== 'word') return null
    if (!scope.parent) return { kind: 'object', name: target.value }
    if (this.isChildSubquery(scope)) {
      const parent = this.fromOf(scope.parent)
      return parent ? { kind: 'child', parent, relationshipName: target.value } : null
    }
    // Semi-join subquery in WHERE, e.g. `Id IN (SELECT AccountId FROM Contact)`.
    return { kind: 'object', name: target.value }
  }

  /** A subquery in the parent's SELECT list (before the parent's FROM) is a child-relationship subquery. */
  isChildSubquery(scope: Scope): boolean {
    if (!scope.parent) return false
    const parentFrom = this.scopeTokens(scope.parent).find((t) => isWord(t, 'FROM'))
    return !parentFrom || this.tokens[scope.open].start < parentFrom.start
  }
}

function clauseOf(tokens: Token[]): Clause | null {
  let clause: Clause | null = null
  tokens.forEach((t, i) => {
    if (t.type !== 'word') return
    const u = t.value.toUpperCase()
    const next = tokens[i + 1]
    if (u === 'SELECT' || u === 'FROM' || u === 'WHERE' || u === 'WITH' || u === 'HAVING' || u === 'LIMIT' || u === 'OFFSET' || u === 'FOR') {
      clause = u
    } else if ((u === 'GROUP' || u === 'ORDER') && isWord(next, 'BY')) {
      clause = u === 'GROUP' ? 'GROUP BY' : 'ORDER BY'
    } else if (u === 'USING' && isWord(next, 'SCOPE')) {
      clause = 'USING SCOPE'
    }
  })
  return clause
}

/** Tokens that end an operand: after these the user most likely wants an operator or keyword next. */
function isOperandEnd(t: Token | undefined): boolean {
  if (!t) return false
  if (t.type === 'string' || t.type === 'number' || t.type === 'rparen') return true
  return t.type === 'word' && !RESERVED.has(t.value.toUpperCase())
}

/**
 * If the tokens end in "<field> <operator> [value-list items]", return the field path.
 * Handles `=`, `!=`, `LIKE`, `IN (`, `NOT IN (`, `INCLUDES (` and partially typed lists.
 */
function valueFieldPath(prev: Token[]): string[] | null {
  let k = prev.length - 1
  if (prev[k]?.type === 'comma' || prev[k]?.type === 'lparen') {
    // Inside a value list: walk back over "('a', 'b', " to the opening paren.
    while (k >= 0 && ['comma', 'string', 'number'].includes(prev[k].type)) k--
    if (prev[k]?.type !== 'lparen') return null
    k--
    if (!isWord(prev[k], 'IN', 'INCLUDES', 'EXCLUDES')) return null
  }
  if (k < 0) return null
  const op = prev[k]
  if (!(op.type === 'op' || isWord(op, ...VALUE_OPERATOR_WORDS))) return null
  k--
  if (isWord(prev[k], 'NOT')) k--
  const path: string[] = []
  while (k >= 0 && prev[k].type === 'word') {
    path.unshift(prev[k].value)
    if (k > 0 && prev[k - 1].type === 'dot') k -= 2
    else break
  }
  if (path.length === 0 || RESERVED.has(path[0].toUpperCase())) return null
  return path
}

export function getCompletionContext(text: string, offset: number): CompletionContext {
  const a = new Analysis(text)
  const scope = a.scopeAt(offset)
  const scopeToks = a.scopeTokens(scope)
  const from = a.fromOf(scope)

  // Cursor inside a string literal -> value context.
  const str = a.tokens.find((t) => t.type === 'string' && t.start < offset && (offset < t.end || t.unterminated))
  if (str) {
    const fieldPath = valueFieldPath(scopeToks.filter((t) => t.end <= str.start))
    if (!fieldPath) return { kind: 'none' }
    return { kind: 'value', from, fieldPath, partial: text.slice(str.start + 1, offset), inString: true }
  }

  const before = text.slice(0, offset)
  const m = /((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)?$/.exec(before)!
  const path = m[1] ? m[1].slice(0, -1).split('.') : []
  const partial = m[2] ?? ''
  const pathStart = offset - m[0].length
  const prev = scopeToks.filter((t) => t.end <= pathStart)
  const last = prev[prev.length - 1]

  if (last?.type === 'colon') return { kind: 'none' }

  const clause = clauseOf(prev)
  switch (clause) {
    case null:
      return { kind: 'keyword', clause: null, partial }
    case 'FROM':
      if (isWord(last, 'FROM')) {
        if (scope.parent && a.isChildSubquery(scope)) {
          const parent = a.fromOf(scope.parent)
          return parent ? { kind: 'childRelationship', parent, partial } : { kind: 'none' }
        }
        return { kind: 'object', partial }
      }
      return { kind: 'keyword', clause, partial }
    case 'WHERE':
    case 'HAVING': {
      if (path.length === 0) {
        const fieldPath = valueFieldPath(prev)
        if (fieldPath) return { kind: 'value', from, fieldPath, partial, inString: false }
      }
      if (path.length === 0 && isOperandEnd(last)) return { kind: 'keyword', clause, partial }
      return { kind: 'field', from, path, clause, partial }
    }
    case 'SELECT':
    case 'GROUP BY':
    case 'ORDER BY':
      if (path.length === 0 && isOperandEnd(last)) return { kind: 'keyword', clause, partial }
      return { kind: 'field', from, path, clause, partial }
    case 'LIMIT':
    case 'OFFSET':
      return isWord(last, 'LIMIT', 'OFFSET') ? { kind: 'none' } : { kind: 'keyword', clause, partial }
    default:
      return { kind: 'keyword', clause, partial }
  }
}

/** The object of the outermost FROM, or null. Used to pick field metadata for the AI helper. */
export function findRootObject(text: string): string | null {
  const a = new Analysis(text)
  const ref = a.fromOf(a.scopes[0])
  return ref?.kind === 'object' ? ref.name : null
}
