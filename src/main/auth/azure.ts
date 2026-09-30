import { createHash, randomBytes } from 'node:crypto'
import { OAuthError, type FetchFn } from '../errors'

export interface AzureTokenResponse {
  access_token: string
  refresh_token?: string
  /** Seconds */
  expires_in?: number
}

const base64url = (buf: Buffer) => buf.toString('base64url')

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function createState(): string {
  return base64url(randomBytes(16))
}

/** Azure only issues a refresh token when `offline_access` is requested. */
export function withOfflineAccess(scope: string): string {
  const parts = scope.split(/\s+/).filter(Boolean)
  return parts.includes('offline_access') ? parts.join(' ') : [...parts, 'offline_access'].join(' ')
}

export function buildAuthorizeUrl(p: { authUrl: string; clientId: string; redirectUri: string; scope: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: p.redirectUri,
    scope: withOfflineAccess(p.scope),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    prompt: 'select_account'
  })
  return `${p.authUrl}${p.authUrl.includes('?') ? '&' : '?'}${q}`
}

/** Compare URLs up to the query string; tolerant of percent-encoding differences (e.g. `+` vs `%2B`). */
export function matchesRedirect(url: string, redirectUri: string): boolean {
  const base = (u: string) => {
    const cut = u.split(/[?#]/, 1)[0]
    try {
      return decodeURIComponent(cut).toLowerCase()
    } catch {
      return cut.toLowerCase()
    }
  }
  return base(url) === base(redirectUri)
}

/** Extract the authorization code from the redirect URL, validating state and surfacing Azure errors. */
export function parseCallback(callbackUrl: string, expectedState: string): string {
  const query = callbackUrl.includes('?') ? callbackUrl.slice(callbackUrl.indexOf('?') + 1).split('#')[0] : ''
  const params = new URLSearchParams(query)
  const error = params.get('error')
  if (error) throw new OAuthError(error, params.get('error_description') ?? error)
  if (params.get('state') !== expectedState) {
    throw new OAuthError('STATE_MISMATCH', 'Sign-in response did not match the request (state mismatch).')
  }
  const code = params.get('code')
  if (!code) throw new OAuthError('NO_CODE', 'No authorization code received.')
  return code
}

async function tokenRequest(fetchFn: FetchFn, tokenUrl: string, params: Record<string, string | undefined>): Promise<AzureTokenResponse> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) body.set(k, v)
  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  })
  const data = (await res.json().catch(() => ({}))) as Partial<AzureTokenResponse> & { error?: string; error_description?: string }
  if (!res.ok || !data.access_token) {
    // Azure descriptions carry trace ids after the first line; keep the readable part.
    const description = data.error_description?.split(/\r?\n/)[0]
    throw new OAuthError(data.error ?? `HTTP_${res.status}`, description ?? `Azure token request failed (HTTP ${res.status})`)
  }
  return data as AzureTokenResponse
}

/** Client credentials go in the body (public client: client_id only, plus client_secret when configured). */
export function exchangeCode(
  fetchFn: FetchFn,
  p: { tokenUrl: string; clientId: string; clientSecret?: string; scope: string; code: string; verifier: string; redirectUri: string }
): Promise<AzureTokenResponse> {
  return tokenRequest(fetchFn, p.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    scope: withOfflineAccess(p.scope),
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier
  })
}

export function refreshAzureToken(
  fetchFn: FetchFn,
  p: { tokenUrl: string; clientId: string; clientSecret?: string; scope: string; refreshToken: string }
): Promise<AzureTokenResponse> {
  return tokenRequest(fetchFn, p.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    scope: withOfflineAccess(p.scope),
    refresh_token: p.refreshToken
  })
}
