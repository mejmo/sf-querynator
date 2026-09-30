import type { FieldDescribe, SObjectDescribe } from '../../src/shared/types'
import type { MetadataSource } from '../../src/soql/completions'

export function field(name: string, type = 'string', extra: Partial<FieldDescribe> = {}): FieldDescribe {
  return { name, label: name, type, relationshipName: null, referenceTo: [], picklistValues: [], ...extra }
}

export const ACCOUNT: SObjectDescribe = {
  name: 'Account',
  label: 'Account',
  fields: [
    field('Id', 'id'),
    field('Name'),
    field('Type', 'picklist', {
      picklistValues: [
        { value: 'Customer', label: 'Customer', active: true },
        { value: 'Partner', label: 'Partner', active: true },
        { value: 'Old', label: 'Old', active: false }
      ]
    }),
    field('CreatedDate', 'datetime'),
    field('IsDeleted', 'boolean'),
    field('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User'] })
  ],
  childRelationships: [
    { relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' },
    { relationshipName: null, childSObject: 'AccountHistory', field: 'AccountId' }
  ]
}

export const CONTACT: SObjectDescribe = {
  name: 'Contact',
  label: 'Contact',
  fields: [field('Id', 'id'), field('LastName'), field('AccountId', 'reference', { relationshipName: 'Account', referenceTo: ['Account'] })],
  childRelationships: []
}

export const USER: SObjectDescribe = {
  name: 'User',
  label: 'User',
  fields: [
    field('Id', 'id'),
    field('Email', 'email'),
    field('ManagerId', 'reference', { relationshipName: 'Manager', referenceTo: ['User'] })
  ],
  childRelationships: []
}

export function fakeMetadata(objects: SObjectDescribe[] = [ACCOUNT, CONTACT, USER]): MetadataSource & { describeCalls: string[] } {
  const describeCalls: string[] = []
  return {
    describeCalls,
    async getGlobal() {
      return [
        ...objects.map((o) => ({ name: o.name, label: o.label, queryable: true })),
        { name: 'SetupThing', label: 'Setup', queryable: false }
      ]
    },
    async describe(name) {
      describeCalls.push(name)
      return objects.find((o) => o.name.toLowerCase() === name.toLowerCase()) ?? null
    }
  }
}
