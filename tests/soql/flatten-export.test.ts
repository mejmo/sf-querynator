import { describe, expect, it } from 'vitest'
import { flattenRecords } from '../../src/soql/flatten'
import { toCsv, toJson, toTsv } from '../../src/soql/export'
import { beautify, beautifyOrKeep, errorDetail, parseErrorPosition } from '../../src/soql/format'

const records = [
  {
    attributes: { type: 'Account', url: '/a/1' },
    Id: '001A',
    Name: 'Acme, "Inc"',
    Owner: { attributes: { type: 'User' }, Name: 'Jane', Manager: { attributes: { type: 'User' }, Name: 'Boss' } },
    Contacts: { totalSize: 1, done: true, records: [{ attributes: { type: 'Contact' }, LastName: 'Doe' }] },
    BillingAddress: { city: 'Prague' },
    Employees: 10,
    IsActive: true
  },
  {
    attributes: { type: 'Account', url: '/a/2' },
    Id: '001B',
    Name: 'Line\nBreak',
    Owner: null,
    Contacts: null,
    BillingAddress: null,
    Employees: null,
    IsActive: false
  }
]

describe('flattenRecords', () => {
  it('flattens relationships, keeps subqueries and drops null-parent columns', () => {
    const t = flattenRecords(records)
    expect(t.columns).toEqual(['Id', 'Name', 'Owner.Name', 'Owner.Manager.Name', 'Contacts', 'BillingAddress', 'Employees', 'IsActive'])
    expect(t.rows[0]['Owner.Manager.Name']).toBe('Boss')
    expect(t.rows[0].Contacts).toEqual({ subquery: [{ attributes: { type: 'Contact' }, LastName: 'Doe' }], totalSize: 1 })
    expect(t.rows[0].BillingAddress).toBe('{"city":"Prague"}')
    expect(t.rows[1]['Owner.Name']).toBeUndefined()
    expect(t.rows[1].Contacts).toBeNull()
  })

  it('handles empty input', () => {
    expect(flattenRecords([])).toEqual({ columns: [], rows: [] })
  })
})

describe('export', () => {
  const t = flattenRecords(records)

  it('writes RFC 4180 CSV', () => {
    const lines = toCsv(t).split('\r\n')
    expect(lines[0]).toBe('Id,Name,Owner.Name,Owner.Manager.Name,Contacts,BillingAddress,Employees,IsActive')
    expect(lines[1]).toBe('001A,"Acme, ""Inc""",Jane,Boss,"[{""LastName"":""Doe""}]","{""city"":""Prague""}",10,true')
    expect(toCsv(t)).toContain('001B,"Line\nBreak",,,,,,false')
  })

  it('writes TSV without embedded newlines', () => {
    expect(toTsv(t).split('\n')[2]).toBe('001B\tLine Break\t\t\t\t\t\tfalse')
  })

  it('writes JSON without attributes', () => {
    const parsed = JSON.parse(toJson(records))
    expect(parsed[0].Owner).toEqual({ Name: 'Jane', Manager: { Name: 'Boss' } })
    expect(parsed[0].attributes).toBeUndefined()
    expect(parsed[0].Contacts.records[0]).toEqual({ LastName: 'Doe' })
  })
})

describe('beautify', () => {
  it('formats valid SOQL', () => {
    expect(beautify("select Id, Name from Account where Name = 'x'")).toEqual({
      ok: true,
      text: "SELECT Id, Name\nFROM Account\nWHERE Name = 'x'"
    })
  })
  it('reports parse errors', () => {
    const r = beautify('select id fro account')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/FROM/)
  })
})

describe('beautifyOrKeep', () => {
  it('formats valid SOQL and leaves unparseable text untouched', () => {
    expect(beautifyOrKeep('select Id from Account')).toBe('SELECT Id\nFROM Account')
    expect(beautifyOrKeep('select Id fro Account')).toBe('select Id fro Account')
  })
})

describe('parseErrorPosition', () => {
  it('extracts row and column', () => {
    expect(parseErrorPosition('\nSELECT Id FRO Account\n ^\nERROR at Row:1:Column:11\nunexpected token')).toEqual({ line: 1, column: 11 })
    expect(parseErrorPosition('No such column')).toBeNull()
  })
})

describe('errorDetail', () => {
  it('drops the echoed query and caret', () => {
    expect(errorDetail("\nSELECT Id, Nme\n           ^\nERROR at Row:1:Column:12\nNo such column 'Nme' on entity 'Account'.")).toBe("No such column 'Nme' on entity 'Account'.")
  })

  it('keeps messages without a position', () => {
    expect(errorDetail('  sObject type Foo is not supported. ')).toBe('sObject type Foo is not supported.')
  })
})
