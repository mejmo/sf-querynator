import { describe, expect, it, vi } from 'vitest'
import { suggestFix, buildUserPrompt } from '../../src/main/ai/openai'
import { OpenAiError, SalesforceApiError, SessionExpiredError } from '../../src/main/errors'
import { SalesforceClient, type SfConnection } from '../../src/main/sf/client'
import { fakeFetch, json } from './fakeFetch'

const conn = (token: string): SfConnection => ({ instanceUrl: 'https://acme.my.salesforce.com', accessToken: token, apiVersion: '62.0' })

function setup() {
  const f = fakeFetch()
  const tokens = { get: vi.fn(async () => conn('OLD')), refresh: vi.fn(async () => conn('NEW')) }
  return { f, tokens, client: new SalesforceClient(f.fetchFn, tokens) }
}

describe('SalesforceClient', () => {
  it('queries with batch size and bearer token', async () => {
    const { f, client } = setup()
    f.on('GET /services/data/v62.0/query?q=', json({ totalSize: 1, done: true, records: [{ Id: '1' }] }))
    const r = await client.query('SELECT Id FROM Account')
    expect(r.records).toHaveLength(1)
    expect(f.requests[0].url).toBe('https://acme.my.salesforce.com/services/data/v62.0/query?q=SELECT%20Id%20FROM%20Account')
    expect(f.requests[0].headers).toMatchObject({ authorization: 'Bearer OLD', 'sforce-query-options': 'batchSize=500' })
  })

  it('uses queryAll and follows nextRecordsUrl', async () => {
    const { f, client } = setup()
    f.on('GET /queryAll?q=', json({ totalSize: 900, done: false, nextRecordsUrl: '/services/data/v62.0/query/01g-500', records: [] }))
    f.on('GET /query/01g-500', json({ totalSize: 900, done: true, records: [] }))
    const first = await client.query('SELECT Id FROM Account', { queryAll: true })
    await client.queryMore(first.nextRecordsUrl!)
    expect(f.requests[1].url).toBe('https://acme.my.salesforce.com/services/data/v62.0/query/01g-500')
    expect(() => client.queryMore('https://evil.example/x')).toThrow()
  })

  it('refreshes once on 401 and retries', async () => {
    const { f, tokens, client } = setup()
    f.once('GET /query', json([{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }], 401))
    f.once('GET /query', json({ totalSize: 0, done: true, records: [] }))
    await client.query('SELECT Id FROM Account')
    expect(tokens.refresh).toHaveBeenCalledTimes(1)
    expect(f.requests[1].headers.authorization).toBe('Bearer NEW')
  })

  it('gives up after a second 401', async () => {
    const { f, client } = setup()
    f.on('GET /query', json([{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }], 401))
    await expect(client.query('SELECT Id FROM Account')).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('maps Salesforce error bodies', async () => {
    const { f, client } = setup()
    f.on('GET /query', json([{ errorCode: 'MALFORMED_QUERY', message: 'unexpected token: FRO' }], 400))
    const err = await client.query('SELECT Id FRO Account').catch((e) => e)
    expect(err).toBeInstanceOf(SalesforceApiError)
    expect(err).toMatchObject({ status: 400, errorCode: 'MALFORMED_QUERY', message: 'unexpected token: FRO' })
  })

  it('passes the abort signal through', async () => {
    const { f, client } = setup()
    f.on('GET /query', json({}))
    const ac = new AbortController()
    ac.abort()
    await expect(client.query('SELECT Id FROM Account', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('maps describe results', async () => {
    const { f, client } = setup()
    f.on('GET /sobjects/Account/describe', json({
      name: 'Account',
      label: 'Account',
      extra: 'ignored',
      fields: [
        {
          name: 'OwnerId',
          label: 'Owner',
          type: 'reference',
          relationshipName: 'Owner',
          referenceTo: ['User'],
          picklistValues: [],
          length: 18,
          nillable: false,
          custom: false,
          calculated: false,
          externalId: false,
          unique: false,
          inlineHelpText: null,
          soapType: 'tns:ID'
        }
      ],
      childRelationships: [{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId', cascadeDelete: false }]
    }))
    f.on('GET /sobjects', json({ sobjects: [{ name: 'Account', label: 'Account', queryable: true, custom: false }] }))
    expect(await client.describeSObject('Account')).toEqual({
      name: 'Account',
      label: 'Account',
      fields: [
        {
          name: 'OwnerId',
          label: 'Owner',
          type: 'reference',
          relationshipName: 'Owner',
          referenceTo: ['User'],
          picklistValues: [],
          length: 18,
          precision: undefined,
          scale: undefined,
          nillable: false,
          custom: false,
          calculated: false,
          externalId: false,
          unique: false,
          inlineHelpText: null
        }
      ],
      childRelationships: [{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' }]
    })
    expect(await client.describeGlobal()).toEqual([{ name: 'Account', label: 'Account', queryable: true, custom: false }])
  })

  it('loads the current user', async () => {
    const { f, client } = setup()
    f.on('GET /query', json({
      totalSize: 1,
      done: true,
      records: [{ Id: '005x', Name: 'Jane Doe', Email: 'j@x.com', Username: 'j@x.com.prod', TimeZoneSidKey: 'Europe/Prague', Profile: { Name: 'System Administrator' }, UserRole: null }]
    }))
    expect(await client.getUser('005000000000001AAA')).toEqual({
      id: '005x',
      name: 'Jane Doe',
      email: 'j@x.com',
      username: 'j@x.com.prod',
      profileName: 'System Administrator',
      roleName: null,
      timeZone: 'Europe/Prague'
    })
    await expect(client.getUser("x' OR Id != '")).rejects.toThrow(/Invalid user id/)
  })

  it('loads the user without profile/role when those relations are not accessible', async () => {
    const { f, client } = setup()
    const invalid = (rel: string) => json([{ errorCode: 'INVALID_FIELD', message: `No such relation '${rel}' on entity 'User'.` }], 400)
    const base = { Id: '005x', Name: 'Jane', Email: 'j@x.com', Username: 'j@x', TimeZoneSidKey: 'UTC' }
    f.once('GET /query?q=SELECT%20Id%2C%20Name%2C%20Email%2C%20Username%2C%20TimeZoneSidKey%2C%20Profile.Name', invalid('Profile'))
    f.once('GET /query?q=SELECT%20Id%2C%20Name%2C%20Email%2C%20Username%2C%20TimeZoneSidKey%20FROM', json({ totalSize: 1, done: true, records: [base] }))
    f.once('GET /query?q=SELECT%20Profile.Name', invalid('Profile'))
    f.once('GET /query?q=SELECT%20UserRole.Name', json({ totalSize: 1, done: true, records: [{ UserRole: { Name: 'Sales' } }] }))
    expect(await client.getUser('005000000000001AAA')).toEqual({
      id: '005x',
      name: 'Jane',
      email: 'j@x.com',
      username: 'j@x',
      profileName: null,
      roleName: 'Sales',
      timeZone: 'UTC'
    })
  })

  it('still fails on other user-query errors', async () => {
    const { f, client } = setup()
    f.on('GET /query', json([{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'limit' }], 403))
    await expect(client.getUser('005000000000001AAA')).rejects.toMatchObject({ errorCode: 'REQUEST_LIMIT_EXCEEDED' })
  })
})

describe('suggestFix', () => {
  const request = { soql: 'SELECT Nme FROM Account', error: 'No such column Nme', objectName: 'Account', fields: [{ name: 'Name', type: 'string' }], apiVersion: '62.0' }
  const completion = (content: string) => json({ choices: [{ message: { content } }] })

  it('sends model, key and context and parses the JSON answer', async () => {
    const f = fakeFetch().on('POST https://api.openai.com/v1/chat/completions', completion('{"query":"SELECT Name FROM Account","explanation":"Typo."}'))
    const r = await suggestFix(f.fetchFn, { apiKey: 'sk-1', model: 'gpt-4o', request })
    expect(r).toEqual({ query: 'SELECT Name FROM Account', explanation: 'Typo.' })
    const body = JSON.parse(f.requests[0].body!)
    expect(f.requests[0].headers.authorization).toBe('Bearer sk-1')
    expect(body.model).toBe('gpt-4o')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[1].content).toContain('No such column Nme')
    expect(body.messages[1].content).toContain('Name (string)')
  })

  it('explains auth and rate-limit failures', async () => {
    const f = fakeFetch().once('POST /chat/completions', json({ error: { message: 'Incorrect API key' } }, 401))
    await expect(suggestFix(f.fetchFn, { apiKey: 'bad', model: 'm', request })).rejects.toMatchObject({
      status: 401,
      message: 'OpenAI rejected the API key: Incorrect API key'
    })
    f.once('POST /chat/completions', json({ error: { message: 'quota' } }, 429))
    await expect(suggestFix(f.fetchFn, { apiKey: 'k', model: 'm', request })).rejects.toThrow(/rate limit/)
  })

  it('rejects unparseable answers', async () => {
    const f = fakeFetch().on('POST /chat/completions', completion('Sure! Here you go'))
    await expect(suggestFix(f.fetchFn, { apiKey: 'k', model: 'm', request })).rejects.toBeInstanceOf(OpenAiError)
  })

  it('omits the field list when there is no object', () => {
    expect(buildUserPrompt({ ...request, objectName: null, error: null })).not.toContain('Fields of')
  })
})
