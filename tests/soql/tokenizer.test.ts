import { describe, expect, it } from 'vitest'
import { isWord, tokenize } from '../../src/soql/tokenizer'

const brief = (text: string) => tokenize(text).map((t) => `${t.type}:${t.value}`)

describe('tokenize', () => {
  it('splits a simple query', () => {
    expect(brief("SELECT Id, Owner.Name FROM Account WHERE Name != 'x'")).toEqual([
      'word:SELECT',
      'word:Id',
      'comma:,',
      'word:Owner',
      'dot:.',
      'word:Name',
      'word:FROM',
      'word:Account',
      'word:WHERE',
      'word:Name',
      'op:!=',
      "string:'x'"
    ])
  })

  it('records offsets', () => {
    const [select, id] = tokenize('SELECT  Id')
    expect(select).toMatchObject({ start: 0, end: 6 })
    expect(id).toMatchObject({ start: 8, end: 10 })
  })

  it('handles escaped quotes inside strings', () => {
    expect(brief("Name = 'O\\'Brien' AND")).toEqual(['word:Name', 'op:=', "string:'O\\'Brien'", 'word:AND'])
  })

  it('marks an unterminated string', () => {
    const tokens = tokenize("Status = 'Ope")
    expect(tokens[2]).toMatchObject({ type: 'string', value: "'Ope", unterminated: true, end: 13 })
  })

  it('keeps date literals and N-literals intact', () => {
    expect(brief('CreatedDate > 2024-01-31T00:00:00Z OR X = LAST_N_DAYS:30')).toEqual([
      'word:CreatedDate',
      'op:>',
      'number:2024-01-31T00:00:00Z',
      'word:OR',
      'word:X',
      'op:=',
      'word:LAST_N_DAYS',
      'colon::',
      'number:30'
    ])
  })

  it('recognises parens and all operators', () => {
    expect(brief('(a<=1)>=<>=<>')).toEqual([
      'lparen:(',
      'word:a',
      'op:<=',
      'number:1',
      'rparen:)',
      'op:>=',
      'op:<>',
      'op:=',
      'op:<>'
    ])
  })
})

describe('isWord', () => {
  it('matches case-insensitively', () => {
    const [t] = tokenize('from')
    expect(isWord(t, 'FROM')).toBe(true)
    expect(isWord(t, 'WHERE')).toBe(false)
    expect(isWord(t)).toBe(true)
    expect(isWord(undefined, 'FROM')).toBe(false)
  })
})
