import type { FieldDescribe, GlobalDescribeEntry, SObjectDescribe } from '../shared/types'
import type { Clause, CompletionContext, ObjectRef } from './context'

export interface MetadataSource {
  getGlobal(): Promise<GlobalDescribeEntry[] | null>
  describe(objectName: string): Promise<SObjectDescribe | null>
}

export type SuggestionKind = 'keyword' | 'object' | 'field' | 'relationship' | 'value' | 'function'

export interface Suggestion {
  label: string
  insertText: string
  kind: SuggestionKind
  detail?: string
  /** insertText uses snippet syntax, e.g. `LAST_N_DAYS:${1:7}` */
  snippet?: boolean
}

export const DATE_LITERALS = [
  'YESTERDAY', 'TODAY', 'TOMORROW',
  'LAST_WEEK', 'THIS_WEEK', 'NEXT_WEEK',
  'LAST_MONTH', 'THIS_MONTH', 'NEXT_MONTH',
  'LAST_90_DAYS', 'NEXT_90_DAYS',
  'LAST_QUARTER', 'THIS_QUARTER', 'NEXT_QUARTER',
  'LAST_YEAR', 'THIS_YEAR', 'NEXT_YEAR',
  'LAST_FISCAL_QUARTER', 'THIS_FISCAL_QUARTER', 'NEXT_FISCAL_QUARTER',
  'LAST_FISCAL_YEAR', 'THIS_FISCAL_YEAR', 'NEXT_FISCAL_YEAR'
]

export const DATE_N_LITERALS = [
  'LAST_N_DAYS', 'NEXT_N_DAYS', 'N_DAYS_AGO',
  'LAST_N_WEEKS', 'NEXT_N_WEEKS', 'N_WEEKS_AGO',
  'LAST_N_MONTHS', 'NEXT_N_MONTHS', 'N_MONTHS_AGO',
  'LAST_N_QUARTERS', 'NEXT_N_QUARTERS', 'N_QUARTERS_AGO',
  'LAST_N_YEARS', 'NEXT_N_YEARS', 'N_YEARS_AGO',
  'LAST_N_FISCAL_QUARTERS', 'NEXT_N_FISCAL_QUARTERS', 'N_FISCAL_QUARTERS_AGO',
  'LAST_N_FISCAL_YEARS', 'NEXT_N_FISCAL_YEARS', 'N_FISCAL_YEARS_AGO'
]

const AGGREGATES = ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'FORMAT', 'toLabel', 'convertCurrency', 'CALENDAR_YEAR', 'CALENDAR_MONTH', 'DAY_ONLY', 'FIELDS']

const WHERE_KEYWORDS = ['AND', 'OR', 'NOT', '=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES']

const NEXT_KEYWORDS: Record<Clause | 'start', string[]> = {
  start: ['SELECT'],
  SELECT: ['FROM'],
  FROM: ['WHERE', 'WITH', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET', 'FOR VIEW', 'FOR REFERENCE', 'FOR UPDATE', 'USING SCOPE'],
  WHERE: [...WHERE_KEYWORDS, 'WITH', 'GROUP BY', 'ORDER BY', 'LIMIT', 'OFFSET'],
  WITH: ['SECURITY_ENFORCED', 'USER_MODE', 'SYSTEM_MODE', 'GROUP BY', 'ORDER BY', 'LIMIT'],
  'GROUP BY': ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'ROLLUP', 'CUBE'],
  HAVING: [...WHERE_KEYWORDS, 'ORDER BY', 'LIMIT', 'OFFSET'],
  'ORDER BY': ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'LIMIT', 'OFFSET'],
  LIMIT: ['OFFSET', 'FOR VIEW', 'FOR REFERENCE', 'FOR UPDATE'],
  OFFSET: ['FOR VIEW', 'FOR REFERENCE', 'FOR UPDATE'],
  FOR: ['VIEW', 'REFERENCE', 'UPDATE'],
  'USING SCOPE': ['everything', 'mine', 'team', 'delegated', 'my_territory', 'my_team_territory']
}

const keywords = (words: string[]): Suggestion[] => words.map((w) => ({ label: w, insertText: w, kind: 'keyword' }))

const eq = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase()

export async function resolveObject(ref: ObjectRef, md: MetadataSource): Promise<SObjectDescribe | null> {
  if (ref.kind === 'object') return md.describe(ref.name)
  const parent = await resolveObject(ref.parent, md)
  const rel = parent?.childRelationships.find((r) => eq(r.relationshipName, ref.relationshipName))
  return rel ? md.describe(rel.childSObject) : null
}

/** Target object of a lookup. Polymorphic lookups (e.g. Owner -> Group|User) prefer User. */
function referenceTarget(field: FieldDescribe): string | null {
  if (field.referenceTo.length === 0) return null
  return field.referenceTo.find((r) => r === 'User') ?? field.referenceTo[0]
}

/** Follow relationship names like ['Owner', 'Manager'] from `start`. */
export async function resolvePath(start: SObjectDescribe, path: string[], md: MetadataSource): Promise<SObjectDescribe | null> {
  let current: SObjectDescribe | null = start
  for (const segment of path) {
    if (!current) return null
    const field: FieldDescribe | undefined = current.fields.find((f) => eq(f.relationshipName, segment))
    const target = field && referenceTarget(field)
    if (!target) return null
    current = await md.describe(target)
  }
  return current
}

function fieldSuggestions(desc: SObjectDescribe): Suggestion[] {
  const out: Suggestion[] = []
  for (const f of desc.fields) {
    out.push({ label: f.name, insertText: f.name, kind: 'field', detail: `${f.type} · ${f.label}` })
    const target = referenceTarget(f)
    if (f.relationshipName && target) {
      out.push({ label: `${f.relationshipName}.`, insertText: f.relationshipName, kind: 'relationship', detail: `→ ${target}` })
    }
  }
  return out
}

function valueSuggestions(field: FieldDescribe, inString: boolean): Suggestion[] {
  const out: Suggestion[] = []
  if (field.type === 'picklist' || field.type === 'multipicklist') {
    for (const v of field.picklistValues.filter((p) => p.active)) {
      out.push({ label: v.value, insertText: inString ? v.value : `'${v.value}'`, kind: 'value', detail: v.label })
    }
  }
  if (inString) return out
  if (field.type === 'date' || field.type === 'datetime') {
    out.push(...DATE_LITERALS.map((d): Suggestion => ({ label: d, insertText: d, kind: 'value', detail: 'date literal' })))
    out.push(
      ...DATE_N_LITERALS.map((d): Suggestion => ({ label: `${d}:n`, insertText: `${d}:\${1:7}`, kind: 'value', detail: 'date literal', snippet: true }))
    )
  }
  if (field.type === 'boolean') out.push(...keywords(['TRUE', 'FALSE']))
  out.push(...keywords(['NULL']))
  return out
}

export async function getCompletions(ctx: CompletionContext, md: MetadataSource): Promise<Suggestion[]> {
  switch (ctx.kind) {
    case 'none':
      return []
    case 'keyword':
      return keywords(NEXT_KEYWORDS[ctx.clause ?? 'start'])
    case 'object': {
      const global = await md.getGlobal()
      return (global ?? [])
        .filter((o) => o.queryable)
        .map((o) => ({ label: o.name, insertText: o.name, kind: 'object', detail: o.label }))
    }
    case 'childRelationship': {
      const parent = await resolveObject(ctx.parent, md)
      return (parent?.childRelationships ?? [])
        .filter((r) => r.relationshipName)
        .map((r) => ({ label: r.relationshipName!, insertText: r.relationshipName!, kind: 'relationship', detail: r.childSObject }))
    }
    case 'field': {
      const extra: Suggestion[] = []
      if (ctx.path.length === 0) {
        if (ctx.clause === 'SELECT') {
          extra.push(...keywords(['FROM', 'TYPEOF']))
          extra.push(...AGGREGATES.map((f): Suggestion => ({ label: `${f}()`, insertText: `${f}($0)`, kind: 'function', snippet: true })))
        }
        if (ctx.clause === 'WHERE' || ctx.clause === 'HAVING') extra.push(...keywords(['NOT']))
      }
      const base = ctx.from && (await resolveObject(ctx.from, md))
      const target = base && (await resolvePath(base, ctx.path, md))
      return [...(target ? fieldSuggestions(target) : []), ...extra]
    }
    case 'value': {
      const base = ctx.from && (await resolveObject(ctx.from, md))
      const owner = base && (await resolvePath(base, ctx.fieldPath.slice(0, -1), md))
      const fieldName = ctx.fieldPath[ctx.fieldPath.length - 1]
      const field = owner?.fields.find((f) => eq(f.name, fieldName))
      if (!field) return ctx.inString ? [] : keywords(['NULL'])
      return valueSuggestions(field, ctx.inString)
    }
  }
}
