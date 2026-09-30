import { useEffect, useState } from 'react'
import type { Environment, EnvironmentConfig } from '../../../shared/types'
import { useStore } from '../store'
import { Modal } from './Modal'

const DEFAULT_API_VERSION = '62.0'

interface EnvForm extends EnvironmentConfig {
  clientSecret: string
  clearSecret: boolean
}

const blankForm: EnvForm = {
  name: '',
  authUrl: '',
  tokenUrl: '',
  clientId: '',
  scope: '',
  redirectUri: '',
  sfTokenUrl: '',
  apiVersion: DEFAULT_API_VERSION,
  clientSecret: '',
  clearSecret: false
}

const toForm = ({ id: _id, ...config }: Environment): EnvForm => ({ ...blankForm, ...config })

const FIELDS: { key: keyof EnvironmentConfig; label: string; placeholder?: string; help?: string; mono?: boolean }[] = [
  { key: 'name', label: 'Name', placeholder: 'UAT' },
  { key: 'authUrl', label: 'Auth URL', placeholder: 'https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize', mono: true },
  { key: 'tokenUrl', label: 'Token URL', placeholder: 'https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token', mono: true },
  { key: 'clientId', label: 'Client ID', mono: true },
  { key: 'scope', label: 'Scope', placeholder: 'api://… api://…', help: 'Space-separated. offline_access is added automatically so the refresh token can be kept.', mono: true },
  { key: 'redirectUri', label: 'Callback URL', placeholder: 'msauth://…', help: 'Must match the redirect URI registered in Azure.', mono: true },
  { key: 'sfTokenUrl', label: 'SF token URL', placeholder: 'https://…/salesforce/token?connected_app=…', help: 'Called with the Azure token; returns the Salesforce access token.', mono: true },
  { key: 'apiVersion', label: 'API version' }
]

export function SettingsDialog() {
  const { settings, envId, refreshSettings, selectEnv, setSettingsOpen, notify } = useStore()
  const envs = settings?.environments ?? []
  /** null = creating a new environment */
  const [editingId, setEditingId] = useState<string | null>(envId ?? envs[0]?.id ?? null)
  const editing = envs.find((e) => e.id === editingId) ?? null
  const [form, setForm] = useState<EnvForm>(editing ? toForm(editing) : blankForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [openAiKey, setOpenAiKey] = useState('')
  const [model, setModel] = useState(settings?.openAiModel ?? 'gpt-4o')
  const [appError, setAppError] = useState<string | null>(null)

  useEffect(() => {
    setForm(editing ? toForm(editing) : blankForm)
    setFormError(null)
    // Only when switching which environment is edited.
  }, [editingId])

  const close = () => setSettingsOpen(false)
  const update = (patch: Partial<EnvForm>) => setForm((f) => ({ ...f, ...patch }))
  const hasSecret = !!(editingId && settings?.envHasSecret[editingId])

  const saveEnv = async () => {
    const { clientSecret, clearSecret, ...config } = form
    const r = await window.api.saveEnvironment(editingId, { ...config, clientSecret: clearSecret ? null : clientSecret || undefined })
    if (!r.ok) return setFormError(r.error.message)
    await refreshSettings()
    setEditingId(r.value.id)
    notify(`Saved ${r.value.name}`)
    if (!envId || envId === r.value.id) await selectEnv(r.value.id)
  }

  const deleteEnv = async () => {
    if (!editing || !confirm(`Delete "${editing.name}"? Its tokens, history and cached metadata are removed.`)) return
    const r = await window.api.deleteEnvironment(editing.id)
    if (!r.ok) return setFormError(r.error.message)
    await refreshSettings()
    setEditingId(useStore.getState().settings?.environments[0]?.id ?? null)
  }

  const exportEnvs = async (ids: string[]) => {
    const r = await window.api.exportEnvironments(ids)
    if (!r.ok) return setFormError(r.error.message)
    if (r.value) notify(`Exported ${ids.length === 1 ? 'environment' : `${ids.length} environments`}`)
  }

  const importEnvs = async () => {
    const r = await window.api.importEnvironments()
    if (!r.ok) return setFormError(r.error.message)
    if (r.value.length === 0) return
    await refreshSettings()
    setEditingId(r.value[0].id)
    notify(`Imported ${r.value.map((e) => e.name).join(', ')}`)
    if (!useStore.getState().envId) await selectEnv(r.value[0].id)
  }

  const saveApp = async () => {
    setAppError(null)
    const r = await window.api.setAppSettings({ openAiModel: model.trim() })
    if (!r.ok) return setAppError(r.error.message)
    if (openAiKey.trim()) {
      const k = await window.api.setOpenAiKey(openAiKey)
      if (!k.ok) return setAppError(k.error.message)
      setOpenAiKey('')
    }
    await refreshSettings()
    notify('Settings saved')
  }

  const clearKey = async () => {
    await window.api.setOpenAiKey(null)
    await refreshSettings()
  }

  return (
    <Modal title="Settings" className="settings" onClose={close} footer={<button onClick={close}>Close</button>}>
      <div className="envlist">
        <div className="section-title">Environments</div>
        <ul>
          {envs.map((e) => (
            <li key={e.id} className={e.id === editingId ? 'active' : ''} onClick={() => setEditingId(e.id)}>
              {e.name}
            </li>
          ))}
          {editingId === null && <li className="active">New environment</li>}
        </ul>
        <div className="envlist-actions">
          <button onClick={() => setEditingId(null)}>+ Add</button>
          <button onClick={() => void importEnvs()} title="Import environments from a .json file">
            Import…
          </button>
          <button onClick={() => void exportEnvs(envs.map((e) => e.id))} disabled={envs.length === 0} title="Export all environments">
            Export all…
          </button>
        </div>
      </div>

      <div className="pane">
        <h3>{editing ? `Environment: ${editing.name}` : 'New environment'}</h3>
        {formError && <div className="form-error">{formError}</div>}
        <div className="form">
          {FIELDS.map((f) => (
            <FieldRow key={f.key} field={f} value={form[f.key]} onChange={(v) => update({ [f.key]: v })} />
          ))}
          <label htmlFor="env-secret">Client secret</label>
          <input
            id="env-secret"
            type="password"
            value={form.clientSecret}
            onChange={(e) => update({ clientSecret: e.target.value, clearSecret: false })}
            placeholder={hasSecret ? '•••••• stored — leave empty to keep' : 'Optional — not needed for public clients'}
          />
          {hasSecret && (
            <label className="help">
              <input type="checkbox" checked={form.clearSecret} onChange={(e) => update({ clearSecret: e.target.checked })} /> Remove stored secret
            </label>
          )}
        </div>
        <div className="form-actions">
          <button className="primary" onClick={() => void saveEnv()}>
            {editing ? 'Save environment' : 'Add environment'}
          </button>
          {editing && <button onClick={() => void exportEnvs([editing.id])}>Export…</button>}
          {editing && (
            <button className="danger" onClick={() => void deleteEnv()}>
              Delete
            </button>
          )}
        </div>
        <div className="muted">
          Login signs in to Azure AD in a Querynator window, then exchanges the Azure token for a Salesforce token via the
          SF token URL. Exports contain the settings above and the name — never secrets or tokens.
        </div>

        <h3>OpenAI</h3>
        {appError && <div className="form-error">{appError}</div>}
        <div className="form">
          <label htmlFor="ai-key">API key</label>
          <input
            id="ai-key"
            type="password"
            value={openAiKey}
            onChange={(e) => setOpenAiKey(e.target.value)}
            placeholder={settings?.hasOpenAiKey ? '•••••• stored — paste to replace' : 'sk-…'}
            spellCheck={false}
          />
          {settings?.hasOpenAiKey && (
            <div className="help">
              Key is stored encrypted.{' '}
              <button className="link" onClick={() => void clearKey()}>
                Remove key
              </button>
            </div>
          )}
          <label htmlFor="ai-model">Model</label>
          <input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 200 }} />
        </div>
        <div className="form-actions">
          <button className="primary" onClick={() => void saveApp()}>
            Save OpenAI settings
          </button>
        </div>
      </div>
    </Modal>
  )
}

function FieldRow({ field, value, onChange }: { field: (typeof FIELDS)[number]; value: string; onChange(v: string): void }) {
  const id = `env-${field.key}`
  return (
    <>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        spellCheck={false}
        className={field.mono ? 'mono' : undefined}
        style={field.key === 'apiVersion' ? { width: 100 } : undefined}
      />
      {field.help && <div className="help">{field.help}</div>}
    </>
  )
}
