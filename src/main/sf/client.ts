import type { FieldDescribe, GlobalDescribeEntry, QueryResult, SObjectDescribe } from '../../shared/types'
import { SalesforceApiError, SessionExpiredError, type FetchFn } from '../errors'

export const QUERY_BATCH_SIZE = 500

export interface SfConnection {
  instanceUrl: string
  accessToken: string
  apiVersion: string
}

export interface TokenProvider {
  get(): Promise<SfConnection>
  /** Obtain a fresh access token; throws SessionExpiredError when that is impossible. */
  refresh(): Promise<SfConnection>
}

export interface UserRecord {
  id: string
  name: string
  email: string
  username: string
  profileName: string | null
  roleName: string | null
  timeZone: string
}

interface RequestOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function toApiError(res: Response): Promise<SalesforceApiError> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    const first = Array.isArray(body) ? body[0] : body
    if (first?.message) return new SalesforceApiError(res.status, first.errorCode ?? `HTTP_${res.status}`, first.message)
  } catch {
    // not JSON
  }
  return new SalesforceApiError(res.status, `HTTP_${res.status}`, text || res.statusText || `HTTP ${res.status}`)
}

export class SalesforceClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly tokens: TokenProvider
  ) {}

  private send(conn: SfConnection, path: string, opts: RequestOptions) {
    // nextRecordsUrl values are already absolute paths starting with /services/.
    const url = path.startsWith('/services/') ? conn.instanceUrl + path : `${conn.instanceUrl}/services/data/v${conn.apiVersion}${path}`
    return this.fetchFn(url, {
      headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: 'application/json', ...opts.headers },
      signal: opts.signal
    })
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    let res = await this.send(await this.tokens.get(), path, opts)
    if (res.status === 401) {
      res = await this.send(await this.tokens.refresh(), path, opts)
      if (res.status === 401) throw new SessionExpiredError()
    }
    if (!res.ok) throw await toApiError(res)
    return (await res.json()) as T
  }

  query(soql: string, opts: { queryAll?: boolean; signal?: AbortSignal } = {}): Promise<QueryResult> {
    const endpoint = opts.queryAll ? 'queryAll' : 'query'
    return this.request<QueryResult>(`/${endpoint}?q=${encodeURIComponent(soql)}`, {
      headers: { 'Sforce-Query-Options': `batchSize=${QUERY_BATCH_SIZE}` },
      signal: opts.signal
    })
  }

  queryMore(nextRecordsUrl: string, signal?: AbortSignal): Promise<QueryResult> {
    if (!nextRecordsUrl.startsWith('/services/data/')) throw new Error('Invalid nextRecordsUrl')
    return this.request<QueryResult>(nextRecordsUrl, { headers: { 'Sforce-Query-Options': `batchSize=${QUERY_BATCH_SIZE}` }, signal })
  }

  async describeGlobal(): Promise<GlobalDescribeEntry[]> {
    const body = await this.request<{ sobjects: GlobalDescribeEntry[] }>('/sobjects')
    return body.sobjects.map((o) => ({ name: o.name, label: o.label, queryable: o.queryable, custom: !!o.custom }))
  }

  async describeSObject(name: string): Promise<SObjectDescribe> {
    const d = await this.request<SObjectDescribe & { fields: (FieldDescribe & Record<string, unknown>)[] }>(
      `/sobjects/${encodeURIComponent(name)}/describe`
    )
    return {
      name: d.name,
      label: d.label,
      fields: d.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        relationshipName: f.relationshipName ?? null,
        referenceTo: f.referenceTo ?? [],
        picklistValues: (f.picklistValues ?? []).map((p) => ({ value: p.value, label: p.label, active: p.active })),
        length: f.length,
        precision: f.precision,
        scale: f.scale,
        nillable: f.nillable,
        custom: f.custom,
        calculated: f.calculated,
        externalId: f.externalId,
        unique: f.unique,
        inlineHelpText: f.inlineHelpText ?? null
      })),
      childRelationships: (d.childRelationships ?? []).map((r) => ({
        relationshipName: r.relationshipName ?? null,
        childSObject: r.childSObject,
        field: r.field
      }))
    }
  }

  /**
   * The current user's record. Profile and role are optional: some integration users may not see those relations
   * (INVALID_FIELD "No such relation 'Profile' on entity 'User'"), so each is fetched separately and left null when
   * inaccessible.
   */
  async getUser(userId: string): Promise<UserRecord> {
    if (!/^[A-Za-z0-9]{15,18}$/.test(userId)) throw new Error(`Invalid user id: ${userId}`)
    const where = `FROM User WHERE Id = '${userId}'`
    type Row = { Id: string; Name: string; Email: string; Username: string; TimeZoneSidKey: string; Profile?: { Name: string } | null; UserRole?: { Name: string } | null }

    let u: Row | undefined
    let optionalLoaded = true
    try {
      u = (await this.query(`SELECT Id, Name, Email, Username, TimeZoneSidKey, Profile.Name, UserRole.Name ${where}`)).records[0] as Row | undefined
    } catch (e) {
      if (!(e instanceof SalesforceApiError && e.errorCode === 'INVALID_FIELD')) throw e
      optionalLoaded = false
      u = (await this.query(`SELECT Id, Name, Email, Username, TimeZoneSidKey ${where}`)).records[0] as Row | undefined
    }
    if (!u) throw new SalesforceApiError(404, 'NOT_FOUND', 'Current user record not found')

    let profileName = u.Profile?.Name ?? null
    let roleName = u.UserRole?.Name ?? null
    if (!optionalLoaded) {
      const optional = async (relation: 'Profile' | 'UserRole') => {
        try {
          const row = (await this.query(`SELECT ${relation}.Name ${where}`)).records[0] as Row | undefined
          return row?.[relation]?.Name ?? null
        } catch (e) {
          if (e instanceof SalesforceApiError && e.errorCode === 'INVALID_FIELD') return null
          throw e
        }
      }
      profileName = await optional('Profile')
      roleName = await optional('UserRole')
    }
    return { id: u.Id, name: u.Name, email: u.Email, username: u.Username, profileName, roleName, timeZone: u.TimeZoneSidKey }
  }
}
