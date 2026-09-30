import { OAuthError, type FetchFn } from '../errors'

/** Salesforce OAuth 2.0 web server flow with PKCE, against the org's login host (login/test/My Domain). */

export interface SalesforceTokenGrant {
  access_token: string
  refresh_token?: string
  instance_url: string
  /** Identity URL: https://login.salesforce.com/id/<orgId>/<userId> */
  id: string
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

export function buildSalesforceAuthorizeUrl(p: { loginUrl: string; clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    // Always show the login form, so another user can be added to the same environment.
    prompt: 'login'
  })
  return `${trimSlash(p.loginUrl)}/services/oauth2/authorize?${q}`
}

async function tokenRequest(fetchFn: FetchFn, loginUrl: string, params: Record<string, string | undefined>): Promise<SalesforceTokenGrant> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) body.set(k, v)
  const res = await fetchFn(`${trimSlash(loginUrl)}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  })
  const data = (await res.json().catch(() => ({}))) as Partial<SalesforceTokenGrant> & { error?: string; error_description?: string }
  if (!res.ok || !data.access_token || !data.instance_url || !data.id) {
    throw new OAuthError(data.error ?? `HTTP_${res.status}`, data.error_description ?? `Salesforce token request failed (HTTP ${res.status})`)
  }
  return data as SalesforceTokenGrant
}

export function exchangeSalesforceCode(
  fetchFn: FetchFn,
  p: { loginUrl: string; clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string }
): Promise<SalesforceTokenGrant> {
  return tokenRequest(fetchFn, p.loginUrl, {
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier
  })
}

export function refreshSalesforceToken(
  fetchFn: FetchFn,
  p: { loginUrl: string; clientId: string; clientSecret?: string; refreshToken: string }
): Promise<SalesforceTokenGrant> {
  return tokenRequest(fetchFn, p.loginUrl, {
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId,
    client_secret: p.clientSecret
  })
}

/** Best effort: failures are ignored because the local tokens are deleted anyway. */
export async function revokeSalesforceToken(fetchFn: FetchFn, p: { loginUrl: string; token: string }): Promise<void> {
  try {
    await fetchFn(`${trimSlash(p.loginUrl)}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: p.token }).toString()
    })
  } catch {
    // ignore
  }
}
