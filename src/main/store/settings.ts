import type { AppSettings } from '../../shared/types'
import { Mutex, readJson, writeJson } from './jsonFile'

export const DEFAULT_SETTINGS: AppSettings = {
  environments: [],
  openAiModel: 'gpt-4o',
  lastEnvironmentId: null
}

export class SettingsStore {
  private mutex = new Mutex()

  constructor(private readonly file: string) {}

  async load(): Promise<AppSettings> {
    const stored = await readJson<Partial<AppSettings> & { callbackPort?: unknown }>(this.file, {})
    const { callbackPort: _legacy, ...rest } = stored
    // Environments from the earlier Salesforce-OAuth version lack the Azure fields and cannot log in.
    const environments = (rest.environments ?? []).filter((e) => typeof e.authUrl === 'string' && typeof e.sfTokenUrl === 'string')
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
