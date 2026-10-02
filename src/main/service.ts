import { randomUUID } from 'node:crypto'
import type { ServiceApi } from '../shared/api'
import {
  ENVIRONMENT_FILE_FORMAT,
  type AccountSummary,
  type AiSuggestion,
  type AppSettingsPatch,
  type AuthType,
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
import { maskLineComments, splitLineComments } from '../soql/comments'
import { environmentEntries } from '../shared/environmentFile'
import { findRootObject } from '../soql/context'
import { suggestFix } from './ai/openai'
import { buildAuthorizeUrl, createPkce, createState, exchangeCode, parseCallback, refreshAzureToken, type AzureTokenResponse } from './auth/azure'
import type { AuthorizeFn } from './auth/loginWindow'
import { identifyToken } from './auth/pastedToken'
import { buildSalesforceAuthorizeUrl, exchangeSalesforceCode, refreshSalesforceToken, revokeSalesforceToken } from './auth/salesforce'
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
  /** Shows the sign-in page (Azure or Salesforce) and resolves with the redirect URL. */
  authorize: AuthorizeFn
  /** Monotonic clock for durations (ms). */
  now?: () => number
  /** Wall clock for token expiry (ms since epoch). */
  clock?: () => number
  /** Override of the OpenAI endpoint (development smoke tests only). */
  openAiUrl?: string
}

const STRING_KEYS = ['name', 'loginUrl', 'instanceUrl', 'authUrl', 'tokenUrl', 'clientId', 'scope', 'redirectUri', 'sfTokenUrl', 'apiVersion'] as const

/** Fields that matter per auth type; the others are blanked and left out of exports. */
const KEYS_BY_TYPE: Record<AuthType, (keyof EnvironmentConfig)[]> = {
  salesforce: ['name', 'authType', 'loginUrl', 'clientId', 'redirectUri', 'apiVersion'],
  azure: ['name', 'authType', 'authUrl', 'tokenUrl', 'clientId', 'scope', 'redirectUri', 'sfTokenUrl', 'apiVersion'],
  token: ['name', 'authType', 'instanceUrl', 'apiVersion']
}

// Plain http is only allowed for local mock servers.
const HTTP_URL = /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i

function normalizeConfig(input: Partial<EnvironmentConfig>): EnvironmentConfig {
  // Files exported before auth types existed are Azure environments.
  const authType: AuthType = input.authType ?? (input.authUrl ? 'azure' : 'salesforce')
  if (!(authType in KEYS_BY_TYPE)) throw new ConfigError(`Unknown authentication type: ${String(authType)}`)
  const relevant = new Set(KEYS_BY_TYPE[authType])
  const c = { authType } as EnvironmentConfig
  for (const k of STRING_KEYS) c[k] = relevant.has(k) ? String(input[k] ?? '').trim() : ''
  if (!c.name) throw new ConfigError('Name is required')
  if (!/^\d+\.0$/.test(c.apiVersion)) throw new ConfigError('API version must look like 62.0')
  if (authType === 'token') {
    c.instanceUrl = c.instanceUrl.replace(/\/+$/, '')
    if (!HTTP_URL.test(c.instanceUrl)) throw new ConfigError('Instance URL must look like https://yourorg.my.salesforce.com')
    return c
  }
  if (!c.clientId) throw new ConfigError(authType === 'salesforce' ? 'Consumer Key is required' : 'Client ID is required')
  if (!ANY_URL.test(c.redirectUri)) throw new ConfigError('Callback URL must be a URL, e.g. http://localhost:1717/oauth/callback or msauth://…')
  if (authType === 'salesforce') {
    c.loginUrl = c.loginUrl.replace(/\/+$/, '')
    if (!HTTP_URL.test(c.loginUrl)) throw new ConfigError('Login URL must look like https://login.salesforce.com')
  } else {
    c.scope = c.scope.split(/\s+/).filter(Boolean).join(' ')
    if (!HTTP_URL.test(c.authUrl)) throw new ConfigError('Auth URL must be an https URL')
    if (!HTTP_URL.test(c.tokenUrl)) throw new ConfigError('Token URL must be an https URL')
    if (!c.scope) throw new ConfigError('Scope is required')
    if (!HTTP_URL.test(c.sfTokenUrl)) throw new ConfigError('Salesforce token URL must be an https URL')
  }
  return c
}

/** The account still has something to renew its session with. */
const hasSession = (a: { accessToken?: string; refreshToken?: string; azureRefreshToken?: string }) =>
  !!(a.accessToken || a.refreshToken || a.azureRefreshToken)

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
      environments: selected.map((e) => Object.fromEntries(KEYS_BY_TYPE[e.authType].map((k) => [k, e[k]])) as unknown as EnvironmentConfig)
    }
  }

  /**
   * Import environments from an export file (or a bare environment object / array). An environment whose name
   * matches an existing one (case-insensitive) updates it; others are created. Everything is validated first.
   */
  async importEnvironments(data: unknown): Promise<Environment[]> {
    const list = environmentEntries(data)
    if (list.length === 0) throw new ConfigError('The JSON contains no environments')
    const configs = list.map((item, i) => {
      if (!item || typeof item !== 'object') throw new ConfigError(`Environment #${i + 1} is not an object`)
      try {
        return normalizeConfig(item as Partial<EnvironmentConfig>)
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
  // Auth type `salesforce`: Salesforce OAuth, authorization code + PKCE in an in-app window -> Salesforce access +
  // refresh token. On a 401 the refresh token gets a new access token.
  //
  // Auth type `azure`:
  // 1. Azure AD: authorization code + PKCE in an in-app window -> Azure access + refresh token.
  // 2. Token service: GET sfTokenUrl with the Azure token -> Salesforce access token + instance URL + user id.
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

  /** Get a fresh Salesforce access token for the account and store it. */
  private async renewSalesforceToken(env: Environment, accountId: string): Promise<SfConnection> {
    if (env.authType === 'salesforce') return this.renewViaRefreshToken(env, accountId)
    if (env.authType === 'azure') return this.renewViaTokenService(env, accountId)
    // A pasted token can't be renewed.
    await this.deps.secrets.clearAccountTokens(env.id, accountId)
    throw new SessionExpiredError('The access token is no longer valid. Log in with a new token.')
  }

  private async renewViaRefreshToken(env: Environment, accountId: string): Promise<SfConnection> {
    const a = await this.deps.secrets.getAccount(env.id, accountId)
    if (!a?.refreshToken) {
      await this.deps.secrets.clearAccountTokens(env.id, accountId)
      throw new SessionExpiredError()
    }
    let t
    try {
      t = await refreshSalesforceToken(this.deps.fetchFn, {
        loginUrl: env.loginUrl,
        clientId: env.clientId,
        clientSecret: (await this.deps.secrets.getEnv(env.id)).clientSecret,
        refreshToken: a.refreshToken
      })
    } catch (e) {
      if (e instanceof OAuthError) {
        await this.deps.secrets.clearAccountTokens(env.id, accountId)
        throw new SessionExpiredError('Salesforce session expired. Please log in again.')
      }
      throw e
    }
    await this.deps.secrets.updateAccount(env.id, accountId, {
      accessToken: t.access_token,
      instanceUrl: t.instance_url,
      // Salesforce only sends a new refresh token when rotation is enabled for the app.
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {})
    })
    return { instanceUrl: t.instance_url, accessToken: t.access_token, apiVersion: env.apiVersion }
  }

  private async renewViaTokenService(env: Environment, accountId: string): Promise<SfConnection> {
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
      .map(([id, a]) => ({ id, name: a.name ?? id, username: a.username ?? '', needsLogin: !hasSession(a) }))
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
    if (!accountId || !account || !hasSession(account)) return this.session(envId, { status: 'loggedOut' })
    try {
      return this.session(envId, await this.connectedState(env, accountId))
    } catch (e) {
      if (e instanceof SessionExpiredError) return this.session(envId, { status: 'loggedOut' })
      throw e
    }
  }

  async login(envId: string, accessToken?: string): Promise<EnvSession> {
    const env = await this.env(envId)
    if (env.authType === 'token') return this.loginWithToken(env, accessToken?.trim() ?? '')
    this.loginAbort?.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    try {
      const { verifier, challenge } = createPkce()
      const state = createState()
      const callbackUrl = await this.deps.authorize({
        url:
          env.authType === 'salesforce'
            ? buildSalesforceAuthorizeUrl({ loginUrl: env.loginUrl, clientId: env.clientId, redirectUri: env.redirectUri, challenge, state })
            : buildAuthorizeUrl({ authUrl: env.authUrl, clientId: env.clientId, redirectUri: env.redirectUri, scope: env.scope, challenge, state }),
        redirectUri: env.redirectUri,
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: abort.signal
      })
      const code = parseCallback(callbackUrl, state)
      const clientSecret = (await this.deps.secrets.getEnv(envId)).clientSecret
      const userId =
        env.authType === 'salesforce'
          ? await this.completeSalesforceLogin(env, { code, verifier, clientSecret })
          : await this.completeAzureLogin(env, { code, verifier, clientSecret })
      await this.deps.secrets.setActiveAccount(envId, userId)
      await this.rememberEnvironment(envId)
      return this.session(envId, await this.connectedState(env, userId))
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null
    }
  }

  /** No login flow: identify the pasted token's user and keep the token for that account. */
  private async loginWithToken(env: Environment, accessToken: string): Promise<EnvSession> {
    if (!accessToken) throw new ConfigError('Paste an access token.')
    const { userId, orgId } = await identifyToken(this.deps.fetchFn, { instanceUrl: env.instanceUrl, apiVersion: env.apiVersion, accessToken })
    await this.deps.secrets.clearAccountTokens(env.id, userId)
    await this.deps.secrets.updateAccount(env.id, userId, { accessToken, instanceUrl: env.instanceUrl, orgId })
    await this.deps.secrets.setActiveAccount(env.id, userId)
    await this.rememberEnvironment(env.id)
    return this.session(env.id, await this.connectedState(env, userId))
  }

  /** Stores the new account's tokens and returns its Salesforce user id. */
  private async completeSalesforceLogin(env: Environment, p: { code: string; verifier: string; clientSecret?: string }): Promise<string> {
    const t = await exchangeSalesforceCode(this.deps.fetchFn, {
      loginUrl: env.loginUrl,
      clientId: env.clientId,
      clientSecret: p.clientSecret,
      code: p.code,
      verifier: p.verifier,
      redirectUri: env.redirectUri
    })
    const { userId, orgId } = parseIdentityUrl(t.id)
    await this.deps.secrets.clearAccountTokens(env.id, userId)
    await this.deps.secrets.updateAccount(env.id, userId, {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      instanceUrl: t.instance_url,
      orgId
    })
    return userId
  }

  /** Stores the new account's tokens and returns its Salesforce user id. */
  private async completeAzureLogin(env: Environment, p: { code: string; verifier: string; clientSecret?: string }): Promise<string> {
    const t = await exchangeCode(this.deps.fetchFn, {
      tokenUrl: env.tokenUrl,
      clientId: env.clientId,
      clientSecret: p.clientSecret,
      scope: env.scope,
      code: p.code,
      verifier: p.verifier,
      redirectUri: env.redirectUri
    })
    // The Salesforce identity decides which account this login belongs to.
    const sf = await fetchSalesforceToken(this.deps.fetchFn, { sfTokenUrl: env.sfTokenUrl, azureAccessToken: t.access_token })
    const { userId, orgId } = parseIdentityUrl(sf.id)
    await this.deps.secrets.clearAccountTokens(env.id, userId)
    await this.deps.secrets.updateAccount(env.id, userId, {
      ...this.azureTokenFields(t),
      accessToken: sf.access_token,
      instanceUrl: sf.instance_url,
      orgId
    })
    return userId
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

  /**
   * Forget the active user's tokens and remove it. Salesforce OAuth tokens are revoked (best effort); the SSO cookie
   * in the sign-in window is kept.
   */
  async logout(envId: string): Promise<EnvSession> {
    const env = await this.env(envId)
    const accountId = (await this.deps.secrets.getEnv(envId)).activeAccountId
    if (accountId) {
      const a = await this.deps.secrets.getAccount(envId, accountId)
      const token = a?.refreshToken ?? a?.accessToken
      if (env.authType === 'salesforce' && token) await revokeSalesforceToken(this.deps.fetchFn, { loginUrl: env.loginUrl, token })
      await this.deps.secrets.removeAccount(envId, accountId)
    }
    return this.session(envId, { status: 'loggedOut' })
  }

  // ---- queries --------------------------------------------------------------

  /**
   * Starts a cancellable query: aborts any previous one and returns the new abort signal. Called before anything is
   * awaited, so a Cancel pressed while settings/tokens are still being read also stops the query.
   */
  private beginQuery(): AbortController {
    this.queryAbort?.abort()
    const abort = new AbortController()
    this.queryAbort = abort
    return abort
  }

  private async timed(abort: AbortController, run: (signal: AbortSignal) => Promise<QueryRunResult['result']>): Promise<QueryRunResult> {
    const start = this.now()
    try {
      if (abort.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const result = await run(abort.signal)
      return { result, durationMs: Math.round(this.now() - start) }
    } finally {
      if (this.queryAbort === abort) this.queryAbort = null
    }
  }

  async runQuery(envId: string, soql: string, queryAll: boolean): Promise<QueryRunResult> {
    // History keeps the text as written (with comments); Salesforce gets comment lines blanked out, which keeps
    // row/column positions in its error messages aligned with the editor.
    const query = soql.trim()
    const sent = maskLineComments(soql).trimEnd()
    if (!sent.trim()) throw new ConfigError('Query is empty')
    const abort = this.beginQuery()
    const start = this.now()
    const ranAt = new Date().toISOString()
    try {
      const client = await this.client(envId)
      const r = await this.timed(abort, (signal) => client.query(sent, { queryAll, signal }))
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
    const abort = this.beginQuery()
    const client = await this.client(envId)
    return this.timed(abort, (signal) => client.queryMore(nextRecordsUrl, signal))
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
    // The AI sees the query without comment lines; the dialog puts them back.
    soql = splitLineComments(soql).body.trim()
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
