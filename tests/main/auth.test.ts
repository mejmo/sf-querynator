import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  matchesRedirect,
  parseCallback,
  refreshAzureToken,
  withOfflineAccess
} from '../../src/main/auth/azure'
import { fetchSalesforceToken, parseIdentityUrl, SF_TOKEN_UNAUTHORIZED } from '../../src/main/auth/sfToken'
import { OAuthError } from '../../src/main/errors'
import { fakeFetch, json } from './fakeFetch'

const REDIRECT = 'msauth://com.example.querynator/Ab3d+EfGh1jK2lMn='
const TOKEN_URL = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token'
const SCOPE = 'api://example-api/Records.Read api://example-api/Records.Write'

describe('PKCE', () => {
  it('challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('withOfflineAccess', () => {
  it('adds offline_access once', () => {
    expect(withOfflineAccess(' a  b ')).toBe('a b offline_access')
    expect(withOfflineAccess('a offline_access')).toBe('a offline_access')
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds an Azure v2 authorize URL with PKCE and the custom-scheme redirect', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
        clientId: 'CID',
        redirectUri: REDIRECT,
        scope: SCOPE,
        challenge: 'CH',
        state: 'ST'
      })
    )
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'CID',
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: REDIRECT,
      scope: `${SCOPE} offline_access`,
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      state: 'ST'
    })
  })
})

describe('redirect handling', () => {
  it('matches the redirect regardless of encoding and query', () => {
    expect(matchesRedirect(`${REDIRECT}?code=x&state=y`, REDIRECT)).toBe(true)
    expect(matchesRedirect('msauth://com.example.querynator/Ab3d%2BEfGh1jK2lMn%3D?code=x', REDIRECT)).toBe(true)
    expect(matchesRedirect('https://login.microsoftonline.com/common/login', REDIRECT)).toBe(false)
  })

  it('extracts the code and validates state', () => {
    expect(parseCallback(`${REDIRECT}?code=abc&state=S1`, 'S1')).toBe('abc')
    expect(() => parseCallback(`${REDIRECT}?code=abc&state=X`, 'S1')).toThrow(expect.objectContaining({ code: 'STATE_MISMATCH' }))
    expect(() => parseCallback(`${REDIRECT}?state=S1`, 'S1')).toThrow(expect.objectContaining({ code: 'NO_CODE' }))
  })

  it('surfaces Azure errors from the redirect', () => {
    expect(() => parseCallback(`${REDIRECT}?error=access_denied&error_description=User+cancelled&state=S1`, 'S1')).toThrow(
      expect.objectContaining({ code: 'access_denied', message: 'User cancelled' })
    )
  })
})

describe('Azure token endpoint', () => {
  it('exchanges the code with client credentials in the body', async () => {
    const f = fakeFetch().on(`POST ${TOKEN_URL}`, json({ access_token: 'AZ', refresh_token: 'RT', expires_in: 3599 }))
    const t = await exchangeCode(f.fetchFn, { tokenUrl: TOKEN_URL, clientId: 'CID', scope: SCOPE, code: 'CODE', verifier: 'VER', redirectUri: REDIRECT })
    expect(t).toEqual({ access_token: 'AZ', refresh_token: 'RT', expires_in: 3599 })
    expect(f.requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(f.requests[0].body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'CID',
      scope: `${SCOPE} offline_access`,
      code: 'CODE',
      redirect_uri: REDIRECT,
      code_verifier: 'VER'
    })
  })

  it('refreshes with the refresh token and includes a configured secret', async () => {
    const f = fakeFetch().on(`POST ${TOKEN_URL}`, json({ access_token: 'AZ2', expires_in: 3599 }))
    await refreshAzureToken(f.fetchFn, { tokenUrl: TOKEN_URL, clientId: 'CID', clientSecret: 'SEC', scope: SCOPE, refreshToken: 'RT' })
    expect(Object.fromEntries(new URLSearchParams(f.requests[0].body))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'CID',
      client_secret: 'SEC',
      scope: `${SCOPE} offline_access`,
      refresh_token: 'RT'
    })
  })

  it('maps Azure errors to the first line of the description', async () => {
    const f = fakeFetch().on(
      `POST ${TOKEN_URL}`,
      json({ error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.\r\nTrace ID: 123' }, 400)
    )
    const err = await refreshAzureToken(f.fetchFn, { tokenUrl: TOKEN_URL, clientId: 'C', scope: 's', refreshToken: 'R' }).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect(err).toMatchObject({ code: 'invalid_grant', message: 'AADSTS70008: The refresh token has expired.' })
  })
})

describe('Salesforce token service', () => {
  const SF_URL = 'https://api.example.com/salesforce/token?app=querynator'
  const SF_TOKEN = {
    access_token: 'SF',
    scope: 'api',
    instance_url: 'https://example--uat.sandbox.my.salesforce.com',
    id: 'https://test.salesforce.com/id/00D0X0000000TEST1A/0050X0000000TEST1A',
    token_type: 'Bearer'
  }

  it('sends the Azure token as a bearer token', async () => {
    const f = fakeFetch().on('GET https://api.example.com/salesforce/token', json(SF_TOKEN))
    const t = await fetchSalesforceToken(f.fetchFn, { sfTokenUrl: SF_URL, azureAccessToken: 'AZ' })
    expect(t.access_token).toBe('SF')
    expect(f.requests[0].url).toBe(SF_URL)
    expect(f.requests[0].headers.authorization).toBe('Bearer AZ')
    expect(parseIdentityUrl(t.id)).toEqual({ orgId: '00D0X0000000TEST1A', userId: '0050X0000000TEST1A' })
  })

  it('distinguishes a rejected Azure token from other failures', async () => {
    const f = fakeFetch()
    f.once('GET /salesforce/', new Response('Unauthorized', { status: 401 }))
    await expect(fetchSalesforceToken(f.fetchFn, { sfTokenUrl: SF_URL, azureAccessToken: 'AZ' })).rejects.toMatchObject({ code: SF_TOKEN_UNAUTHORIZED })
    f.once('GET /salesforce/', json({ message: 'User not provisioned' }, 403))
    await expect(fetchSalesforceToken(f.fetchFn, { sfTokenUrl: SF_URL, azureAccessToken: 'AZ' })).rejects.toMatchObject({
      code: 'SF_TOKEN_HTTP_403',
      message: 'Salesforce token service failed: User not provisioned'
    })
  })
})
