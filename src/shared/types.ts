/** Everything that defines an environment; this is what export/import carries (no secrets, no tokens). */
export interface EnvironmentConfig {
  name: string
  /** Azure AD authorize endpoint */
  authUrl: string
  /** Azure AD token endpoint */
  tokenUrl: string
  clientId: string
  /** Space-separated Azure scopes; `offline_access` is added automatically. */
  scope: string
  /** Redirect URI registered in Azure (may be a custom scheme such as msauth://…) */
  redirectUri: string
  /** Endpoint that exchanges the Azure access token for a Salesforce access token */
  sfTokenUrl: string
  apiVersion: string
}

export interface Environment extends EnvironmentConfig {
  id: string
}

/** `clientSecret`: undefined = keep existing, null or '' = clear, string = set. */
export interface EnvironmentInput extends EnvironmentConfig {
  clientSecret?: string | null
}

export const ENVIRONMENT_FILE_FORMAT = 'querynator-environments'

export interface EnvironmentFile {
  format: typeof ENVIRONMENT_FILE_FORMAT
  version: 1
  environments: EnvironmentConfig[]
}

export interface AppSettings {
  environments: Environment[]
  openAiModel: string
  lastEnvironmentId: string | null
}

export type AppSettingsPatch = Partial<Pick<AppSettings, 'openAiModel'>>

export interface SettingsView extends AppSettings {
  hasOpenAiKey: boolean
  /** envId -> whether a client secret is stored */
  envHasSecret: Record<string, boolean>
}

export interface UserInfo {
  id: string
  name: string
  email: string
  username: string
  profileName: string | null
  roleName: string | null
  timeZone: string
  orgId: string
  instanceUrl: string
}

export type ConnectionState = { status: 'loggedOut' } | { status: 'connected'; user: UserInfo }

/** A user who has logged in to an environment (its tokens are stored encrypted in the main process). */
export interface AccountSummary {
  /** Salesforce user id */
  id: string
  name: string
  username: string
  /** Its tokens are gone (expired or revoked): selecting it requires a new login. */
  needsLogin: boolean
}

/** Connection state of an environment plus the users that can be switched between. */
export interface EnvSession {
  accounts: AccountSummary[]
  activeAccountId: string | null
  state: ConnectionState
}

export interface SfRecord {
  attributes?: { type: string; url?: string }
  [key: string]: unknown
}

export interface QueryResult {
  totalSize: number
  done: boolean
  nextRecordsUrl?: string
  records: SfRecord[]
}

export interface QueryRunResult {
  result: QueryResult
  durationMs: number
}

export interface HistoryEntry {
  query: string
  ranAt: string
  rowCount: number | null
  durationMs: number
  error?: string
}

export interface GlobalDescribeEntry {
  name: string
  label: string
  queryable: boolean
  custom?: boolean
}

export interface PicklistValue {
  value: string
  label: string
  active: boolean
}

export interface FieldDescribe {
  name: string
  label: string
  type: string
  relationshipName: string | null
  referenceTo: string[]
  picklistValues: PicklistValue[]
  // Details for the object explorer; optional because older metadata caches lack them.
  length?: number
  precision?: number
  scale?: number
  nillable?: boolean
  custom?: boolean
  calculated?: boolean
  externalId?: boolean
  unique?: boolean
  inlineHelpText?: string | null
}

export interface ChildRelationship {
  relationshipName: string | null
  childSObject: string
  field: string
}

export interface SObjectDescribe {
  name: string
  label: string
  fields: FieldDescribe[]
  childRelationships: ChildRelationship[]
}

export interface AiSuggestion {
  query: string
  explanation: string
}

export type AppErrorKind = 'salesforce' | 'auth' | 'network' | 'ai' | 'config' | 'cancelled' | 'unknown'

export interface AppError {
  kind: AppErrorKind
  message: string
  code?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }
