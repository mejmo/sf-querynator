import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, HistoryStore } from '../../src/main/store/history'
import { MetaCache } from '../../src/main/store/metaCache'
import { SecretsStore } from '../../src/main/store/secrets'
import { fakeEncryptor } from './fakeEncryptor'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/store/settings'


let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qn-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('returns defaults, then persists updates', async () => {
    const s = new SettingsStore(join(dir, 'settings.json'))
    expect(await s.load()).toEqual(DEFAULT_SETTINGS)
    await s.update((x) => ({ ...x, openAiModel: 'gpt-x' }))
    expect((await new SettingsStore(join(dir, 'settings.json')).load()).openAiModel).toBe('gpt-x')
  })

  it('serialises concurrent updates', async () => {
    const s = new SettingsStore(join(dir, 'settings.json'))
    await Promise.all(
      [1, 2, 3].map((n) =>
        s.update((x) => ({ ...x, environments: [...x.environments, { id: `${n}`, name: '', authUrl: '', tokenUrl: '', clientId: '', scope: '', redirectUri: '', sfTokenUrl: '', apiVersion: '' }] }))
      )
    )
    expect((await s.load()).environments.map((e) => e.id).sort()).toEqual(['1', '2', '3'])
  })
})

describe('SecretsStore', () => {
  const file = () => join(dir, 'secrets.bin')

  it('encrypts on disk and round-trips accounts and keys', async () => {
    const s = new SecretsStore(file(), fakeEncryptor)
    await s.updateAccount('e1', 'u1', { accessToken: 'AT', name: 'Jane' })
    await s.setClientSecret('e1', 'CS')
    await s.setOpenAiKey('sk-1')
    expect((await readFile(file())).toString().startsWith('enc:')).toBe(true)
    expect(await s.getEnv('e1')).toEqual({ clientSecret: 'CS', accounts: { u1: { accessToken: 'AT', name: 'Jane' } } })
    expect(await s.getOpenAiKey()).toBe('sk-1')
  })

  it('clearAccountTokens keeps the account and its display info', async () => {
    const s = new SecretsStore(file(), fakeEncryptor)
    await s.updateAccount('e1', 'u1', { name: 'Jane', username: 'j@x', accessToken: 'AT', instanceUrl: 'u', orgId: 'o', azureAccessToken: 'AZ', azureRefreshToken: 'RT', azureExpiresAt: '1' })
    await s.clearAccountTokens('e1', 'u1')
    expect(await s.getAccount('e1', 'u1')).toEqual({ name: 'Jane', username: 'j@x' })
  })

  it('tracks the active account and removes accounts', async () => {
    const s = new SecretsStore(file(), fakeEncryptor)
    await s.updateAccount('e1', 'u1', { accessToken: 'A' })
    await s.updateAccount('e1', 'u2', { accessToken: 'B' })
    await s.setActiveAccount('e1', 'u2')
    expect((await s.getEnv('e1')).activeAccountId).toBe('u2')
    await s.removeAccount('e1', 'u2')
    expect(await s.getEnv('e1')).toEqual({ accounts: { u1: { accessToken: 'A' } } })
    await s.updateAccount('e1', 'u1', { accessToken: undefined })
    expect(await s.getAccount('e1', 'u1')).toEqual({})
    await s.deleteEnv('e1')
    expect(await s.getEnv('e1')).toEqual({ accounts: {} })
    await s.setOpenAiKey(null)
    expect(await s.getOpenAiKey()).toBeNull()
  })

  it('migrates the earlier single-session format into an active account', async () => {
    const legacy = { env: { e1: { clientSecret: 'CS', userId: 'u1', accessToken: 'AT', instanceUrl: 'i', orgId: 'o', azureRefreshToken: 'RT' } } }
    await writeFile(file(), fakeEncryptor.encryptString(JSON.stringify(legacy)))
    const s = new SecretsStore(file(), fakeEncryptor)
    expect(await s.getEnv('e1')).toEqual({
      clientSecret: 'CS',
      activeAccountId: 'u1',
      accounts: { u1: { accessToken: 'AT', instanceUrl: 'i', orgId: 'o', azureRefreshToken: 'RT' } }
    })
  })

  it('refuses to write when OS encryption is unavailable', async () => {
    const s = new SecretsStore(file(), { ...fakeEncryptor, isEncryptionAvailable: () => false })
    await expect(s.setOpenAiKey('k')).rejects.toThrow(/Secure storage/)
  })
})

describe('HistoryStore', () => {
  const entry = (query: string) => ({ query, ranAt: '2026-01-01T00:00:00Z', rowCount: 1, durationMs: 5 })

  it('keeps newest first, dedupes and caps', async () => {
    const h = new HistoryStore(join(dir, 'history'))
    await h.add('e1', entry('A'))
    await h.add('e1', entry('B'))
    await h.add('e1', entry(' A '))
    expect((await h.list('e1')).map((e) => e.query)).toEqual([' A ', 'B'])
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await h.add('e1', entry(`Q${i}`))
    const list = await h.list('e1')
    expect(list).toHaveLength(HISTORY_LIMIT)
    expect(list[0].query).toBe(`Q${HISTORY_LIMIT + 4}`)
    expect(await h.list('other')).toEqual([])
  })

  it('deletes an environment history', async () => {
    const h = new HistoryStore(join(dir, 'history'))
    await h.add('e1', entry('A'))
    await h.deleteEnv('e1')
    expect(await h.list('e1')).toEqual([])
  })
})

describe('MetaCache', () => {
  it('stores global and object describes per env, case-insensitively', async () => {
    const m = new MetaCache(join(dir, 'meta'))
    expect(await m.getGlobal('e1')).toBeNull()
    await m.setGlobal('e1', [{ name: 'Account', label: 'Account', queryable: true }])
    await m.setObject('e1', { name: 'Account', label: 'Account', fields: [], childRelationships: [] })
    expect(await m.getGlobal('e1')).toHaveLength(1)
    expect((await m.getObject('e1', 'account'))?.name).toBe('Account')
    await m.clear('e1')
    expect(await m.getObject('e1', 'Account')).toBeNull()
  })

  it('ignores entries written by an older cache version', async () => {
    await mkdir(join(dir, 'meta', 'e1'), { recursive: true })
    await writeFile(join(dir, 'meta', 'e1', 'account.json'), JSON.stringify({ name: 'Account', label: 'Account', fields: [], childRelationships: [] }))
    expect(await new MetaCache(join(dir, 'meta')).getObject('e1', 'Account')).toBeNull()
  })

  it('rejects unsafe object names', async () => {
    const m = new MetaCache(join(dir, 'meta'))
    await expect(m.getObject('e1', '../x')).rejects.toThrow(/Invalid object name/)
  })
})
