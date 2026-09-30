import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Mutex } from './jsonFile'

/** Subset of Electron's `safeStorage`, injectable for tests. */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** One logged-in user of an environment, keyed by Salesforce user id. */
export interface AccountSecrets {
  /** Display info, refreshed on every connect */
  name?: string
  username?: string
  /** Salesforce access token */
  accessToken?: string
  /** Salesforce OAuth refresh token (auth type `salesforce`) */
  refreshToken?: string
  instanceUrl?: string
  orgId?: string
  azureAccessToken?: string
  azureRefreshToken?: string
  /** ms since epoch, as a string */
  azureExpiresAt?: string
}

export interface EnvSecrets {
  clientSecret?: string
  activeAccountId?: string
  accounts: Record<string, AccountSecrets>
}

interface SecretsData {
  env: Record<string, EnvSecrets>
  openAiKey?: string
}

/** Everything except display info: removed when a session can no longer be renewed. */
const TOKEN_KEYS: (keyof AccountSecrets)[] = ['accessToken', 'refreshToken', 'instanceUrl', 'orgId', 'azureAccessToken', 'azureRefreshToken', 'azureExpiresAt']

/** Earlier versions stored a single session directly on the environment; turn it into an account. */
function normalizeEnv(raw: unknown): EnvSecrets {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.accounts && typeof r.accounts === 'object') return r as unknown as EnvSecrets
  const env: EnvSecrets = { accounts: {} }
  if (typeof r.clientSecret === 'string') env.clientSecret = r.clientSecret
  const userId = r.userId
  if (typeof userId === 'string' && userId) {
    const account: AccountSecrets = {}
    for (const k of TOKEN_KEYS) if (typeof r[k] === 'string') account[k] = r[k] as string
    env.accounts[userId] = account
    env.activeAccountId = userId
  }
  return env
}

export class SecretsStore {
  private mutex = new Mutex()

  constructor(
    private readonly file: string,
    private readonly enc: Encryptor
  ) {}

  private async read(): Promise<SecretsData> {
    let buf: Buffer
    try {
      buf = await readFile(this.file)
    } catch {
      return { env: {} }
    }
    // Undecryptable (e.g. copied from another machine): start fresh rather than crash.
    try {
      const data = JSON.parse(this.enc.decryptString(buf)) as SecretsData
      for (const id of Object.keys(data.env ?? {})) data.env[id] = normalizeEnv(data.env[id])
      return { ...data, env: data.env ?? {} }
    } catch {
      return { env: {} }
    }
  }

  private mutate(fn: (d: SecretsData) => void): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.enc.isEncryptionAvailable()) throw new Error('Secure storage (OS keychain) is not available')
      const data = await this.read()
      fn(data)
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, this.enc.encryptString(JSON.stringify(data)))
    })
  }

  private envOf(d: SecretsData, envId: string): EnvSecrets {
    return (d.env[envId] ??= { accounts: {} })
  }

  async getEnv(envId: string): Promise<EnvSecrets> {
    return (await this.read()).env[envId] ?? { accounts: {} }
  }

  async getAccount(envId: string, accountId: string): Promise<AccountSecrets | null> {
    return (await this.getEnv(envId)).accounts[accountId] ?? null
  }

  setClientSecret(envId: string, secret: string | undefined): Promise<void> {
    return this.mutate((d) => {
      const env = this.envOf(d, envId)
      if (secret) env.clientSecret = secret
      else delete env.clientSecret
    })
  }

  /** Creates the account if needed. Keys set to undefined are removed. */
  updateAccount(envId: string, accountId: string, patch: Partial<Record<keyof AccountSecrets, string | undefined>>): Promise<void> {
    return this.mutate((d) => {
      const env = this.envOf(d, envId)
      const account: AccountSecrets = { ...env.accounts[accountId] }
      for (const [k, v] of Object.entries(patch) as [keyof AccountSecrets, string | undefined][]) {
        if (v === undefined) delete account[k]
        else account[k] = v
      }
      env.accounts[accountId] = account
    })
  }

  /** Forget the session but keep the account in the list (it then needs a new login). */
  clearAccountTokens(envId: string, accountId: string): Promise<void> {
    return this.mutate((d) => {
      const account = d.env[envId]?.accounts[accountId]
      if (account) for (const k of TOKEN_KEYS) delete account[k]
    })
  }

  removeAccount(envId: string, accountId: string): Promise<void> {
    return this.mutate((d) => {
      const env = d.env[envId]
      if (!env) return
      delete env.accounts[accountId]
      if (env.activeAccountId === accountId) delete env.activeAccountId
    })
  }

  setActiveAccount(envId: string, accountId: string | null): Promise<void> {
    return this.mutate((d) => {
      const env = this.envOf(d, envId)
      if (accountId) env.activeAccountId = accountId
      else delete env.activeAccountId
    })
  }

  deleteEnv(envId: string): Promise<void> {
    return this.mutate((d) => {
      delete d.env[envId]
    })
  }

  async getOpenAiKey(): Promise<string | null> {
    return (await this.read()).openAiKey ?? null
  }

  setOpenAiKey(key: string | null): Promise<void> {
    return this.mutate((d) => {
      if (key) d.openAiKey = key
      else delete d.openAiKey
    })
  }
}
