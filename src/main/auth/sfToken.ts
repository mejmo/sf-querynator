import { OAuthError, type FetchFn } from '../errors'

export interface SalesforceTokenResponse {
  access_token: string
  instance_url: string
  /** Identity URL: https://test.salesforce.com/id/<orgId>/<userId> */
  id: string
}

/** Thrown when the token service rejects the Azure token (HTTP 401): refresh Azure and retry. */
export const SF_TOKEN_UNAUTHORIZED = 'SF_TOKEN_UNAUTHORIZED'

/** Exchange an Azure access token for a Salesforce access token via the company token service. */
export async function fetchSalesforceToken(fetchFn: FetchFn, p: { sfTokenUrl: string; azureAccessToken: string }): Promise<SalesforceTokenResponse> {
  const res = await fetchFn(p.sfTokenUrl, {
    headers: { Authorization: `Bearer ${p.azureAccessToken}`, Accept: 'application/json' }
  })
  const text = await res.text().catch(() => '')
  let data: Partial<SalesforceTokenResponse> & { error?: string; error_description?: string; message?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    // not JSON
  }
  if (res.status === 401) throw new OAuthError(SF_TOKEN_UNAUTHORIZED, 'Salesforce token service rejected the Azure token')
  if (!res.ok || !data.access_token || !data.instance_url || !data.id) {
    const detail = data.error_description ?? data.message ?? data.error ?? (text.slice(0, 200) || `HTTP ${res.status}`)
    throw new OAuthError(`SF_TOKEN_HTTP_${res.status}`, `Salesforce token service failed: ${detail}`)
  }
  return data as SalesforceTokenResponse
}

export function parseIdentityUrl(id: string): { orgId: string; userId: string } {
  const m = /\/id\/([A-Za-z0-9]{15,18})\/([A-Za-z0-9]{15,18})\/?$/.exec(id)
  if (!m) throw new OAuthError('BAD_IDENTITY', `Unexpected identity URL: ${id}`)
  return { orgId: m[1], userId: m[2] }
}
