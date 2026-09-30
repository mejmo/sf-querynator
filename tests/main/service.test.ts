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
    expect(file).toEqual({ format: 'querynator-environments', version: 1, environments: [ENV_INPUT] })
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
    const [env] = await service.importEnvironments(JSON.parse(await readFile('scripts/mock-environment.json', 'utf8')))
    expect(env.name).toBe('Mock org')
  })

  it('drops legacy Salesforce-OAuth environments on load', async () => {
    const { stores, service } = setup()
    await stores.settings.update((s) => ({
      ...s,
      environments: [{ id: 'old', name: 'Old', loginUrl: 'https://login.salesforce.com', clientId: 'x', apiVersion: '62.0' } as never]
    }))
    expect((await service.getSettings()).environments).toEqual([])
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

  it('rejects empty queries', async () => {
    const { service, env } = await loggedIn()
    await expect(service.runQuery(env.id, '   ', false)).rejects.toBeInstanceOf(ConfigError)
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
    const r = await service.fixQuery(env.id, 'SELECT Nme FROM Account', 'No such column')
    expect(r.query).toBe('SELECT Name FROM Account')
    const body = JSON.parse(f.requests.at(-1)!.body!)
    expect(body.model).toBe('gpt-4o')
    expect(body.messages[1].content).toContain('Name (string)')
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
