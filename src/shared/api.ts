import type {
  AiSuggestion,
  AppSettingsPatch,
  EnvSession,
  Environment,
  EnvironmentFile,
  EnvironmentInput,
  GlobalDescribeEntry,
  HistoryEntry,
  QueryRunResult,
  Result,
  SettingsView,
  SObjectDescribe
} from './types'

/** Exposed to the renderer as `window.api`. Every call resolves to a Result; none reject. */
export interface Api {
  getSettings(): Promise<Result<SettingsView>>
  saveEnvironment(id: string | null, input: EnvironmentInput): Promise<Result<Environment>>
  deleteEnvironment(id: string): Promise<Result<void>>
  setAppSettings(patch: AppSettingsPatch): Promise<Result<void>>
  setOpenAiKey(key: string | null): Promise<Result<void>>
  /** Reconnect the environment's active user (if any) and list its users. */
  connect(envId: string): Promise<Result<EnvSession>>
  /** Sign in (new or existing user); the signed-in user becomes active. Auth type `token` takes the pasted token. */
  login(envId: string, accessToken?: string): Promise<Result<EnvSession>>
  cancelLogin(): Promise<Result<void>>
  switchAccount(envId: string, accountId: string): Promise<Result<EnvSession>>
  /** Forget the active user's tokens and remove it from the list. */
  logout(envId: string): Promise<Result<EnvSession>>
  runQuery(envId: string, soql: string, queryAll: boolean): Promise<Result<QueryRunResult>>
  queryMore(envId: string, nextRecordsUrl: string): Promise<Result<QueryRunResult>>
  cancelQuery(): Promise<Result<void>>
  describeGlobal(envId: string): Promise<Result<GlobalDescribeEntry[]>>
  describeSObject(envId: string, name: string): Promise<Result<SObjectDescribe>>
  clearMetadata(envId: string): Promise<Result<void>>
  getHistory(envId: string): Promise<Result<HistoryEntry[]>>
  fixQuery(envId: string, soql: string, error: string | null): Promise<Result<AiSuggestion>>
  saveFile(defaultName: string, content: string): Promise<Result<boolean>>
  /** Export content for the given environments (configuration only, no secrets or tokens). */
  buildEnvironmentFile(ids: string[]): Promise<Result<EnvironmentFile>>
  /** Create or update environments from parsed export JSON; same name (case-insensitive) updates. */
  importEnvironments(data: unknown): Promise<Result<Environment[]>>
  /** Shows an open dialog and returns the chosen text file's content (null when cancelled). */
  openTextFile(filterName: string, extensions: string[]): Promise<Result<string | null>>
}

export const API_METHODS = [
  'getSettings',
  'saveEnvironment',
  'deleteEnvironment',
  'setAppSettings',
  'setOpenAiKey',
  'connect',
  'login',
  'cancelLogin',
  'switchAccount',
  'logout',
  'runQuery',
  'queryMore',
  'cancelQuery',
  'describeGlobal',
  'describeSObject',
  'clearMetadata',
  'getHistory',
  'fixQuery',
  'saveFile',
  'buildEnvironmentFile',
  'importEnvironments',
  'openTextFile'
] as const satisfies readonly (keyof Api)[]

// Compile error if a method is added to Api but not to API_METHODS.
type MissingMethods = Exclude<keyof Api, (typeof API_METHODS)[number]>
export const API_METHODS_COMPLETE: [MissingMethods] extends [never] ? true : MissingMethods = true

export const IPC_PREFIX = 'qn:'

type Unwrap<T> = T extends Promise<Result<infer V>> ? V : never

/** Methods implemented in ipc.ts because they need native dialogs. */
export type DialogMethods = 'saveFile' | 'openTextFile'

/** What the main-process service implements: same methods, plain values, errors thrown. */
export type ServiceApi = {
  [K in Exclude<keyof Api, DialogMethods>]: (...args: Parameters<Api[K]>) => Promise<Unwrap<ReturnType<Api[K]>>>
}
