import { describe, expect, it } from 'vitest'
import { getCompletions, type Suggestion } from '../../src/soql/completions'
import { getCompletionContext } from '../../src/soql/context'
import { fakeMetadata } from './fixtures'

async function complete(withCursor: string, md = fakeMetadata()): Promise<Suggestion[]> {
  const offset = withCursor.indexOf('|')
  return getCompletions(getCompletionContext(withCursor.replace('|', ''), offset), md)
}
const labels = (s: Suggestion[]) => s.map((x) => x.label)

describe('getCompletions', () => {
  it('starts with SELECT', async () => {
    expect(labels(await complete('|'))).toEqual(['SELECT'])
  })

  it('lists queryable objects after FROM', async () => {
    const result = await complete('SELECT Id FROM |')
    expect(labels(result)).toEqual(['Account', 'Contact', 'User'])
    expect(result[0]).toMatchObject({ kind: 'object', detail: 'Account' })
  })

  it('lists fields, relationships, functions and FROM in the SELECT list', async () => {
    const result = await complete('SELECT | FROM Account')
    const l = labels(result)
    expect(l).toEqual(expect.arrayContaining(['Id', 'Name', 'Type', 'OwnerId', 'Owner.', 'FROM', 'COUNT()']))
    expect(result.find((s) => s.label === 'Owner.')).toMatchObject({ insertText: 'Owner', kind: 'relationship', detail: '→ User' })
    expect(result.find((s) => s.label === 'Name')).toMatchObject({ kind: 'field', detail: 'string · Name' })
  })

  it('follows relationship paths', async () => {
    expect(labels(await complete('SELECT Owner.| FROM Account'))).toEqual(['Id', 'Email', 'ManagerId', 'Manager.'])
    expect(labels(await complete('SELECT Owner.Manager.Em| FROM Account'))).toContain('Email')
  })

  it('returns nothing for unknown relationships', async () => {
    expect(await complete('SELECT Nope.| FROM Account')).toEqual([])
  })

  it('resolves child relationship subqueries', async () => {
    expect(labels(await complete('SELECT Id, (SELECT | FROM Contacts) FROM Account'))).toContain('LastName')
    expect(labels(await complete('SELECT Id, (SELECT Id FROM |) FROM Account'))).toEqual(['Contacts'])
  })

  it('suggests active picklist values, quoted outside strings', async () => {
    const bare = await complete('SELECT Id FROM Account WHERE Type = |')
    expect(bare.filter((s) => s.kind === 'value').map((s) => s.insertText)).toEqual(["'Customer'", "'Partner'"])
    expect(labels(bare)).toContain('NULL')
    const quoted = await complete("SELECT Id FROM Account WHERE Type IN ('Customer', '|")
    expect(quoted.map((s) => s.insertText)).toEqual(['Customer', 'Partner'])
  })

  it('suggests date literals for date fields', async () => {
    const result = await complete('SELECT Id FROM Account WHERE CreatedDate > |')
    expect(labels(result)).toEqual(expect.arrayContaining(['TODAY', 'THIS_MONTH', 'LAST_N_DAYS:n', 'NULL']))
    expect(result.find((s) => s.label === 'LAST_N_DAYS:n')).toMatchObject({ insertText: 'LAST_N_DAYS:${1:7}', snippet: true })
  })

  it('suggests TRUE/FALSE for booleans', async () => {
    expect(labels(await complete('SELECT Id FROM Account WHERE IsDeleted = |'))).toEqual(['TRUE', 'FALSE', 'NULL'])
  })

  it('suggests clause keywords', async () => {
    expect(labels(await complete('SELECT Id FROM Account |'))).toContain('WHERE')
    expect(labels(await complete('SELECT Id FROM Account ORDER BY Name |'))).toEqual(
      expect.arrayContaining(['ASC', 'DESC', 'NULLS LAST', 'LIMIT'])
    )
  })

  it('degrades to keywords when metadata is missing', async () => {
    const empty = fakeMetadata([])
    expect(labels(await complete('SELECT | FROM Account', empty))).toContain('FROM')
    expect(labels(await complete('SELECT Id FROM Account WHERE Type = |', empty))).toEqual(['NULL'])
  })
})
