import { randomUUID } from 'node:crypto'
import type { ServiceApi } from '../shared/api'
import {
  ENVIRONMENT_FILE_FORMAT,
  type AccountSummary,
  type AiSuggestion,
  type AppSettingsPatch,
  type ConnectionState,
  type Environment,
  type EnvironmentConfig,
  type EnvironmentFile,
  type EnvironmentInput,
  type EnvSession,
  type GlobalDescribeEntry,
  type HistoryEntry,
  type QueryRunResult,
  type SettingsView,
  type SObjectDescribe
} from '../shared/types'
import { findRootObject } from '../soql/context'
import { suggestFix } from './ai/openai'
import { buildAuthorizeUrl, createPkce, createState, exchangeCode, parseCallback, refreshAzureToken, type AzureTokenResponse } from './auth/azure'
import type { AuthorizeFn } from './auth/loginWindow'
import { fetchSalesforceToken, parseIdentityUrl, SF_TOKEN_UNAUTHORIZED } from './auth/sfToken'
import { ConfigError, OAuthError, SessionExpiredError, errorMessage, isAbortError, type FetchFn } from './errors'
import { SalesforceClient, type SfConnection, type TokenProvider } from './sf/client'
import type { HistoryStore } from './store/history'
import type { MetaCache } from './store/metaCache'
import type { SecretsStore } from './store/secrets'
import type { SettingsStore } from './store/settings'

export const LOGIN_TIMEOUT_MS = 5 * 60_000
/** Renew the Azure token this long before it expires. */
const AZURE_EXPIRY_MARGIN_MS = 60_000

export interface ServiceDeps {
  settings: SettingsStore
  secrets: SecretsStore
  history: HistoryStore
  meta: MetaCache
  fetchFn: FetchFn
  /** Shows the Azure sign-in page and resolves with the redirect URL. */
  authorize: AuthorizeFn
  /** Monotonic clock for durations (ms). */
  now?: () => number
  /** Wall clock for token expiry (ms since epoch). */
  clock?: () => number
  /** Override of the OpenAI endpoint (development smoke tests only). */
  openAiUrl?: string
}

const CONFIG_KEYS: (keyof EnvironmentConfig)[] = ['name', 'authUrl', 'tokenUrl', 'clientId', 'scope', 'redirectUri', 'sfTokenUrl', 'apiVersion']

// Plain http is only allowed for local mock servers.
const HTTP_URL = /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/

function normalizeConfig(input: EnvironmentConfig): EnvironmentConfig {
  const c = Object.fromEntries(CONFIG_KEYS.map((k) => [k, String(input[k] ?? '').trim()])) as unknown as EnvironmentConfig
  c.scope = c.scope.split(/\s+/).filter(Boolean).join(' ')
  if (!c.name) throw new ConfigError('Name is required')
  if (!HTTP_URL.test(c.authUrl)) throw new ConfigError('Auth URL must be an https URL')
  if (!HTTP_URL.test(c.tokenUrl)) throw new ConfigError('Token URL must be an https URL')
  if (!c.clientId) throw new ConfigError('Client ID is required')
  if (!c.scope) throw new ConfigError('Scope is required')
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(c.redirectUri)) throw new ConfigError('Callback URL must look like msauth://… or https://…')
  if (!HTTP_URL.test(c.sfTokenUrl)) throw new ConfigError('Salesforce token URL must be an https URL')
  if (!/^\d+\.0$/.test(c.apiVersion)) throw new ConfigError('API version must look like 62.0')
  return c
}

export class AppService implements ServiceApi {
  private loginAbort: AbortController | null = null
  private queryAbort: AbortController | null = null
  private readonly now: () => number
  private readonly clock: () => number

  constructor(private readonly deps: ServiceDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.clock = deps.clock ?? (() => Date.now())
  }

  // ---- settings -------------------------------------------------------------

  async getSettings(): Promise<SettingsView> {
    const s = await this.deps.settings.load()
    const envHasSecret: Record<string, boolean> = {}
    for (const e of s.environments) envHasSecret[e.id] = !!(await this.deps.secrets.getEnv(e.id)).clientSecret
    return { ...s, hasOpenAiKey: !!(await this.deps.secrets.getOpenAiKey()), envHasSecret }
  }

  async saveEnvironment(id: string | null, input: EnvironmentInput): Promise<Environment> {
    const env: Environment = { id: id ?? randomUUID(), ...normalizeConfig(input) }
    await this.deps.settings.update((s) => {
      if (id && !s.environments.some((e) => e.id === id)) throw new ConfigError('Unknown environment')
      const environments = id ? s.environments.map((e) => (e.id === id ? env : e)) : [...s.environments, env]
      return { ...s, environments }
    })
    if (input.clientSecret !== undefined) {
      await this.deps.secrets.setClientSecret(env.id, input.clientSecret || undefined)
    }
    return env
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.env(id)
    await this.deps.settings.update((s) => ({
      ...s,
      environments: s.environments.filter((e) => e.id !== id),
      lastEnvironmentId: s.lastEnvironmentId === id ? null : s.lastEnvironmentId
    }))
    await this.deps.secrets.deleteEnv(id)
    await this.deps.history.deleteEnv(id)
    await this.deps.meta.clear(id)
  }

  /** Export file content for the given environments (configuration only: no secrets or tokens). */
  async buildEnvironmentFile(ids: string[]): Promise<EnvironmentFile> {
    const { environments } = await this.deps.settings.load()
    const selected = environments.filter((e) => ids.includes(e.id))
    if (selected.length === 0) throw new ConfigError('Nothing to export')
    return {
      format: ENVIRONMENT_FILE_FORMAT,
      version: 1,
      environments: selected.map((e) => Object.fromEntries(CONFIG_KEYS.map((k) => [k, e[k]])) as unknown as EnvironmentConfig)
    }
  }

  /**
   * Import environments from an export file (or a bare environment object / array). An environment whose name
   * matches an existing one (case-insensitive) updates it; others are created. Everything is validated first.
   */
  async importEnvironments(data: unknown): Promise<Environment[]> {
    const list: unknown[] =
      data && typeof data === 'object' && 'environments' in data && Array.isArray((data as EnvironmentFile).environments)
        ? (data as EnvironmentFile).environments
        : Array.isArray(data)
          ? data
          : [data]
    if (list.length === 0) throw new ConfigError('The file contains no environments')
    const configs = list.map((item, i) => {
      if (!item || typeof item !== 'object') throw new ConfigError(`Environment #${i + 1} is not an object`)
      try {
        return normalizeConfig(item as EnvironmentConfig)
      } catch (e) {
        throw new ConfigError(`Environment #${i + 1}: ${errorMessage(e)}`)
      }
    })
    const imported: Environment[] = []
    await this.deps.settings.update((s) => {
      const environments = [...s.environments]
      for (const c of configs) {
        const idx = environments.findIndex((e) => e.name.toLowerCase() === c.name.toLowerCase())
        const env: Environment = { id: idx >= 0 ? environments[idx].id : randomUUID(), ...c }
        if (idx >= 0) environments[idx] = env
        else environments.push(env)
        imported.push(env)
      }
      return { ...s, environments }
    })
    return imported
  }

  async setAppSettings(patch: AppSettingsPatch): Promise<void> {
    if (patch.openAiModel !== undefined && !patch.openAiModel.trim()) throw new ConfigError('Model is required')
    await this.deps.settings.update((s) => ({ ...s, ...patch }))
  }

  async setOpenAiKey(key: string | null): Promise<void> {
    await this.deps.secrets.setOpenAiKey(key?.trim() || null)
  }

  // ---- auth -----------------------------------------------------------------
  //
  // 1. Azure AD: authorization code + PKCE in an in-app window -> Azure access + refresh token.
  // 2. Company token service: GET sfTokenUrl with the Azure token -> Salesforce access token + instance URL + user id.
  // When Salesforce answers 401, step 2 is repeated (refreshing the Azure token first when needed).
  //
  // Each environment keeps several users ("accounts", keyed by Salesforce user id), each with its own tokens.
  // One of them is active; queries and metadata use the active account.

  private async env(id: string): Promise<Environment> {
    const env = (await this.deps.settings.load()).environments.find((e) => e.id === id)
    if (!env) throw new ConfigError('Unknown environment')
    return env
  }

  private azureTokenFields(t: AzureTokenResponse) {
    return {
      azureAccessToken: t.access_token,
      azureExpiresAt: String(this.clock() + (t.expires_in ?? 3600) * 1000),
      // Azure may rotate the refresh token; keep the old one when it doesn't send a new one.
      ...(t.refresh_token ? { azureRefreshToken: t.refresh_token } : {})
    }
  }

  /** A valid Azure access token for the account, refreshed when expired (or when `force` is set). */
  private async azureAccessToken(env: Environment, accountId: string, force: boolean): Promise<string> {
    const a = await this.deps.secrets.getAccount(env.id, accountId)
    if (!force && a?.azureAccessToken && Number(a.azureExpiresAt) > this.clock() + AZURE_EXPIRY_MARGIN_MS) return a.azureAccessToken
    if (!a?.azureRefreshToken) {
      await this.deps.secrets.clearAccountTokens(env.id, accountId)
      throw new SessionExpiredError()
    }
    try {
      const t = await refreshAzureToken(this.deps.fetchFn, {
        tokenUrl: env.tokenUrl,
        clientId: env.clientId,
        clientSecret: (await this.deps.secrets.getEnv(env.id)).clientSecret,
        scope: env.scope,
        refreshToken: a.azureRefreshToken
      })
      await this.deps.secrets.updateAccount(env.id, accountId, this.azureTokenFields(t))
      return t.access_token
    } catch (e) {
      if (e instanceof OAuthError) {
        await this.deps.secrets.clearAccountTokens(env.id, accountId)
        throw new SessionExpiredError('Azure session expired. Please log in again.')
      }
      throw e
    }
  }

  /** Get a fresh Salesforce token for the account from the token service and store it. */
  private async renewSalesforceToken(env: Environment, accountId: string): Promise<SfConnection> {
    let azureToken = await this.azureAccessToken(env, accountId, false)
    let t
    try {
      t = await fetchSalesforceToken(this.deps.fetchFn, { sfTokenUrl: env.sfTokenUrl, azureAccessToken: azureToken })
    } catch (e) {
      if (!(e instanceof OAuthError && e.code === SF_TOKEN_UNAUTHORIZED)) throw e
      azureToken = await this.azureAccessToken(env, accountId, true)
      t = await fetchSalesforceToken(this.deps.fetchFn, { sfTokenUrl: env.sfTokenUrl, azureAccessToken: azureToken })
    }
    const { userId, orgId } = parseIdentityUrl(t.id)
    if (userId !== accountId) {
      // The Azure identity now maps to a different Salesforce user: this account's tokens are not usable.
      await this.deps.secrets.clearAccountTokens(env.id, accountId)
      throw new SessionExpiredError('The signed-in Azure account now maps to a different Salesforce user. Please log in again.')
    }
    await this.deps.secrets.updateAccount(env.id, accountId, { accessToken: t.access_token, instanceUrl: t.instance_url, orgId })
    return { instanceUrl: t.instance_url, accessToken: t.access_token, apiVersion: env.apiVersion }
  }

  private tokenProvider(env: Environment, accountId: string): TokenProvider {
    return {
      get: async (): Promise<SfConnection> => {
        const a = await this.deps.secrets.getAccount(env.id, accountId)
        if (a?.accessToken && a.instanceUrl) return { instanceUrl: a.instanceUrl, accessToken: a.accessToken, apiVersion: env.apiVersion }
        return this.renewSalesforceToken(env, accountId)
      },
      refresh: () => this.renewSalesforceToken(env, accountId)
    }
  }

  /** Client for the environment's active account. */
  private async client(envId: string): Promise<SalesforceClient> {
    const env = await this.env(envId)
    const accountId = (await this.deps.secrets.getEnv(envId)).activeAccountId
    if (!accountId) throw new SessionExpiredError('Log in to run queries.')
    return new SalesforceClient(this.deps.fetchFn, this.tokenProvider(env, accountId))
  }

  private async connectedState(env: Environment, accountId: string): Promise<ConnectionState> {
    const provider = this.tokenProvider(env, accountId)
    // Make sure we have a Salesforce token (and instance URL) before asking for the user.
    await provider.get()
    const user = await new SalesforceClient(this.deps.fetchFn, provider).getUser(accountId)
    await this.deps.secrets.updateAccount(env.id, accountId, { name: user.name, username: user.username })
    // Read again: the calls above may have renewed the token and instance URL.
    const a = await this.deps.secrets.getAccount(env.id, accountId)
    return { status: 'connected', user: { ...user, orgId: a?.orgId ?? '', instanceUrl: a?.instanceUrl ?? '' } }
  }

  private async session(envId: string, state: ConnectionState): Promise<EnvSession> {
    const s = await this.deps.secrets.getEnv(envId)
    const accounts: AccountSummary[] = Object.entries(s.accounts)
      .map(([id, a]) => ({ id, name: a.name ?? id, username: a.username ?? '', needsLogin: !a.azureRefreshToken && !a.accessToken }))
      .sort((x, y) => x.name.localeCompare(y.name))
    return { accounts, activeAccountId: s.activeAccountId ?? null, state }
  }

  private rememberEnvironment(envId: string) {
    return this.deps.settings.update((s) => ({ ...s, lastEnvironmentId: envId }))
  }

  async connect(envId: string): Promise<EnvSession> {
    const env = await this.env(envId)
    await this.rememberEnvironment(envId)
    const s = await this.deps.secrets.getEnv(envId)
    const accountId = s.activeAccountId
    const account = accountId ? s.accounts[accountId] : undefined
    if (!accountId || !account || (!account.accessToken && !account.azureRefreshToken)) return this.session(envId, { status: 'loggedOut' })
    try {
      return this.session(envId, await this.connectedState(env, accountId))
    } catch (e) {
      if (e instanceof SessionExpiredError) return this.session(envId, { status: 'loggedOut' })
      throw e
    }
  }

  async login(envId: string): Promise<EnvSession> {
    const env = await this.env(envId)
    this.loginAbort?.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    try {
      const { verifier, challenge } = createPkce()
      const state = createState()
      const callbackUrl = await this.deps.authorize({
        url: buildAuthorizeUrl({ authUrl: env.authUrl, clientId: env.clientId, redirectUri: env.redirectUri, scope: env.scope, challenge, state }),
        redirectUri: env.redirectUri,
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: abort.signal
      })
      const code = parseCallback(callbackUrl, state)
      const t = await exchangeCode(this.deps.fetchFn, {
        tokenUrl: env.tokenUrl,
        clientId: env.clientId,
        clientSecret: (await this.deps.secrets.getEnv(envId)).clientSecret,
        scope: env.scope,
        code,
        verifier,
        redirectUri: env.redirectUri
      })
      // The Salesforce identity decides which account this login belongs to.
      const sf = await fetchSalesforceToken(this.deps.fetchFn, { sfTokenUrl: env.sfTokenUrl, azureAccessToken: t.access_token })
      const { userId, orgId } = parseIdentityUrl(sf.id)
      await this.deps.secrets.clearAccountTokens(envId, userId)
      await this.deps.secrets.updateAccount(envId, userId, {
        ...this.azureTokenFields(t),
        accessToken: sf.access_token,
        instanceUrl: sf.instance_url,
        orgId
      })
      await this.deps.secrets.setActiveAccount(envId, userId)
      await this.rememberEnvironment(envId)
      return this.session(envId, await this.connectedState(env, userId))
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null
    }
  }

  async cancelLogin(): Promise<void> {
    this.loginAbort?.abort()
  }

  async switchAccount(envId: string, accountId: string): Promise<EnvSession> {
    await this.env(envId)
    if (!(await this.deps.secrets.getAccount(envId, accountId))) throw new ConfigError('Unknown user')
    await this.deps.secrets.setActiveAccount(envId, accountId)
    return this.connect(envId)
  }

  /** Forget the active user's tokens and remove it. The Azure SSO cookie in the sign-in window is kept. */
  async logout(envId: string): Promise<EnvSession> {
    await this.env(envId)
    const accountId = (await this.deps.secrets.getEnv(envId)).activeAccountId
    if (accountId) await this.deps.secrets.removeAccount(envId, accountId)
    return this.session(envId, { status: 'loggedOut' })
  }

  // ---- queries --------------------------------------------------------------

  private async timed(run: (signal: AbortSignal) => Promise<QueryRunResult['result']>): Promise<QueryRunResult> {
    this.queryAbort?.abort()
    const abort = new AbortController()
    this.queryAbort = abort
    const start = this.now()
    try {
      const result = await run(abort.signal)
      return { result, durationMs: Math.round(this.now() - start) }
    } finally {
      if (this.queryAbort === abort) this.queryAbort = null
    }
  }

  async runQuery(envId: string, soql: string, queryAll: boolean): Promise<QueryRunResult> {
    const query = soql.trim()
    if (!query) throw new ConfigError('Query is empty')
    const client = await this.client(envId)
    const start = this.now()
    const ranAt = new Date().toISOString()
    try {
      const r = await this.timed((signal) => client.query(query, { queryAll, signal }))
      await this.deps.history.add(envId, { query, ranAt, rowCount: r.result.totalSize, durationMs: r.durationMs })
      return r
    } catch (e) {
      if (!isAbortError(e)) {
        await this.deps.history.add(envId, { query, ranAt, rowCount: null, durationMs: Math.round(this.now() - start), error: errorMessage(e) })
      }
      throw e
    }
  }

  async queryMore(envId: string, nextRecordsUrl: string): Promise<QueryRunResult> {
    const client = await this.client(envId)
    return this.timed((signal) => client.queryMore(nextRecordsUrl, signal))
  }

  async cancelQuery(): Promise<void> {
    this.queryAbort?.abort()
  }

  async getHistory(envId: string): Promise<HistoryEntry[]> {
    return this.deps.history.list(envId)
  }

  // ---- metadata -------------------------------------------------------------

  async describeGlobal(envId: string): Promise<GlobalDescribeEntry[]> {
    const cached = await this.deps.meta.getGlobal(envId)
    if (cached) return cached
    const list = await (await this.client(envId)).describeGlobal()
    await this.deps.meta.setGlobal(envId, list)
    return list
  }

  async describeSObject(envId: string, name: string): Promise<SObjectDescribe> {
    const cached = await this.deps.meta.getObject(envId, name)
    if (cached) return cached
    const d = await (await this.client(envId)).describeSObject(name)
    await this.deps.meta.setObject(envId, d)
    return d
  }

  async clearMetadata(envId: string): Promise<void> {
    await this.deps.meta.clear(envId)
  }

  // ---- AI -------------------------------------------------------------------

  async fixQuery(envId: string, soql: string, error: string | null): Promise<AiSuggestion> {
    const apiKey = await this.deps.secrets.getOpenAiKey()
    if (!apiKey) throw new ConfigError('Set your OpenAI API key in Settings first.')
    const env = await this.env(envId)
    const { openAiModel } = await this.deps.settings.load()
    const objectName = findRootObject(soql)
    let fields: { name: string; type: string }[] = []
    if (objectName) {
      try {
        fields = (await this.describeSObject(envId, objectName)).fields.map((f) => ({ name: f.name, type: f.type }))
      } catch {
        // Unknown object or offline: the model can still help without the field list.
      }
    }
    return suggestFix(this.deps.fetchFn, {
      apiKey,
      model: openAiModel,
      url: this.deps.openAiUrl,
      request: { soql, error, objectName, fields, apiVersion: env.apiVersion }
    })
  }
}
