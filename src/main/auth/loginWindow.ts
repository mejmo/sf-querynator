import { BrowserWindow } from 'electron'
import { OAuthError } from '../errors'
import { matchesRedirect } from './azure'

export interface AuthorizeOptions {
  url: string
  redirectUri: string
  timeoutMs: number
  signal: AbortSignal
}

/** Opens the authorize page and resolves with the full redirect URL (including `?code=…`). */
export type AuthorizeFn = (opts: AuthorizeOptions) => Promise<string>

/**
 * Sign-in runs in an in-app window because the registered redirect URI uses a custom scheme (msauth://…) that a
 * system browser cannot hand back to us. The redirect is intercepted before navigation. The persistent partition
 * keeps the SSO cookies, so later sign-ins are usually a single click.
 */
export function createWindowAuthorizer(getParent: () => BrowserWindow | null): AuthorizeFn {
  return (opts) =>
    new Promise<string>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        parent: getParent() ?? undefined,
        title: 'Sign in',
        autoHideMenuBar: true,
        webPreferences: { partition: 'persist:sso', contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal.removeEventListener('abort', onAbort)
        fn()
        if (!win.isDestroyed()) win.close()
      }
      const intercept = (event: { preventDefault(): void }, url: string) => {
        if (!matchesRedirect(url, opts.redirectUri)) return
        event.preventDefault()
        finish(() => resolve(url))
      }
      const onAbort = () => finish(() => reject(new OAuthError('CANCELLED', 'Sign-in cancelled')))
      const timer = setTimeout(() => finish(() => reject(new OAuthError('TIMEOUT', 'Sign-in timed out. Please try again.'))), opts.timeoutMs)

      win.webContents.on('will-redirect', (event, url) => intercept(event, url))
      win.webContents.on('will-navigate', (event, url) => intercept(event, url))
      // Some flows navigate to the custom scheme in a way that only surfaces as a failed load.
      win.webContents.on('did-fail-load', (_event, _code, _description, url) => {
        if (matchesRedirect(url, opts.redirectUri)) finish(() => resolve(url))
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.on('closed', () => finish(() => reject(new OAuthError('CANCELLED', 'Sign-in window was closed'))))

      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort)
      win.loadURL(opts.url).catch((e: Error) => {
        // Loading is aborted when we intercept the redirect; only report genuine failures.
        if (!settled && !/ERR_ABORTED/.test(e.message)) finish(() => reject(e))
      })
    })
}
