import { describe, expect, it } from 'vitest'
import { buildSelect, fieldFlags, formatFieldType } from '../../src/soql/schema'
import { field } from './fixtures'

describe('formatFieldType', () => {
  it.each([
    [field('Id', 'id'), 'Id'],
    [field('Name', 'string', { length: 255 }), 'Text(255)'],
    [field('Description', 'textarea', { length: 32000 }), 'Text Area(32000)'],
    [field('OwnerId', 'reference', { referenceTo: ['Group', 'User'] }), 'Lookup(Group, User)'],
    [field('Amount', 'currency', { precision: 18, scale: 2 }), 'Currency(16, 2)'],
    [field('Score__c', 'double', { precision: 18, scale: 0 }), 'Number(18, 0)'],
    [field('Rate', 'percent'), 'Percent'],
    [field('Stage', 'picklist'), 'Picklist'],
    [field('Tags__c', 'multipicklist'), 'Picklist (Multi-Select)'],
    [field('IsActive', 'boolean'), 'Checkbox'],
    [field('CreatedDate', 'datetime'), 'Date/Time'],
    [field('Weird', 'anyType'), 'anyType']
  ])('%s', (f, expected) => {
    expect(formatFieldType(f)).toBe(expected)
  })
})

describe('fieldFlags', () => {
  it('lists the relevant flags', () => {
    expect(fieldFlags(field('Name', 'string', { nillable: false }))).toEqual(['Required'])
    expect(fieldFlags(field('Ext__c', 'string', { nillable: true, custom: true, externalId: true, unique: true }))).toEqual([
      'Custom',
      'External ID',
      'Unique'
    ])
    expect(fieldFlags(field('Total__c', 'double', { nillable: false, custom: true, calculated: true }))).toEqual(['Custom', 'Formula'])
    // Checkboxes and ids are never nullable in describe, but that doesn't make them "required".
    expect(fieldFlags(field('IsActive', 'boolean', { nillable: false }))).toEqual([])
    expect(fieldFlags(field('Id', 'id', { nillable: false }))).toEqual([])
  })
})

describe('buildSelect', () => {
  it('builds a starter query', () => {
    expect(buildSelect('Account', ['Id', 'Name'])).toBe('SELECT Id, Name\nFROM Account\nLIMIT 100')
    expect(buildSelect('Contact', [])).toBe('SELECT Id\nFROM Contact\nLIMIT 100')
  })
})
