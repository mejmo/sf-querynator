import { describe, expect, it } from 'vitest'
import { findRootObject, getCompletionContext } from '../../src/soql/context'

/** `|` marks the cursor. */
function ctx(withCursor: string) {
  const offset = withCursor.indexOf('|')
  return getCompletionContext(withCursor.replace('|', ''), offset)
}

const account = { kind: 'object', name: 'Account' } as const

describe('getCompletionContext', () => {
  it.each([
    ['|', { kind: 'keyword', clause: null, partial: '' }],
    ['SEL|', { kind: 'keyword', clause: null, partial: 'SEL' }],
    ['SELECT Id FROM |', { kind: 'object', partial: '' }],
    ['SELECT Id FROM Acc|', { kind: 'object', partial: 'Acc' }],
    ['SELECT Id FROM Account |', { kind: 'keyword', clause: 'FROM', partial: '' }],
    ['SELECT Id FROM Account WH|', { kind: 'keyword', clause: 'FROM', partial: 'WH' }],
    ['SELECT Id FROM Account LIMIT |', { kind: 'none' }],
    ['SELECT Id FROM Account LIMIT 5 |', { kind: 'keyword', clause: 'LIMIT', partial: '' }]
  ])('%s', (input, expected) => {
    expect(ctx(input)).toEqual(expected)
  })

  describe('SELECT list', () => {
    it('suggests fields of the FROM object that appears later in the text', () => {
      expect(ctx('SELECT | FROM Account')).toEqual({ kind: 'field', from: account, path: [], clause: 'SELECT', partial: '' })
    })
    it('after a comma', () => {
      expect(ctx('SELECT Id, Na| FROM Account')).toEqual({ kind: 'field', from: account, path: [], clause: 'SELECT', partial: 'Na' })
    })
    it('offers keywords after a complete field', () => {
      expect(ctx('SELECT Id |')).toEqual({ kind: 'keyword', clause: 'SELECT', partial: '' })
    })
    it('works without a FROM yet', () => {
      expect(ctx('SELECT Id, |')).toEqual({ kind: 'field', from: null, path: [], clause: 'SELECT', partial: '' })
    })
    it('walks relationship paths', () => {
      expect(ctx('SELECT Owner.Manager.Na| FROM Account')).toEqual({
        kind: 'field',
        from: account,
        path: ['Owner', 'Manager'],
        clause: 'SELECT',
        partial: 'Na'
      })
    })
    it('right after a dot', () => {
      expect(ctx('SELECT Owner.| FROM Account')).toMatchObject({ kind: 'field', path: ['Owner'], partial: '' })
    })
    it('inside an aggregate function', () => {
      expect(ctx('SELECT COUNT(|) FROM Account')).toMatchObject({ kind: 'field', from: account, path: [] })
    })
    it('is case-insensitive for keywords', () => {
      expect(ctx('select | from account')).toMatchObject({ kind: 'field', from: { kind: 'object', name: 'account' } })
    })
  })

  describe('subqueries', () => {
    it('child relationship subquery resolves via the parent', () => {
      expect(ctx('SELECT Id, (SELECT | FROM Contacts) FROM Account')).toEqual({
        kind: 'field',
        from: { kind: 'child', parent: account, relationshipName: 'Contacts' },
        path: [],
        clause: 'SELECT',
        partial: ''
      })
    })
    it('suggests child relationship names after FROM in a child subquery', () => {
      expect(ctx('SELECT Id, (SELECT Id FROM Con|) FROM Account')).toEqual({
        kind: 'childRelationship',
        parent: account,
        partial: 'Con'
      })
    })
    it('child subquery without a known parent object has no source', () => {
      expect(ctx('SELECT Id, (SELECT Id FROM |')).toEqual({ kind: 'none' })
      expect(ctx('SELECT Id, (SELECT | FROM Contacts')).toMatchObject({ kind: 'field', from: null })
    })
    it('semi-join subquery in WHERE uses its own object', () => {
      expect(ctx('SELECT Id FROM Account WHERE Id IN (SELECT | FROM Contact)')).toMatchObject({
        kind: 'field',
        from: { kind: 'object', name: 'Contact' }
      })
      expect(ctx('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM |)')).toEqual({ kind: 'object', partial: '' })
    })
    it('back in the outer query after a subquery', () => {
      expect(ctx('SELECT Id, (SELECT Id FROM Contacts), | FROM Account')).toMatchObject({ kind: 'field', from: account })
      expect(ctx('SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE |')).toMatchObject({
        kind: 'field',
        from: account,
        clause: 'WHERE'
      })
    })
  })

  describe('WHERE', () => {
    it('suggests fields at the start of a condition', () => {
      expect(ctx('SELECT Id FROM Account WHERE |')).toEqual({ kind: 'field', from: account, path: [], clause: 'WHERE', partial: '' })
      expect(ctx("SELECT Id FROM Account WHERE Name = 'x' AND Ty|")).toMatchObject({ kind: 'field', partial: 'Ty' })
      expect(ctx('SELECT Id FROM Account WHERE (|')).toMatchObject({ kind: 'field' })
    })
    it('suggests operators/keywords after a field', () => {
      expect(ctx('SELECT Id FROM Account WHERE Name |')).toEqual({ kind: 'keyword', clause: 'WHERE', partial: '' })
      expect(ctx("SELECT Id FROM Account WHERE Name = 'x' |")).toEqual({ kind: 'keyword', clause: 'WHERE', partial: '' })
    })
    it('value after an operator', () => {
      expect(ctx('SELECT Id FROM Account WHERE Type = |')).toEqual({
        kind: 'value',
        from: account,
        fieldPath: ['Type'],
        partial: '',
        inString: false
      })
      expect(ctx('SELECT Id FROM Account WHERE CreatedDate >= LAST|')).toMatchObject({
        kind: 'value',
        fieldPath: ['CreatedDate'],
        partial: 'LAST'
      })
    })
    it('value inside a string literal', () => {
      expect(ctx("SELECT Id FROM Account WHERE Owner.Type__c = 'Cus|")).toEqual({
        kind: 'value',
        from: account,
        fieldPath: ['Owner', 'Type__c'],
        partial: 'Cus',
        inString: true
      })
      expect(ctx("SELECT Id FROM Account WHERE Type LIKE '|'")).toMatchObject({ kind: 'value', fieldPath: ['Type'], partial: '' })
    })
    it('value lists with IN / NOT IN / INCLUDES', () => {
      expect(ctx("SELECT Id FROM Account WHERE Type IN ('A', '|")).toMatchObject({ kind: 'value', fieldPath: ['Type'], inString: true })
      expect(ctx('SELECT Id FROM Account WHERE Type NOT IN (|')).toMatchObject({ kind: 'value', fieldPath: ['Type'] })
      expect(ctx("SELECT Id FROM Account WHERE Tags__c INCLUDES ('a', |")).toMatchObject({ kind: 'value', fieldPath: ['Tags__c'] })
    })
    it('nothing to suggest after an N-literal colon', () => {
      expect(ctx('SELECT Id FROM Account WHERE CreatedDate = LAST_N_DAYS:|')).toEqual({ kind: 'none' })
    })
  })

  describe('GROUP BY / ORDER BY', () => {
    it('fields after BY, keywords after a field', () => {
      expect(ctx('SELECT Id FROM Account ORDER BY |')).toMatchObject({ kind: 'field', clause: 'ORDER BY', from: account })
      expect(ctx('SELECT Id FROM Account ORDER BY Name |')).toEqual({ kind: 'keyword', clause: 'ORDER BY', partial: '' })
      expect(ctx('SELECT Type FROM Account GROUP BY Ty|')).toMatchObject({ kind: 'field', clause: 'GROUP BY', partial: 'Ty' })
    })
  })
})

describe('findRootObject', () => {
  it('returns the outer FROM object', () => {
    expect(findRootObject('SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Case)')).toBe('Account')
    expect(findRootObject('SELECT Id')).toBeNull()
  })
})
