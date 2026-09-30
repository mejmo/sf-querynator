import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizeOptions } from '../../src/main/auth/loginWindow'
import { ConfigError, OAuthError, SalesforceApiError } from '../../src/main/errors'
import { AppService } from '../../src/main/service'
import { HistoryStore } from '../../src/main/store/history'
import { MetaCache } from '../../src/main/store/metaCache'
import { SecretsStore } from '../../src/main/store/secrets'
import { SettingsStore } from '../../src/main/store/settings'
import type { EnvironmentConfig } from '../../src/shared/types'
import { fakeEncryptor } from './fakeEncryptor'
import { fakeFetch, json } from './fakeFetch'

const USER_ID = '0050X0000000TEST1A'
const ORG_ID = '00D0X0000000TEST1A'
const INSTANCE = 'https://example--uat.sandbox.my.salesforce.com'
const AZURE_TOKEN_URL = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token'
const SF_TOKEN_URL = 'https://api.example.com/salesforce/token?app=querynator'
const ENV_INPUT: EnvironmentConfig = {
  name: 'UAT',
  authType: 'azure',
  loginUrl: '',
  instanceUrl: '',
  authUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
  tokenUrl: AZURE_TOKEN_URL,
  clientId: 'CID',
  scope: 'api://example-api/A api://example-api/B',
  redirectUri: 'msauth://com.example.querynator/Ab3d+EfGh1jK2lMn=',
  sfTokenUrl: SF_TOKEN_URL,
  apiVersion: '62.0'
}
const azureToken = (n: number, withRefresh = true) => ({ access_token: `AZ${n}`, ...(withRefresh ? { refresh_token: `RT${n}` } : {}), expires_in: 3600 })
const sfToken = (n: number, userId = USER_ID) => ({ access_token: `SF${n}`, scope: 'api', instance_url: INSTANCE, id: `https://test.salesforce.com/id/${ORG_ID}/${userId}`, token_type: 'Bearer' })
const USER_ROW = { Id: USER_ID, Name: 'Jane Doe', Email: 'j@x.com', Username: 'jane@example.com', TimeZoneSidKey: 'UTC', Profile: { Name: 'Admin' }, UserRole: null }
const USER_QUERY = 'GET /query?q=SELECT%20Id%2C%20Name%2C%20Email'
const expired = [{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qn-svc-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup() {
  const f = fakeFetch()
  const stores = {
    settings: new SettingsStore(join(dir, 'settings.json')),
    secrets: new SecretsStore(join(dir, 'secrets.bin'), fakeEncryptor),
    history: new HistoryStore(join(dir, 'history')),
    meta: new MetaCache(join(dir, 'meta'))
  }
  let time = 1_000_000
  const authorize = vi.fn(async (o: AuthorizeOptions) => {
    const state = new URL(o.url).searchParams.get('state')
    return `${o.redirectUri}?code=AUTH_CODE&state=${state}`
  })
  const deps = {
    ...stores,
    fetchFn: f.fetchFn,
    authorize,
    clock: () => time,
    now: (() => {
      let t = 0
      return () => (t += 25)
    })()
  }
  return { f, deps, stores, service: new AppService(deps), advance: (ms: number) => (time += ms) }
}

async function loggedIn() {
  const ctx = setup()
  const env = await ctx.service.saveEnvironment(null, ENV_INPUT)
  ctx.f.once(`POST ${AZURE_TOKEN_URL}`, json(azureToken(1)))
  ctx.f.once('GET /salesforce/token', json(sfToken(1)))
  ctx.f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
  await ctx.service.login(env.id)
  ctx.f.requests.length = 0
  return { ...ctx, env }
}

describe('environments', () => {
  it('validates and trims every field', async () => {
    const { service } = setup()
    await expect(service.saveEnvironment(null, { ...ENV_INPUT, authUrl: 'http://evil.example' })).rejects.toBeInstanceOf(ConfigError)
    await expect(service.saveEnvironment(null, { ...ENV_INPUT, redirectUri: 'not a url' })).rejects.toBeInstanceOf(ConfigError)
    await expect(service.saveEnvironment(null, { ...ENV_INPUT, scope: '  ' })).rejects.toThrow(/Scope/)
    const env = await service.saveEnvironment(null, { ...ENV_INPUT, clientId: ' CID ', scope: ' a   b ' })
    expect(env).toMatchObject({ clientId: 'CID', scope: 'a b', redirectUri: ENV_INPUT.redirectUri })
    expect((await service.getSettings()).environments).toEqual([env])
  })

  it('allows plain http only for local mock servers', async () => {
    const { service } = setup()
    await expect(service.saveEnvironment(null, { ...ENV_INPUT, sfTokenUrl: 'http://127.0.0.1:8787/salesforce/token' })).resolves.toBeTruthy()
    await expect(service.saveEnvironment(null, { ...ENV_INPUT, sfTokenUrl: 'http://example.com/x' })).rejects.toBeInstanceOf(ConfigError)
  })

  it('keeps the client secret when undefined, clears it when empty', async () => {
    const { service } = setup()
    const env = await service.saveEnvironment(null, { ...ENV_INPUT, clientSecret: 'S' })
    expect((await service.getSettings()).envHasSecret[env.id]).toBe(true)
    await service.saveEnvironment(env.id, { ...ENV_INPUT, name: 'Renamed' })
    expect((await service.getSettings()).envHasSecret[env.id]).toBe(true)
    await service.saveEnvironment(env.id, { ...ENV_INPUT, clientSecret: '' })
    expect((await service.getSettings()).envHasSecret[env.id]).toBe(false)
  })

  it('validates the model and stores the OpenAI key', async () => {
    const { service } = setup()
    await expect(service.setAppSettings({ openAiModel: ' ' })).rejects.toBeInstanceOf(ConfigError)
    await service.setAppSettings({ openAiModel: 'gpt-4.1' })
    await service.setOpenAiKey(' sk-1 ')
    expect(await service.getSettings()).toMatchObject({ openAiModel: 'gpt-4.1', hasOpenAiKey: true })
  })

  it('exports configuration without ids or secrets', async () => {
    const { service } = setup()
    const env = await service.saveEnvironment(null, { ...ENV_INPUT, clientSecret: 'TOP-SECRET' })
    const file = await service.buildEnvironmentFile([env.id])
    const { loginUrl: _unused, instanceUrl: _unused2, ...azureOnly } = ENV_INPUT
    expect(file).toEqual({ format: 'querynator-environments', version: 1, environments: [azureOnly] })
    expect(JSON.stringify(file)).not.toContain('TOP-SECRET')
    await expect(service.buildEnvironmentFile(['nope'])).rejects.toBeInstanceOf(ConfigError)
  })

  it('imports files, bare objects and arrays; same name updates', async () => {
    const { service } = setup()
    const existing = await service.saveEnvironment(null, ENV_INPUT)
    const imported = await service.importEnvironments({
      format: 'querynator-environments',
      version: 1,
      environments: [
        { ...ENV_INPUT, name: 'uat', clientId: 'NEW' },
        { ...ENV_INPUT, name: 'PROD' }
      ]
    })
    expect(imported.map((e) => e.name)).toEqual(['uat', 'PROD'])
    expect(imported[0].id).toBe(existing.id)
    const envs = (await service.getSettings()).environments
    expect(envs).toHaveLength(2)
    expect(envs[0].clientId).toBe('NEW')
    expect(await service.importEnvironments({ ...ENV_INPUT, name: 'Single' })).toHaveLength(1)
    expect(await service.importEnvironments([{ ...ENV_INPUT, name: 'A1' }])).toHaveLength(1)
  })

  it('rejects invalid imports atomically', async () => {
    const { service } = setup()
    await expect(service.importEnvironments({ environments: [{ ...ENV_INPUT, name: 'Ok' }, { ...ENV_INPUT, tokenUrl: '' }] })).rejects.toThrow(
      /Environment #2: Token URL/
    )
    await expect(service.importEnvironments({ environments: [] })).rejects.toThrow(/no environments/)
    expect((await service.getSettings()).environments).toEqual([])
  })

  it('the committed mock environment file imports cleanly', async () => {
    const { service } = setup()
    const envs = await service.importEnvironments(JSON.parse(await readFile('scripts/mock-environment.json', 'utf8')))
    expect(envs.map((e) => [e.name, e.authType])).toEqual([
      ['Mock org', 'azure'],
      ['Mock SF OAuth', 'salesforce'],
      ['Mock token', 'token']
    ])
  })

  it('infers the auth type of environments saved before auth types existed', async () => {
    const { stores, service } = setup()
    const { authType: _a, loginUrl: _l, instanceUrl: _i, ...legacyAzure } = ENV_INPUT
    await stores.settings.update((s) => ({
      ...s,
      environments: [
        { id: 'az', ...legacyAzure } as never,
        { id: 'sf', name: 'Old', loginUrl: 'https://login.salesforce.com', clientId: 'x', apiVersion: '62.0' } as never,
        { id: 'junk', name: 'Nothing' } as never
      ]
    }))
    const envs = (await service.getSettings()).environments
    expect(envs.map((e) => [e.id, e.authType])).toEqual([
      ['az', 'azure'],
      ['sf', 'salesforce']
    ])
    expect(envs[1].redirectUri).toBe('http://localhost:1717/oauth/callback')
  })

  it('imports files exported before auth types existed as Azure environments', async () => {
    const { service } = setup()
    const { authType: _a, loginUrl: _l, instanceUrl: _i, ...legacyAzure } = ENV_INPUT
    const [env] = await service.importEnvironments({ format: 'querynator-environments', version: 1, environments: [legacyAzure] })
    expect(env.authType).toBe('azure')
  })
})

describe('login', () => {
  it('signs in to Azure, exchanges for a Salesforce token and returns the user', async () => {
    const { f, deps, stores, service } = setup()
    const env = await service.saveEnvironment(null, ENV_INPUT)
    f.once(`POST ${AZURE_TOKEN_URL}`, json(azureToken(1)))
    f.once('GET /salesforce/token', json(sfToken(1)))
    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))

    const session = await service.login(env.id)

    expect(session).toEqual({
      accounts: [{ id: USER_ID, name: 'Jane Doe', username: 'jane@example.com', needsLogin: false }],
      activeAccountId: USER_ID,
      state: {
        status: 'connected',
        user: { id: USER_ID, name: 'Jane Doe', email: 'j@x.com', username: 'jane@example.com', profileName: 'Admin', roleName: null, timeZone: 'UTC', orgId: ORG_ID, instanceUrl: INSTANCE }
      }
    })
    const opts = deps.authorize.mock.calls[0][0]
    expect(opts.redirectUri).toBe(ENV_INPUT.redirectUri)
    expect(new URL(opts.url).searchParams.get('code_challenge_method')).toBe('S256')
    expect(Object.fromEntries(new URLSearchParams(f.requests[0].body))).toMatchObject({ grant_type: 'authorization_code', code: 'AUTH_CODE', client_id: 'CID' })
    expect(f.requests[1]).toMatchObject({ url: SF_TOKEN_URL, headers: { authorization: 'Bearer AZ1' } })
    expect(f.requests[2].url.startsWith(`${INSTANCE}/services/data/v62.0/query`)).toBe(true)
    expect(f.requests[2].headers.authorization).toBe('Bearer SF1')
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ azureRefreshToken: 'RT1', accessToken: 'SF1', name: 'Jane Doe' })
  })

  it('propagates sign-in errors', async () => {
    const { deps, service } = setup()
    const env = await service.saveEnvironment(null, ENV_INPUT)
    deps.authorize.mockImplementationOnce(async (o) => `${o.redirectUri}?error=access_denied&error_description=denied`)
    await expect(service.login(env.id)).rejects.toMatchObject({ code: 'access_denied' })
    deps.authorize.mockRejectedValueOnce(new OAuthError('CANCELLED', 'closed'))
    await expect(service.login(env.id)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

describe('multiple users', () => {
  const OTHER_ID = '0059M00000OtherAAB'
  const OTHER_ROW = { ...USER_ROW, Id: OTHER_ID, Name: 'Adam Other', Username: 'adam@example.com' }

  async function withTwoUsers() {
    const ctx = await loggedIn()
    ctx.f.once(`POST ${AZURE_TOKEN_URL}`, json({ access_token: 'AZ-B', refresh_token: 'RT-B', expires_in: 3600 }))
    ctx.f.once('GET /salesforce/token', json({ ...sfToken(9, OTHER_ID), access_token: 'SF-B' }))
    ctx.f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [OTHER_ROW] }))
    const session = await ctx.service.login(ctx.env.id)
    ctx.f.requests.length = 0
    return { ...ctx, session }
  }

  it('adding a user keeps both, each with its own tokens, and activates the new one', async () => {
    const { session, stores, env } = await withTwoUsers()
    expect(session.accounts.map((a) => a.name)).toEqual(['Adam Other', 'Jane Doe'])
    expect(session.activeAccountId).toBe(OTHER_ID)
    expect(session.state).toMatchObject({ status: 'connected', user: { name: 'Adam Other' } })
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ azureRefreshToken: 'RT1', accessToken: 'SF1' })
    expect(await stores.secrets.getAccount(env.id, OTHER_ID)).toMatchObject({ azureRefreshToken: 'RT-B', accessToken: 'SF-B' })
  })

  it('queries run as the active user; switching changes the token used', async () => {
    const { f, service, env } = await withTwoUsers()
    f.once('GET /query?q=SELECT%20Id%20FROM', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(f.requests[0].headers.authorization).toBe('Bearer SF-B')

    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    const switched = await service.switchAccount(env.id, USER_ID)
    expect(switched.state).toMatchObject({ status: 'connected', user: { name: 'Jane Doe' } })
    f.once('GET /query?q=SELECT%20Id%20FROM', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(f.requests.at(-1)!.headers.authorization).toBe('Bearer SF1')
    await expect(service.switchAccount(env.id, 'nope')).rejects.toBeInstanceOf(ConfigError)
  })

  it('logging in again as an existing user updates it instead of duplicating', async () => {
    const { f, service, env } = await withTwoUsers()
    f.once(`POST ${AZURE_TOKEN_URL}`, json(azureToken(5)))
    f.once('GET /salesforce/token', json(sfToken(5)))
    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    const session = await service.login(env.id)
    expect(session.accounts).toHaveLength(2)
    expect(session.activeAccountId).toBe(USER_ID)
  })

  it('logout removes only the active user', async () => {
    const { service, env } = await withTwoUsers()
    const session = await service.logout(env.id)
    expect(session.accounts.map((a) => a.id)).toEqual([USER_ID])
    expect(session.activeAccountId).toBeNull()
  })

  it('users are per environment', async () => {
    const { service } = await withTwoUsers()
    const other = await service.saveEnvironment(null, { ...ENV_INPUT, name: 'PROD' })
    expect(await service.connect(other.id)).toEqual({ accounts: [], activeAccountId: null, state: { status: 'loggedOut' } })
  })
})

describe('token renewal', () => {
  it('reconnects silently with the stored Salesforce token', async () => {
    const { f, service, env } = await loggedIn()
    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    expect((await service.connect(env.id)).state.status).toBe('connected')
    expect(f.requests).toHaveLength(1)
  })

  it('on a Salesforce 401 fetches a new Salesforce token with the still-valid Azure token', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', json(expired, 401))
    f.once('GET /salesforce/token', json(sfToken(2)))
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(f.requests.map((r) => r.url.split('?')[0])).toEqual([
      `${INSTANCE}/services/data/v62.0/query`,
      'https://api.example.com/salesforce/token',
      `${INSTANCE}/services/data/v62.0/query`
    ])
    expect(f.requests[1].headers.authorization).toBe('Bearer AZ1')
    expect(f.requests[2].headers.authorization).toBe('Bearer SF2')
  })

  it('refreshes an expired Azure token first, keeping the refresh token if none is returned', async () => {
    const { f, service, stores, env, advance } = await loggedIn()
    advance(2 * 3600 * 1000)
    f.once('GET /query', json(expired, 401))
    f.once(`POST ${AZURE_TOKEN_URL}`, json(azureToken(2, false)))
    f.once('GET /salesforce/token', json(sfToken(2)))
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(Object.fromEntries(new URLSearchParams(f.requests[1].body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT1' })
    expect(f.requests[2].headers.authorization).toBe('Bearer AZ2')
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ azureAccessToken: 'AZ2', azureRefreshToken: 'RT1', accessToken: 'SF2' })
  })

  it('forces an Azure refresh when the token service rejects the Azure token', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', json(expired, 401))
    f.once('GET /salesforce/token', new Response('', { status: 401 }))
    f.once(`POST ${AZURE_TOKEN_URL}`, json(azureToken(2)))
    f.once('GET /salesforce/token', json(sfToken(2)))
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(f.requests[3].headers.authorization).toBe('Bearer AZ2')
  })

  it('logs out when the Azure refresh token is no longer valid', async () => {
    const { f, service, stores, env, advance } = await loggedIn()
    advance(2 * 3600 * 1000)
    f.once(USER_QUERY, json(expired, 401))
    f.once(`POST ${AZURE_TOKEN_URL}`, json({ error: 'invalid_grant', error_description: 'expired' }, 400))
    expect(await service.connect(env.id)).toEqual({
      accounts: [{ id: USER_ID, name: 'Jane Doe', username: 'jane@example.com', needsLogin: true }],
      activeAccountId: USER_ID,
      state: { status: 'loggedOut' }
    })
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toEqual({ name: 'Jane Doe', username: 'jane@example.com' })
  })

  it('is logged out without tokens', async () => {
    const { service } = setup()
    const env = await service.saveEnvironment(null, ENV_INPUT)
    expect(await service.connect(env.id)).toEqual({ accounts: [], activeAccountId: null, state: { status: 'loggedOut' } })
  })
})

describe('queries', () => {
  it('runs a query and records history', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', json({ totalSize: 2, done: true, records: [{ Id: '1' }, { Id: '2' }] }))
    const r = await service.runQuery(env.id, '  SELECT Id FROM Account ', false)
    expect(r).toEqual({ result: { totalSize: 2, done: true, records: [{ Id: '1' }, { Id: '2' }] }, durationMs: 25 })
    expect(await service.getHistory(env.id)).toMatchObject([{ query: 'SELECT Id FROM Account', rowCount: 2, durationMs: 25 }])
  })

  it('records failures in history and rethrows', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', json([{ errorCode: 'MALFORMED_QUERY', message: 'bad' }], 400))
    await expect(service.runQuery(env.id, 'SELECT', false)).rejects.toBeInstanceOf(SalesforceApiError)
    expect(await service.getHistory(env.id)).toMatchObject([{ query: 'SELECT', rowCount: null, error: 'bad' }])
  })

  it('cancels a running query without recording it', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', () => new Promise<Response>(() => undefined))
    const running = service.runQuery(env.id, 'SELECT Id FROM Account', false)
    await new Promise((r) => setTimeout(r, 10))
    await service.cancelQuery()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(await service.getHistory(env.id)).toEqual([])
  })

  it('rejects empty queries, including comment-only ones', async () => {
    const { service, env } = await loggedIn()
    await expect(service.runQuery(env.id, '   ', false)).rejects.toBeInstanceOf(ConfigError)
    await expect(service.runQuery(env.id, '// SELECT Id FROM Account', false)).rejects.toBeInstanceOf(ConfigError)
  })

  it('blanks // comment lines before sending but keeps them in history', async () => {
    const { f, service, env } = await loggedIn()
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    const text = '// note\nSELECT Id\n// , Name\nFROM Account'
    await service.runQuery(env.id, text, false)
    const sent = new URL(f.requests[0].url).searchParams.get('q')
    expect(sent).toBe('       \nSELECT Id\n         \nFROM Account')
    expect(sent).not.toContain('//')
    expect((await service.getHistory(env.id))[0].query).toBe(text)
  })
})

describe('metadata', () => {
  it('caches describes on disk', async () => {
    const { f, service, env } = await loggedIn()
    const describe = { name: 'Account', label: 'Account', fields: [], childRelationships: [] }
    f.once('GET /sobjects/Account/describe', json(describe))
    await service.describeSObject(env.id, 'Account')
    await service.describeSObject(env.id, 'account')
    expect(f.requests).toHaveLength(1)
    await service.clearMetadata(env.id)
    f.once('GET /sobjects/Account/describe', json(describe))
    await service.describeSObject(env.id, 'Account')
    expect(f.requests).toHaveLength(2)
  })
})

describe('fixQuery', () => {
  it('requires an OpenAI key', async () => {
    const { service, env } = await loggedIn()
    await expect(service.fixQuery(env.id, 'SELECT Id FROM Account', null)).rejects.toThrow(/OpenAI API key/)
  })

  it('sends the FROM object fields to OpenAI', async () => {
    const { f, service, env } = await loggedIn()
    await service.setOpenAiKey('sk-1')
    f.once('GET /sobjects/Account/describe', json({
      name: 'Account',
      label: 'Account',
      fields: [{ name: 'Name', label: 'Name', type: 'string', referenceTo: [], picklistValues: [] }],
      childRelationships: []
    }))
    f.once('POST /chat/completions', json({ choices: [{ message: { content: '{"query":"SELECT Name FROM Account","explanation":"x"}' } }] }))
    const r = await service.fixQuery(env.id, '// my note\nSELECT Nme FROM Account', 'No such column')
    expect(r.query).toBe('SELECT Name FROM Account')
    const body = JSON.parse(f.requests.at(-1)!.body!)
    expect(body.model).toBe('gpt-4o')
    expect(body.messages[1].content).toContain('Name (string)')
    expect(body.messages[1].content).not.toContain('my note')
  })
})

describe('logout and delete', () => {
  it('logout removes the active user but keeps the client secret', async () => {
    const { service, stores, env } = await loggedIn()
    await stores.secrets.setClientSecret(env.id, 'S')
    expect(await service.logout(env.id)).toEqual({ accounts: [], activeAccountId: null, state: { status: 'loggedOut' } })
    expect(await stores.secrets.getEnv(env.id)).toEqual({ clientSecret: 'S', accounts: {} })
    expect((await service.connect(env.id)).state).toEqual({ status: 'loggedOut' })
  })

  it('deleting an environment removes everything', async () => {
    const { f, service, stores, env } = await loggedIn()
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    await service.deleteEnvironment(env.id)
    const settings = await service.getSettings()
    expect(settings.environments).toEqual([])
    expect(settings.lastEnvironmentId).toBeNull()
    expect(await stores.secrets.getEnv(env.id)).toEqual({ accounts: {} })
    expect(await service.getHistory(env.id)).toEqual([])
  })
})

describe('Salesforce OAuth environments', () => {
  const LOGIN = 'https://login.salesforce.com'
  const SF_ENV: EnvironmentConfig = {
    name: 'Prod',
    authType: 'salesforce',
    loginUrl: `${LOGIN}/`,
    instanceUrl: '',
    authUrl: 'ignored',
    tokenUrl: '',
    clientId: 'CONSUMER_KEY',
    scope: '',
    redirectUri: 'http://localhost:1717/oauth/callback',
    sfTokenUrl: '',
    apiVersion: '62.0'
  }
  const grant = (n: number, withRefresh = true) => ({
    access_token: `OA${n}`,
    ...(withRefresh ? { refresh_token: `ORT${n}` } : {}),
    instance_url: INSTANCE,
    id: `${LOGIN}/id/${ORG_ID}/${USER_ID}`
  })

  async function sfLoggedIn() {
    const ctx = setup()
    const env = await ctx.service.saveEnvironment(null, SF_ENV)
    ctx.f.once(`POST ${LOGIN}/services/oauth2/token`, json(grant(1)))
    ctx.f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    const session = await ctx.service.login(env.id)
    return { ...ctx, env, session }
  }

  it('validates only the Salesforce fields and blanks the Azure ones', async () => {
    const { service } = setup()
    const env = await service.saveEnvironment(null, SF_ENV)
    expect(env).toMatchObject({ authType: 'salesforce', loginUrl: LOGIN, authUrl: '', clientId: 'CONSUMER_KEY' })
    await expect(service.saveEnvironment(null, { ...SF_ENV, loginUrl: 'login.salesforce.com' })).rejects.toThrow(/Login URL/)
    await expect(service.saveEnvironment(null, { ...SF_ENV, clientId: '' })).rejects.toThrow(/Consumer Key/)
    const file = await service.buildEnvironmentFile([env.id])
    expect(file.environments[0]).toEqual({
      name: 'Prod',
      authType: 'salesforce',
      loginUrl: LOGIN,
      clientId: 'CONSUMER_KEY',
      redirectUri: 'http://localhost:1717/oauth/callback',
      apiVersion: '62.0'
    })
  })

  it('logs in with the authorization code + PKCE and stores the refresh token', async () => {
    const { f, deps, stores, env, session } = await sfLoggedIn()
    const url = new URL(deps.authorize.mock.calls[0][0].url)
    expect(url.origin + url.pathname).toBe(`${LOGIN}/services/oauth2/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'CONSUMER_KEY',
      redirect_uri: 'http://localhost:1717/oauth/callback',
      code_challenge_method: 'S256',
      prompt: 'login'
    })
    expect(Object.fromEntries(new URLSearchParams(f.requests[0].body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'AUTH_CODE',
      client_id: 'CONSUMER_KEY',
      redirect_uri: 'http://localhost:1717/oauth/callback'
    })
    expect(new URLSearchParams(f.requests[0].body).get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(f.requests[1].headers.authorization).toBe('Bearer OA1')
    expect(session.state).toMatchObject({ status: 'connected', user: { name: 'Jane Doe', orgId: ORG_ID, instanceUrl: INSTANCE } })
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ accessToken: 'OA1', refreshToken: 'ORT1', instanceUrl: INSTANCE })
  })

  it('refreshes the access token on a 401, keeping the refresh token when none is returned', async () => {
    const { f, service, stores, env } = await sfLoggedIn()
    f.requests.length = 0
    f.once('GET /query', json(expired, 401))
    f.once(`POST ${LOGIN}/services/oauth2/token`, json(grant(2, false)))
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await service.runQuery(env.id, 'SELECT Id FROM Account', false)
    expect(Object.fromEntries(new URLSearchParams(f.requests[1].body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'ORT1', client_id: 'CONSUMER_KEY' })
    expect(f.requests[2].headers.authorization).toBe('Bearer OA2')
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ accessToken: 'OA2', refreshToken: 'ORT1' })
  })

  it('logs out when the refresh token is revoked', async () => {
    const { f, service, env } = await sfLoggedIn()
    f.once(USER_QUERY, json(expired, 401))
    f.once(`POST ${LOGIN}/services/oauth2/token`, json({ error: 'invalid_grant', error_description: 'expired access/refresh token' }, 400))
    const session = await service.connect(env.id)
    expect(session.state).toEqual({ status: 'loggedOut' })
    expect(session.accounts[0].needsLogin).toBe(true)
  })

  it('logout revokes the refresh token', async () => {
    const { f, service, env } = await sfLoggedIn()
    f.requests.length = 0
    f.once(`POST ${LOGIN}/services/oauth2/revoke`, new Response(null, { status: 200 }))
    expect((await service.logout(env.id)).accounts).toEqual([])
    expect(new URLSearchParams(f.requests[0].body).get('token')).toBe('ORT1')
  })

  it('sends the client secret when one is configured', async () => {
    const { f, service } = setup()
    const env = await service.saveEnvironment(null, { ...SF_ENV, clientSecret: 'SECRET' })
    f.once(`POST ${LOGIN}/services/oauth2/token`, json(grant(1)))
    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    await service.login(env.id)
    expect(new URLSearchParams(f.requests[0].body).get('client_secret')).toBe('SECRET')
  })
})

describe('pasted access token environments', () => {
  const TOKEN_ENV: EnvironmentConfig = {
    name: 'Dev',
    authType: 'token',
    loginUrl: 'ignored',
    instanceUrl: `${INSTANCE}/`,
    authUrl: '',
    tokenUrl: '',
    clientId: '',
    scope: '',
    redirectUri: '',
    sfTokenUrl: '',
    apiVersion: '62.0'
  }

  async function tokenLoggedIn() {
    const ctx = setup()
    const env = await ctx.service.saveEnvironment(null, TOKEN_ENV)
    ctx.f.once('GET /services/oauth2/userinfo', json({ user_id: USER_ID, organization_id: ORG_ID }))
    ctx.f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    const session = await ctx.service.login(env.id, ' PASTED ')
    return { ...ctx, env, session }
  }

  it('needs only name, instance URL and API version', async () => {
    const { service } = setup()
    const env = await service.saveEnvironment(null, TOKEN_ENV)
    expect(env).toMatchObject({ authType: 'token', instanceUrl: INSTANCE, loginUrl: '', clientId: '', redirectUri: '' })
    await expect(service.saveEnvironment(null, { ...TOKEN_ENV, instanceUrl: 'acme.my.salesforce.com' })).rejects.toThrow(/Instance URL/)
    expect((await service.buildEnvironmentFile([env.id])).environments[0]).toEqual({ name: 'Dev', authType: 'token', instanceUrl: INSTANCE, apiVersion: '62.0' })
  })

  it('identifies the user of a pasted token and uses it without any login flow', async () => {
    const { f, deps, stores, env, session } = await tokenLoggedIn()
    expect(deps.authorize).not.toHaveBeenCalled()
    expect(f.requests[0]).toMatchObject({ url: `${INSTANCE}/services/oauth2/userinfo`, headers: { authorization: 'Bearer PASTED' } })
    expect(session.state).toMatchObject({ status: 'connected', user: { name: 'Jane Doe', orgId: ORG_ID, instanceUrl: INSTANCE } })
    expect(await stores.secrets.getAccount(env.id, USER_ID)).toMatchObject({ accessToken: 'PASTED', instanceUrl: INSTANCE })
  })

  it('falls back to the Chatter "me" resource when userinfo is not allowed', async () => {
    const { f, service } = setup()
    const env = await service.saveEnvironment(null, TOKEN_ENV)
    f.once('GET /services/oauth2/userinfo', json({ error: 'insufficient_scope' }, 403))
    f.once('GET /chatter/users/me', json({ id: USER_ID }))
    f.once('GET /query?q=SELECT%20Id%20FROM%20Organization', json({ totalSize: 1, done: true, records: [{ Id: ORG_ID }] }))
    f.once(USER_QUERY, json({ totalSize: 1, done: true, records: [USER_ROW] }))
    const session = await service.login(env.id, 'SESSION_ID')
    expect(session.state).toMatchObject({ status: 'connected', user: { orgId: ORG_ID } })
  })

  it('rejects an invalid token and requires one', async () => {
    const { f, service } = setup()
    const env = await service.saveEnvironment(null, TOKEN_ENV)
    f.once('GET /services/oauth2/userinfo', new Response('Bad_OAuth_Token', { status: 401 }))
    await expect(service.login(env.id, 'BAD')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(service.login(env.id, '  ')).rejects.toBeInstanceOf(ConfigError)
  })

  it('an expired token marks the user as needing a new one (no refresh)', async () => {
    const { f, service, env } = await tokenLoggedIn()
    f.once(USER_QUERY, json(expired, 401))
    const session = await service.connect(env.id)
    expect(session.state).toEqual({ status: 'loggedOut' })
    expect(session.accounts[0].needsLogin).toBe(true)
  })
})
