import { DEFAULT_SALESFORCE_REDIRECT, type AppSettings, type Environment } from '../../shared/types'
import { Mutex, readJson, writeJson } from './jsonFile'

export const DEFAULT_SETTINGS: AppSettings = {
  environments: [],
  openAiModel: 'gpt-4o',
  lastEnvironmentId: null
}

const STRING_FIELDS = ['loginUrl', 'instanceUrl', 'authUrl', 'tokenUrl', 'clientId', 'scope', 'redirectUri', 'sfTokenUrl', 'apiVersion'] as const

/** Environments saved before auth types existed: Azure ones have an authUrl, Salesforce OAuth ones a loginUrl. */
function upgradeEnvironment(raw: Partial<Environment>): Environment | null {
  const authType = raw.authType ?? (raw.authUrl ? 'azure' : raw.loginUrl ? 'salesforce' : null)
  if (!authType || !raw.id || !raw.name) return null
  const env = { id: raw.id, name: raw.name, authType } as Environment
  for (const k of STRING_FIELDS) env[k] = typeof raw[k] === 'string' ? raw[k] : ''
  if (authType === 'salesforce' && !env.redirectUri) env.redirectUri = DEFAULT_SALESFORCE_REDIRECT
  return env
}

export class SettingsStore {
  private mutex = new Mutex()

  constructor(private readonly file: string) {}

  async load(): Promise<AppSettings> {
    const stored = await readJson<Partial<AppSettings> & { callbackPort?: unknown }>(this.file, {})
    const { callbackPort: _legacy, ...rest } = stored
    const environments = (rest.environments ?? []).map(upgradeEnvironment).filter((e): e is Environment => e !== null)
    return { ...DEFAULT_SETTINGS, ...rest, environments }
  }

  update(fn: (s: AppSettings) => AppSettings): Promise<AppSettings> {
    return this.mutex.run(async () => {
      const next = fn(await this.load())
      await writeJson(this.file, next)
      return next
    })
  }
}
