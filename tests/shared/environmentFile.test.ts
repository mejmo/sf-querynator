import { describe, expect, it } from 'vitest'
import { environmentEntries, previewImport } from '../../src/shared/environmentFile'

describe('environmentEntries', () => {
  it('accepts an export file, an array or a single object', () => {
    expect(environmentEntries({ format: 'querynator-environments', version: 1, environments: [{ name: 'A' }] })).toEqual([{ name: 'A' }])
    expect(environmentEntries([{ name: 'A' }, { name: 'B' }])).toHaveLength(2)
    expect(environmentEntries({ name: 'A' })).toEqual([{ name: 'A' }])
    expect(environmentEntries(null)).toEqual([])
  })
})

describe('previewImport', () => {
  const file = JSON.stringify({
    format: 'querynator-environments',
    version: 1,
    environments: [
      { name: 'Prod', authType: 'salesforce' },
      { name: ' uat ', authUrl: 'https://login.microsoftonline.com/x/authorize' },
      { name: 'Dev', authType: 'token' }
    ]
  })

  it('lists each environment, marking ones that update an existing environment', () => {
    expect(previewImport(file, ['UAT', 'Other'])).toEqual([
      { name: 'Prod', authType: 'salesforce', updatesExisting: false },
      { name: 'uat', authType: 'azure', updatesExisting: true },
      { name: 'Dev', authType: 'token', updatesExisting: false }
    ])
  })

  it('explains what is wrong with the pasted text', () => {
    expect(() => previewImport('{ nope', [])).toThrow(/Not valid JSON/)
    expect(() => previewImport('{"environments": []}', [])).toThrow(/no environments/)
    expect(() => previewImport('[1]', [])).toThrow(/#1 is not an object/)
    expect(() => previewImport('[{"authType": "token"}]', [])).toThrow(/#1 has no name/)
  })
})
