import type { FieldDescribe } from '../shared/types'

const numberWithScale = (label: string, f: FieldDescribe) =>
  f.precision ? `${label}(${f.precision - (f.scale ?? 0)}, ${f.scale ?? 0})` : label

/** Salesforce-setup-style type label, e.g. "Text(255)", "Lookup(User)", "Number(16, 2)". */
export function formatFieldType(f: FieldDescribe): string {
  switch (f.type) {
    case 'id':
      return 'Id'
    case 'reference':
      return f.referenceTo.length ? `Lookup(${f.referenceTo.join(', ')})` : 'Lookup'
    case 'string':
      return f.length ? `Text(${f.length})` : 'Text'
    case 'textarea':
      return f.length ? `Text Area(${f.length})` : 'Text Area'
    case 'encryptedstring':
      return f.length ? `Text (Encrypted)(${f.length})` : 'Text (Encrypted)'
    case 'email':
      return 'Email'
    case 'phone':
      return 'Phone'
    case 'url':
      return 'URL'
    case 'picklist':
      return 'Picklist'
    case 'multipicklist':
      return 'Picklist (Multi-Select)'
    case 'combobox':
      return 'Combobox'
    case 'boolean':
      return 'Checkbox'
    case 'date':
      return 'Date'
    case 'datetime':
      return 'Date/Time'
    case 'time':
      return 'Time'
    case 'int':
      return 'Number'
    case 'double':
      return numberWithScale('Number', f)
    case 'currency':
      return numberWithScale('Currency', f)
    case 'percent':
      return numberWithScale('Percent', f)
    case 'address':
      return 'Address'
    case 'location':
      return 'Geolocation'
    case 'base64':
      return 'File'
    default:
      return f.type
  }
}

/** Short flags shown next to a field: required, custom, formula, external id, unique. */
export function fieldFlags(f: FieldDescribe): string[] {
  const flags: string[] = []
  if (f.nillable === false && f.type !== 'boolean' && f.type !== 'id' && !f.calculated) flags.push('Required')
  if (f.custom) flags.push('Custom')
  if (f.calculated) flags.push('Formula')
  if (f.externalId) flags.push('External ID')
  if (f.unique) flags.push('Unique')
  return flags
}

/** A starter query for the object explorer's "Query selected" button. */
export function buildSelect(objectName: string, fields: string[], limit = 100): string {
  const list = fields.length ? fields : ['Id']
  return `SELECT ${list.join(', ')}\nFROM ${objectName}\nLIMIT ${limit}`
}
