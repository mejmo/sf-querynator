import mark from '../assets/mark.png'
import { useStore } from '../store'

const ADD_USER = '__add__'

export function EnvironmentBar() {
  const { settings, envId, status, accounts, activeAccountId, selectEnv, login, cancelLogin, logout, switchAccount, clearMetadata, setSettingsOpen } =
    useStore()
  const envs = settings?.environments ?? []
  const busy = status === 'loggingIn' || status === 'connecting'

  const statusLabel = {
    none: 'No environment',
    loggedOut: 'Logged out',
    connecting: 'Connecting…',
    loggingIn: 'Waiting for sign-in…',
    connected: 'Connected'
  }[status]
  const dotClass = status === 'connected' ? 'connected' : busy ? 'busy' : ''

  const onUserChange = (value: string) => {
    if (value === ADD_USER) void login()
    else if (value) void switchAccount(value)
  }

  return (
    <div className="envbar">
      <span className="brand">
        <img src={mark} alt="" />
        Querynator
      </span>
      <select
        value={envId ?? ''}
        onChange={(e) => void selectEnv(e.target.value || null)}
        disabled={envs.length === 0 || status === 'loggingIn'}
        title="Environment"
      >
        {envs.length === 0 && <option value="">No environments</option>}
        {envs.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>

      {envId && accounts.length > 0 && (
        <select
          className="user-select"
          value={activeAccountId ?? ''}
          onChange={(e) => onUserChange(e.target.value)}
          disabled={busy}
          title="Logged-in user for this environment"
        >
          {!activeAccountId && <option value="">Select user…</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.username ? ` (${a.username})` : ''}
              {a.needsLogin ? ' — login required' : ''}
            </option>
          ))}
          <option value={ADD_USER}>+ Add user…</option>
        </select>
      )}

      <span className={`status-dot ${dotClass}`}>{statusLabel}</span>
      {status === 'loggedOut' && envId && (
        <button className="primary" onClick={() => void login()}>
          Login
        </button>
      )}
      {status === 'loggingIn' && <button onClick={() => void cancelLogin()}>Cancel</button>}
      {status === 'connected' && (
        <button onClick={() => void logout()} title="Forget this user's tokens for this environment">
          Logout
        </button>
      )}
      <span className="spacer" />
      <button onClick={() => void clearMetadata()} disabled={!envId} title="Clear cached object metadata used by autocomplete">
        ⟳ Metadata
      </button>
      <button onClick={() => setSettingsOpen(true)} title="Settings">
        ⚙ Settings
      </button>
    </div>
  )
}
