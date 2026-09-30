import { useStore } from '../store'

export function ErrorBanner({ onFixWithAi }: { onFixWithAi(): void }) {
  const { error, dismissError, run, login, status } = useStore()
  if (!error) return null

  return (
    <div className="banner" role="alert">
      <div className="msg">
        {error.code && <span className="code">{error.code}: </span>}
        {error.message}
      </div>
      {error.kind === 'network' && <button onClick={() => void run()}>Retry</button>}
      {error.kind === 'salesforce' && <button onClick={onFixWithAi}>✨ Fix with AI</button>}
      {error.kind === 'auth' && status === 'loggedOut' && <button onClick={() => void login()}>Login</button>}
      <button onClick={dismissError} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
