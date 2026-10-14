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

// Made-up but realistic-looking data (also used for the README and website screenshots).
const PREFIXES = ['Northwind', 'Blue Harbor', 'Silverline', 'Brightpath', 'Redwood', 'Ironbridge', 'Clearwater', 'Summit', 'Evergreen', 'Lakeside', 'Pinecrest', 'Stonegate', 'Westbrook', 'Oakridge', 'Highland', 'Riverbend', 'Granite Peak', 'Sunfield']
const SECTORS = [['Logistics', 'Transportation'], ['Energy', 'Energy'], ['Retail', 'Retail'], ['Systems', 'Technology'], ['Foods', 'Food & Beverage'], ['Health', 'Healthcare'], ['Capital', 'Banking'], ['Manufacturing', 'Manufacturing'], ['Media', 'Media'], ['Labs', 'Biotechnology']]
const OWNERS = ['Jane Mock', 'Tom Becker', 'Ana Silva', 'Lukas Novak', 'Priya Shah']
const LAST_NAMES = ['Doe', 'Roe', 'Fischer', 'Kowalski', 'Moreau', 'Rossi', 'Tanaka', 'Walsh']
const TYPES = ['Customer', 'Partner', 'Prospect']
const account = (i) => {
  const [suffix, industry] = SECTORS[(i * 7) % SECTORS.length]
  const name = `${PREFIXES[i % PREFIXES.length]} ${suffix}`
  const domain = name.toLowerCase().replace(/[^a-z]+/g, '') + '.example'
  const contacts = Array.from({ length: i % 3 === 0 ? 2 + (i % 2) : 0 }, (_, k) => {
    const last = LAST_NAMES[(i + k * 3) % LAST_NAMES.length]
    return { attributes: { type: 'Contact' }, LastName: last, Email: `${last.toLowerCase()}@${domain}` }
  })
  return {
    attributes: { type: 'Account', url: `/services/data/v62.0/sobjects/Account/001${i}` },
    Id: `001${String(i).padStart(15, '0')}`,
    Name: name,
    Type: TYPES[i % TYPES.length],
    Industry: industry,
    AnnualRevenue: (((i * 7919) % 480) + 2) * 250000,
    CreatedDate: new Date(Date.UTC(2026, 9, 1) - ((i * 37) % 90) * 86400000).toISOString().replace('Z', '+0000'),
    Owner: i % 7 === 0 ? null : { attributes: { type: 'User' }, Name: OWNERS[i % OWNERS.length] },
    Contacts: contacts.length ? { totalSize: contacts.length, done: true, records: contacts } : null
  }
}
const ACCOUNTS = Array.from({ length: TOTAL }, (_, i) => account(i + 1))
const ACCOUNT_FIELDS = new Set(describes.Account.fields.map((f) => f.name.toLowerCase()))

/** Top-level SELECT items (subqueries kept whole). */
const selectItems = (q) => {
  const m = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+Account\b/i.exec(q)
  if (!m) return null
  const items = []
  let depth = 0
  let start = 0
  const list = m[1]
  for (let i = 0; i <= list.length; i++) {
    const c = list[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if ((c === ',' && depth === 0) || i === list.length) {
      items.push({ text: list.slice(start, i).trim(), offset: m.index + m[0].indexOf(list) + start + (list.slice(start, i).length - list.slice(start, i).trimStart().length) })
      start = i + 1
    }
  }
  return items
}

/** Salesforce-style INVALID_FIELD for an unknown plain field in the SELECT list, with row/column. */
const invalidField = (q, items) => {
  const bad = items.find((it) => /^\w+$/.test(it.text) && !ACCOUNT_FIELDS.has(it.text.toLowerCase()))
  if (!bad) return null
  const before = q.slice(0, bad.offset).split('\n')
  const row = before.length
  const column = before[before.length - 1].length + 1
  const line = q.split('\n')[row - 1]
  return {
    errorCode: 'INVALID_FIELD',
    message: `\n${line}\n${' '.repeat(column - 1)}^\nERROR at Row:${row}:Column:${column}\nNo such column '${bad.text}' on entity 'Account'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name. Please reference your WSDL or the describe call for the appropriate names.`
  }
}

/** Just enough SOQL for screenshots: Type IN (…), AnnualRevenue > n, ORDER BY field [DESC], LIMIT n, and the selected fields. */
const runAccountQuery = (q, items) => {
  let rows = ACCOUNTS
  const types = /\bType\s+IN\s*\(([^)]*)\)/i.exec(q)
  if (types) {
    const allowed = types[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    rows = rows.filter((r) => allowed.includes(r.Type))
  }
  const min = /\bAnnualRevenue\s*>\s*(\d+)/i.exec(q)
  if (min) rows = rows.filter((r) => r.AnnualRevenue > Number(min[1]))
  const order = /\bORDER\s+BY\s+(\w+)(\s+DESC)?/i.exec(q.replace(/\([^()]*\)/g, ''))
  if (order) {
    const f = describes.Account.fields.find((x) => x.name.toLowerCase() === order[1].toLowerCase())?.name
    if (f) rows = [...rows].sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (order[2] ? -1 : 1))
  }
  const limit = /\bLIMIT\s+(\d+)\s*$/i.exec(q)
  if (limit) rows = rows.slice(0, Number(limit[1]))
  // Keep only what was selected: plain fields, the first part of a relationship path, subquery relationships.
  const keep = new Set(['attributes'])
  for (const it of items ?? []) {
    const sub = /^\(\s*SELECT[\s\S]+\bFROM\s+(\w+)/i.exec(it.text)
    keep.add((sub ? sub[1] : it.text.split('.')[0]).toLowerCase())
  }
  return items ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k.toLowerCase())))) : rows
}

let lastResult = ACCOUNTS
const page = (offset) => ({
  totalSize: lastResult.length,
  done: offset + PAGE >= lastResult.length,
  ...(offset + PAGE < lastResult.length ? { nextRecordsUrl: `/services/data/v62.0/query/01gMOCK-${offset + PAGE}` } : {}),
  records: lastResult.slice(offset, offset + PAGE)
})

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

createServer((req, res) => {
  const url = new URL(req.url, base)
  const p = url.pathname
  console.log(req.method, p + url.search.slice(0, 80))
  // Salesforce OAuth (web server flow + PKCE): authorize redirects straight back to the callback.
  if (p === '/services/oauth2/authorize') {
    const q = new URLSearchParams({ code: `SFCODE-${++signIns}`, state: url.searchParams.get('state') })
    return send(res, 302, undefined, { Location: `${url.searchParams.get('redirect_uri')}?${q}` })
  }
  if (p === '/services/oauth2/token') {
    readBody(req).then((body) => {
      const params = new URLSearchParams(body)
      if (!params.get('code_verifier') && params.get('grant_type') === 'authorization_code') {
        return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE code_verifier missing' })
      }
      const n = (params.get('code') ?? params.get('refresh_token') ?? '').split('-').pop()
      send(res, 200, {
        access_token: `MOCK_AT-${n}`,
        refresh_token: `MOCK_SF_RT-${n}`,
        instance_url: base,
        id: `https://login.salesforce.com/id/${ORG}/${userId(n)}`,
        token_type: 'Bearer'
      })
    })
    return
  }
  if (p === '/services/oauth2/revoke') return send(res, 200)
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
  // Who owns a (pasted) access token.
  if (p === '/services/oauth2/userinfo') {
    const n = /MOCK_AT-(\d+)/.exec(req.headers.authorization)[1]
    return send(res, 200, { user_id: userId(n), organization_id: ORG, preferred_username: `user${n}@mock.test.prod` })
  }
  if (p === '/services/data/v62.0/query' || p === '/services/data/v62.0/queryAll') {
    const q = url.searchParams.get('q') ?? ''
    if (/FROM User/i.test(q)) {
      const n = /Id = '005(\d{12})AAA'/.exec(q)?.[1] ?? '1'
      return send(res, 200, { totalSize: 1, done: true, records: [userRow(Number(n))] })
    }
    if (/\bFRO\b/i.test(q)) {
      return send(res, 400, [{ errorCode: 'MALFORMED_QUERY', message: `\n${q}\n ^\nERROR at Row:1:Column:11\nunexpected token: FRO` }])
    }
    const items = selectItems(q)
    const invalid = items && invalidField(q, items)
    if (invalid) return send(res, 400, [invalid])
    lastResult = runAccountQuery(q, items)
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
