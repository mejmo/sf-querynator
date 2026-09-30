import { OAuthError, type FetchFn } from '../errors'

/**
 * Work out whose access token was pasted. Tries the OpenID userinfo endpoint (works for OAuth tokens, including the
 * Salesforce CLI's), then the Chatter "me" resource (works for most session IDs). The org id comes from userinfo or,
 * failing that, from the Organization record (best effort).
 */
export async function identifyToken(
  fetchFn: FetchFn,
  p: { instanceUrl: string; apiVersion: string; accessToken: string }
): Promise<{ userId: string; orgId: string }> {
  const get = (path: string) =>
    fetchFn(`${p.instanceUrl}${path}`, { headers: { Authorization: `Bearer ${p.accessToken}`, Accept: 'application/json' } })
  const data = `/services/data/v${p.apiVersion}`

  const userinfo = await get('/services/oauth2/userinfo')
  if (userinfo.ok) {
    const u = (await userinfo.json().catch(() => ({}))) as { user_id?: string; organization_id?: string }
    if (u.user_id) return { userId: u.user_id, orgId: u.organization_id ?? '' }
  }
  if (userinfo.status === 401) throw new OAuthError('INVALID_TOKEN', 'Salesforce rejected the access token (invalid or expired).')

  const me = await get(`${data}/chatter/users/me`)
  if (me.status === 401) throw new OAuthError('INVALID_TOKEN', 'Salesforce rejected the access token (invalid or expired).')
  const meBody = me.ok ? ((await me.json().catch(() => ({}))) as { id?: string }) : {}
  if (!meBody.id) throw new OAuthError('UNKNOWN_USER', "Couldn't determine the user for this access token.")

  let orgId = ''
  const org = await get(`${data}/query?q=${encodeURIComponent('SELECT Id FROM Organization')}`)
  if (org.ok) orgId = ((await org.json().catch(() => ({}))) as { records?: { Id?: string }[] }).records?.[0]?.Id ?? ''
  return { userId: meBody.id, orgId }
}
