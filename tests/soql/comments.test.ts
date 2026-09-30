import { describe, expect, it } from 'vitest'
import { isCommentLine, maskLineComments, splitLineComments, withComments } from '../../src/soql/comments'
import { getCompletionContext } from '../../src/soql/context'
import { beautify } from '../../src/soql/format'

const text = '// all accounts\nSELECT Id\n// , Name\nFROM Account'

describe('line comments', () => {
  it('only counts // as the first two characters', () => {
    expect(isCommentLine('// x')).toBe(true)
    expect(isCommentLine('//x')).toBe(true)
    expect(isCommentLine('  // x')).toBe(false)
    expect(isCommentLine("SELECT Id FROM Account WHERE Name = '//'")).toBe(false)
  })

  it('masks comment lines keeping every offset and row', () => {
    const masked = maskLineComments(text)
    expect(masked).toBe('               \nSELECT Id\n         \nFROM Account')
    expect(masked.length).toBe(text.length)
    expect(masked.split('\n')).toHaveLength(4)
  })

  it('splits comments from the query and puts them back on top', () => {
    const { comments, body } = splitLineComments(text)
    expect(comments).toEqual(['// all accounts', '// , Name'])
    expect(body).toBe('SELECT Id\nFROM Account')
    expect(withComments(comments, 'Q')).toBe('// all accounts\n// , Name\nQ')
    expect(withComments([], 'Q')).toBe('Q')
  })

  it('beautify keeps comments above the formatted query', () => {
    expect(beautify(text)).toEqual({ ok: true, text: '// all accounts\n// , Name\nSELECT Id\nFROM Account' })
    expect(beautify('// only a note')).toEqual({ ok: true, text: '// only a note' })
  })

  it('comment text does not affect autocomplete context', () => {
    const q = 'SELECT | FROM Account\n// FROM Contact'
    const offset = q.indexOf('|')
    const ctx = getCompletionContext(maskLineComments(q.replace('|', '')), offset)
    expect(ctx).toMatchObject({ kind: 'field', from: { kind: 'object', name: 'Account' } })
  })
})
