import { create } from 'zustand'
import type { AccountSummary, AppError, EnvSession, HistoryEntry, SettingsView, SfRecord, UserInfo } from '../../shared/types'

export type ConnectionStatus = 'none' | 'loggedOut' | 'connecting' | 'loggingIn' | 'connected'

export interface ResultState {
  records: SfRecord[]
  totalSize: number
  nextRecordsUrl?: string
  durationMs: number
}

interface State {
  settings: SettingsView | null
  envId: string | null
  status: ConnectionStatus
  user: UserInfo | null
  /** Users who have logged in to the current environment */
  accounts: AccountSummary[]
  activeAccountId: string | null
  query: string
  queryAll: boolean
  running: boolean
  loadingMore: boolean
  result: ResultState | null
  error: AppError | null
  /** Last Salesforce/parser error for the current query text; sent to the AI helper. */
  queryError: string | null
  history: HistoryEntry[]
  notice: string | null
  settingsOpen: boolean
  aiOpen: boolean
  /** Bumped to drop the renderer metadata cache. */
  metadataVersion: number
  tab: 'query' | 'objects'
  /** Object shown in the Objects tab */
  explorerObject: string | null
}

interface Actions {
  init(): Promise<void>
  refreshSettings(): Promise<void>
  selectEnv(id: string | null): Promise<void>
  login(): Promise<void>
  cancelLogin(): Promise<void>
  logout(): Promise<void>
  switchAccount(accountId: string): Promise<void>
  run(): Promise<void>
  loadMore(): Promise<void>
  cancel(): Promise<void>
  refreshHistory(): Promise<void>
  clearMetadata(): Promise<void>
  setQuery(q: string): void
  /** Replace the editor text from elsewhere (history, AI); forgets the previous query's error. */
  loadQuery(q: string): void
  setQueryAll(v: boolean): void
  setQueryError(e: string | null): void
  dismissError(): void
  notify(msg: string): void
  setSettingsOpen(open: boolean): void
  setAiOpen(open: boolean): void
  setTab(tab: State['tab']): void
  setExplorerObject(name: string | null): void
}

const INITIAL_QUERY = 'SELECT Id, Name\nFROM Account\nLIMIT 10'

let noticeTimer: ReturnType<typeof setTimeout> | undefined

export const useStore = create<State & Actions>((set, get) => {
  /** Common error handling: an expired session flips the UI to logged out. */
  const fail = (error: AppError) => {
    if (error.kind === 'cancelled') return
    if (error.kind === 'auth' && error.code === 'SESSION_EXPIRED') set({ status: 'loggedOut', user: null })
    set({ error })
  }

  const applySession = (s: EnvSession) =>
    set({
      accounts: s.accounts,
      activeAccountId: s.activeAccountId,
      ...(s.state.status === 'connected' ? { status: 'connected', user: s.state.user } : { status: 'loggedOut', user: null })
    })

  return {
    settings: null,
    envId: null,
    status: 'none',
    user: null,
    accounts: [],
    activeAccountId: null,
    query: INITIAL_QUERY,
    queryAll: false,
    running: false,
    loadingMore: false,
    result: null,
    error: null,
    queryError: null,
    history: [],
    notice: null,
    settingsOpen: false,
    aiOpen: false,
    metadataVersion: 0,
    tab: 'query',
    explorerObject: null,

    async init() {
      await get().refreshSettings()
      const s = get().settings
      if (!s || s.environments.length === 0) {
        set({ settingsOpen: true })
        return
      }
      const id = s.environments.some((e) => e.id === s.lastEnvironmentId) ? s.lastEnvironmentId : s.environments[0].id
      await get().selectEnv(id)
    },

    async refreshSettings() {
      const r = await window.api.getSettings()
      if (r.ok) {
        set({ settings: r.value })
        const { envId } = get()
        if (envId && !r.value.environments.some((e) => e.id === envId)) await get().selectEnv(r.value.environments[0]?.id ?? null)
      } else fail(r.error)
    },

    async selectEnv(id) {
      set({ envId: id, user: null, accounts: [], activeAccountId: null, result: null, error: null, history: [], explorerObject: null, status: id ? 'connecting' : 'none' })
      if (!id) return
      void get().refreshHistory()
      const r = await window.api.connect(id)
      if (get().envId !== id) return
      if (r.ok) applySession(r.value)
      else {
        set({ status: 'loggedOut' })
        fail(r.error)
      }
    },

    async login() {
      const { envId } = get()
      if (!envId) return
      // Adding another user may be cancelled: then the current user stays connected.
      const previous = { status: get().status, user: get().user }
      set({ status: 'loggingIn', error: null })
      const r = await window.api.login(envId)
      if (get().envId !== envId) return
      if (r.ok) {
        if (r.value.activeAccountId !== get().activeAccountId) set({ result: null })
        applySession(r.value)
      } else {
        set(previous.status === 'connected' ? previous : { status: 'loggedOut', user: null })
        fail(r.error)
      }
    },

    async cancelLogin() {
      await window.api.cancelLogin()
    },

    async logout() {
      const { envId } = get()
      if (!envId) return
      const r = await window.api.logout(envId)
      if (r.ok) applySession(r.value)
      else {
        set({ status: 'loggedOut', user: null })
        fail(r.error)
      }
      set({ result: null })
    },

    async switchAccount(accountId) {
      const { envId, activeAccountId } = get()
      if (!envId || accountId === activeAccountId) return
      set({ status: 'connecting', user: null, result: null, error: null, activeAccountId: accountId })
      const r = await window.api.switchAccount(envId, accountId)
      if (get().envId !== envId) return
      if (r.ok) applySession(r.value)
      else {
        set({ status: 'loggedOut' })
        fail(r.error)
      }
    },

    async run() {
      const { envId, query, queryAll, status, running } = get()
      if (!envId || running) return
      if (status !== 'connected') {
        set({ error: { kind: 'auth', message: 'Log in to run queries.' } })
        return
      }
      set({ running: true, error: null })
      const r = await window.api.runQuery(envId, query, queryAll)
      if (get().envId !== envId) return
      set({ running: false })
      if (r.ok) {
        const { result, durationMs } = r.value
        set({ result: { records: result.records, totalSize: result.totalSize, nextRecordsUrl: result.nextRecordsUrl, durationMs }, queryError: null })
      } else {
        if (r.error.kind === 'salesforce') set({ queryError: r.error.message })
        fail(r.error)
      }
      void get().refreshHistory()
    },

    async loadMore() {
      const { envId, result, loadingMore } = get()
      if (!envId || !result?.nextRecordsUrl || loadingMore) return
      set({ loadingMore: true, error: null })
      const r = await window.api.queryMore(envId, result.nextRecordsUrl)
      set({ loadingMore: false })
      if (r.ok && get().result === result) {
        set({
          result: {
            ...result,
            records: [...result.records, ...r.value.result.records],
            nextRecordsUrl: r.value.result.nextRecordsUrl,
            durationMs: result.durationMs + r.value.durationMs
          }
        })
      } else if (!r.ok) fail(r.error)
    },

    async cancel() {
      await window.api.cancelQuery()
      set({ running: false, loadingMore: false })
    },

    async refreshHistory() {
      const { envId } = get()
      if (!envId) return
      const r = await window.api.getHistory(envId)
      if (r.ok && get().envId === envId) set({ history: r.value })
    },

    async clearMetadata() {
      const { envId } = get()
      if (!envId) return
      const r = await window.api.clearMetadata(envId)
      if (!r.ok) return fail(r.error)
      set((s) => ({ metadataVersion: s.metadataVersion + 1 }))
      get().notify('Metadata cache cleared. It will reload as you type.')
    },

    setQuery: (query) => set({ query }),
    loadQuery: (query) => set({ query, queryError: null, error: null }),
    setQueryAll: (queryAll) => set({ queryAll }),
    setQueryError: (queryError) => set({ queryError }),
    dismissError: () => set({ error: null }),

    notify(notice) {
      clearTimeout(noticeTimer)
      set({ notice })
      noticeTimer = setTimeout(() => set({ notice: null }), 4000)
    },

    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setAiOpen: (aiOpen) => set({ aiOpen }),
    setTab: (tab) => set({ tab }),
    setExplorerObject: (explorerObject) => set({ explorerObject })
  }
})
