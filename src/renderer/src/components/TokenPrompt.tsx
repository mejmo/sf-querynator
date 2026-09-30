import { useState } from 'react'
import { useStore } from '../store'
import { Modal } from './Modal'

/** Auth type "Access token": asks for a Salesforce access token instead of running a login flow. */
export function TokenPrompt() {
  const { settings, envId, status, tokenPromptError, login, closeTokenPrompt } = useStore()
  const [token, setToken] = useState('')
  const env = settings?.environments.find((e) => e.id === envId)
  const busy = status === 'loggingIn'
  const submit = () => {
    if (token.trim() && !busy) void login(token.trim())
  }

  return (
    <Modal
      title="Log in with an access token"
      className="token-prompt"
      onClose={closeTokenPrompt}
      footer={
        <>
          <button onClick={closeTokenPrompt}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!token.trim() || busy}>
            {busy ? (
              <>
                <span className="spinner" /> Checking…
              </>
            ) : (
              'Log in'
            )}
          </button>
        </>
      }
    >
      <p className="muted">
        Paste a Salesforce access token (or session ID) for <code className="inline">{env?.instanceUrl}</code>. For example the
        “Access Token” from <code className="inline">sf org display --target-org &lt;alias&gt;</code>. It is stored encrypted and used
        until it expires; then log in again with a new one.
      </p>
      {tokenPromptError && <div className="form-error">{tokenPromptError}</div>}
      <textarea
        className="token-input"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="00D…!AQ…"
        spellCheck={false}
        autoFocus
      />
    </Modal>
  )
}
