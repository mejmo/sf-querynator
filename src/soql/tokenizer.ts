export type TokenType = 'word' | 'string' | 'number' | 'op' | 'lparen' | 'rparen' | 'comma' | 'dot' | 'colon' | 'other'

export interface Token {
  type: TokenType
  value: string
  start: number
  end: number
  /** Set on a string literal that is still open at end of input. */
  unterminated?: boolean
}

const TWO_CHAR_OPS = ['<=', '>=', '!=', '<>']
const ONE_CHAR_OPS = ['=', '<', '>']
const PUNCT: Record<string, TokenType> = { '(': 'lparen', ')': 'rparen', ',': 'comma', '.': 'dot', ':': 'colon' }

/** Tolerant tokenizer: never throws, works on half-typed queries. Whitespace is skipped. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "'") {
      let j = i + 1
      let closed = false
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === "'") {
          closed = true
          j++
          break
        }
        j++
      }
      j = Math.min(j, text.length)
      const token: Token = { type: 'string', value: text.slice(i, j), start: i, end: j }
      if (!closed) token.unterminated = true
      tokens.push(token)
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < text.length && /\w/.test(text[j])) j++
      tokens.push({ type: 'word', value: text.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      // Covers integers, decimals and date/datetime literals like 2024-01-31T00:00:00Z.
      let j = i + 1
      while (j < text.length && /[\w\-:.+]/.test(text[j])) j++
      tokens.push({ type: 'number', value: text.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    const two = text.slice(i, i + 2)
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch, start: i, end: i + 1 })
      i++
      continue
    }
    tokens.push({ type: PUNCT[ch] ?? 'other', value: ch, start: i, end: i + 1 })
    i++
  }
  return tokens
}

export function isWord(token: Token | undefined, ...words: string[]): boolean {
  if (!token || token.type !== 'word') return false
  const upper = token.value.toUpperCase()
  return words.length === 0 || words.includes(upper)
}
