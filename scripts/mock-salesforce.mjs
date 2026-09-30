// Minimal fake Azure AD + Salesforce token service + Salesforce REST API for local smoke tests.
// Usage: node scripts/mock-salesforce.mjs [port]   (then import scripts/mock-environment.json)
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8787)
const base = `http://127.0.0.1:${port}`
const ORG = '00D000000000001AAA'
// Every sign-in produces a new user (1, 2, 3...) so switching between users can be tested.
let signIns = 0
const userId = (n) => `005${String(n).padStart(12, '0')}AAA`
const USERS = { 1: { Name: 'Jane Mock', Username: 'jane@mock.test.prod' } }
const userRow = (n) => {
  const u = USERS[n] ?? { Name: `User${n} Mock`, Username: `user${n}@mock.test.prod` }
  return { Id: userId(n), ...u, Email: u.Username.replace('.prod', ''), TimeZoneSidKey: 'Europe/Prague', Profile: { Name: 'System Administrator' }, UserRole: null }
}
const readBody = (req) => new Promise((resolve) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => resolve(body))
})
const TOTAL = 1200
const PAGE = 500

const field = (name, type = 'string', extra = {}) => ({
  name,
  label: name.replace(/__c$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
  type,
  relationshipName: null,
  referenceTo: [],
  picklistValues: [],
  length: type === 'string' ? 255 : 0,
  precision: 0,
  scale: 0,
  nillable: type !== 'id' && type !== 'boolean',
  custom: name.endsWith('__c'),
  calculated: false,
  externalId: false,
  unique: false,
  inlineHelpText: null,
  ...extra
})
const describes = {
  Account: {
    name: 'Account',
    label: 'Account',
    fields: [
      field('Id', 'id'),
      field('Name', 'string', { nillable: false }),
      field('Type', 'picklist', { picklistValues: ['Customer', 'Partner', 'Prospect'].map((v) => ({ value: v, label: v, active: true })) }),
      field('Industry'),
      field('AnnualRevenue', 'currency', { precision: 18, scale: 2 }),
      field('SAP_Id__c', 'string', { length: 20, externalId: true, unique: true, inlineHelpText: 'Customer number in SAP' }),
      field('Health_Score__c', 'double', { precision: 5, scale: 1, calculated: true, nillable: true }),
      field('CreatedDate', 'datetime'),
      field('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User'] })
    ],
    childRelationships: [{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' }]
  },
  Contact: { name: 'Contact', label: 'Contact', fields: [field('Id', 'id'), field('LastName'), field('Email', 'email')], childRelationships: [] },
  User: { name: 'User', label: 'User', fields: [field('Id', 'id'), field('Name'), field('Email', 'email')], childRelationships: [] }
}

const account = (i) => ({
  attributes: { type: 'Account', url: `/services/data/v62.0/sobjects/Account/001${i}` },
  Id: `001${String(i).padStart(15, '0')}`,
  Name: `Account ${i}`,
  Owner: i % 7 === 0 ? null : { attributes: { type: 'User' }, Name: `Owner ${i % 5}` },
  Contacts: i % 3 === 0 ? { totalSize: 2, done: true, records: [{ attributes: { type: 'Contact' }, LastName: 'Doe' }, { attributes: { type: 'Contact' }, LastName: 'Roe' }] } : null
})

const page = (offset) => ({
  totalSize: TOTAL,
  done: offset + PAGE >= TOTAL,
  ...(offset + PAGE < TOTAL ? { nextRecordsUrl: `/services/data/v62.0/query/01gMOCK-${offset + PAGE}` } : {}),
  records: Array.from({ length: Math.min(PAGE, TOTAL - offset) }, (_, k) => account(offset + k + 1))
})

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

createServer((req, res) => {
  const url = new URL(req.url, base)
  const p = url.pathname
  console.log(req.method, p + url.search.slice(0, 80))
  // Azure AD: authorize redirects straight back (custom-scheme redirect URIs are intercepted by the app).
  if (p === '/azure/authorize') {
    const to = url.searchParams.get('redirect_uri')
    const q = new URLSearchParams({ code: `MOCKCODE-${++signIns}`, state: url.searchParams.get('state') })
    return send(res, 302, undefined, { Location: `${to}?${q}` })
  }
  if (p === '/azure/token') {
    readBody(req).then((body) => {
      const params = new URLSearchParams(body)
      const n = (params.get('code') ?? params.get('refresh_token') ?? '').split('-').pop()
      send(res, 200, { access_token: `MOCK_AZ-${n}`, refresh_token: `MOCK_AZ_RT-${n}`, expires_in: 3600 })
    })
    return
  }
  // Company token service: Azure token in, Salesforce token out.
  if (p === '/salesforce/token') {
    const n = /^Bearer MOCK_AZ-(\d+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!n) return send(res, 401, { message: 'Unauthorized' })
    return send(res, 200, { access_token: `MOCK_AT-${n}`, scope: 'api', instance_url: base, id: `https://test.salesforce.com/id/${ORG}/${userId(n)}`, token_type: 'Bearer' })
  }
  if (p === '/v1/chat/completions') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const user = JSON.parse(body).messages[1].content
      const query = /Query:\n([\s\S]*?)(\n\n|$)/.exec(user)?.[1] ?? ''
      const fixed = query.replace(/\bFRO\b/i, 'FROM')
      send(res, 200, { choices: [{ message: { content: JSON.stringify({ query: fixed, explanation: 'FRO is not a keyword; the FROM clause was misspelled.' }) } }] })
    })
    return
  }
  if (!/^Bearer MOCK_AT-\d+$/.test(req.headers.authorization ?? '')) return send(res, 401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }])
  if (p === '/services/data/v62.0/query' || p === '/services/data/v62.0/queryAll') {
    const q = url.searchParams.get('q') ?? ''
    if (/FROM User/i.test(q)) {
      const n = /Id = '005(\d{12})AAA'/.exec(q)?.[1] ?? '1'
      return send(res, 200, { totalSize: 1, done: true, records: [userRow(Number(n))] })
    }
    if (/\bFRO\b/i.test(q)) {
      return send(res, 400, [{ errorCode: 'MALFORMED_QUERY', message: `\n${q}\n ^\nERROR at Row:1:Column:11\nunexpected token: FRO` }])
    }
    return send(res, 200, page(0))
  }
  const more = /^\/services\/data\/v62\.0\/query\/01gMOCK-(\d+)$/.exec(p)
  if (more) return send(res, 200, page(Number(more[1])))
  if (p === '/services/data/v62.0/sobjects') {
    return send(res, 200, { sobjects: Object.values(describes).map((d) => ({ name: d.name, label: d.label, queryable: true })) })
  }
  const desc = /^\/services\/data\/v62\.0\/sobjects\/(\w+)\/describe$/.exec(p)
  if (desc && describes[desc[1]]) return send(res, 200, describes[desc[1]])
  send(res, 404, [{ errorCode: 'NOT_FOUND', message: 'Not found' }])
}).listen(port, '127.0.0.1', () => console.log(`Mock Salesforce on ${base}`))
