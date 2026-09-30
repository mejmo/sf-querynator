# Querynator — Design Spec

Date: 2026-09-30
Status: Approved (brainstorming)

## 1. Purpose

A cross-platform desktop app (Windows / macOS / Linux) for running SOQL queries against Salesforce orgs. The user logs in via OAuth, sees their User record, writes SOQL in a highlighted editor with metadata-aware autocomplete, views results in a grid, and can ask OpenAI to fix a broken query.

## 2. Scope

In scope:
- Multiple environments (orgs), add/edit/delete/switch
- OAuth 2.0 Web Server flow with PKCE (browser login + localhost callback), refresh tokens
- User card after login (Id, Name, Email, Username, Profile, Role, Org Id, Instance URL, Time zone)
- SOQL editor: syntax highlighting, autocomplete, Beautify (format)
- Query execution with 500-row pages, Load more, CSV/JSON export, copy
- Optional `queryAll` toggle
- Automatic per-environment query history (last 100, searchable)
- AI "Fix with AI" using the OpenAI API directly
- Settings: environments, API version, OpenAI key + model, callback port

Out of scope (YAGNI): saved/favorite queries, multiple editor tabs, DML/record editing, Tooling API, Bulk API, other auth flows, auto-update, code signing.

## 3. Tech stack

- Electron + `electron-vite` + Vite
- React + TypeScript, Zustand for UI state
- `monaco-editor` (bundled locally) — highlighting, completion, diff view
- `@jetstreamapp/soql-parser-js` — Beautify (parse + compose with formatting)
- `@tanstack/react-virtual` for the virtualized result grid (no sorting/filtering, so no table library)
- `electron-builder` for installers
- Vitest for tests; HTTP clients take an injected `fetch` so tests use fakes; main process uses Electron `net.fetch` (honours system proxy)

## 4. Architecture

### 4.1 Main process (Node) — owns all network I/O and secrets

| Module | Responsibility |
|---|---|
| `auth/oauth.ts` | PKCE (verifier/challenge, `state`), open system browser to `{loginUrl}/services/oauth2/authorize`, loopback HTTP server on `127.0.0.1:{port}` (default 1717, path `/oauth/callback`), code→token exchange, refresh, revoke |
| `sf/client.ts` | REST calls against `{instanceUrl}/services/data/v{apiVersion}`: `query`, `queryAll`, `nextRecordsUrl`, global describe `/sobjects`, `/sobjects/{X}/describe`. User/org ids come from the token response `id` URL (no userinfo call, no `openid` scope). Sends `Sforce-Query-Options: batchSize=500`. On 401: refresh once, retry once. Supports cancellation (AbortController). |
| `ai/openai.ts` | POST `https://api.openai.com/v1/chat/completions` with configured model; JSON response format `{ "query": string, "explanation": string }` |
| `store/settings.ts` | `settings.json` read/write |
| `store/secrets.ts` | `secrets.bin` encrypted via Electron `safeStorage` |
| `store/history.ts` | `history/<envId>.json`, newest first, cap 100; re-running an identical query moves it to the top instead of duplicating |
| `store/metaCache.ts` | `meta/<envId>/_global.json`, `meta/<envId>/<Object>.json` |
| `ipc.ts` | Typed IPC handlers; exposed via preload `contextBridge` as `window.api` |

### 4.2 Renderer (React)

| Component | Responsibility |
|---|---|
| `EnvironmentBar` | Env dropdown, connection indicator, Login/Logout, ⟳ Metadata, ⚙ Settings |
| `UserCard` | Displays current user info |
| `SoqlEditor` | Monaco with SOQL language (Monarch tokenizer), completion provider, document formatter, error markers |
| Toolbar | Run (Ctrl+Enter), Beautify (Shift+Alt+F), Fix with AI, queryAll checkbox, Cancel while running |
| `ResultsGrid` | Flattened columns, virtualized rows, status line (total / loaded / ms), Load more, CSV, JSON, Copy; subquery cells open a popover grid |
| `HistoryPanel` | Searchable list (✓/✗ status, preview); click loads into editor |
| `AiFixDialog` | Monaco diff (original vs. suggested) + explanation, Accept/Reject |
| `SettingsDialog` | Environments CRUD, OpenAI key (masked: set/replace/clear), model (default `gpt-4o`), callback port |

### 4.3 Pure module `soql/` (no Electron/React deps)

- `tokenizer.ts` — tolerant tokenizer for partial SOQL
- `context.ts` — `getCompletionContext(text, offset)` returns one of:
  - `keyword`
  - `object` (after `FROM`)
  - `field { objectPath: string[], clause }` — resolves the `FROM` object of the innermost (sub)query; for child subqueries, maps the relationship name (e.g. `Contacts`) to the child object via parent describe `childRelationships`; for dot paths (`Owner.Manager.`) walks `referenceTo`/`relationshipName`
  - `value { object, field }` — after a comparison operator / `IN (`; yields picklist values and, for date/datetime fields, date literals (`TODAY`, `YESTERDAY`, `LAST_N_DAYS:n`, `THIS_MONTH`, …)
- `completions.ts` — context + metadata accessor → suggestion list
- `flatten.ts` — records → flat rows/columns (relationship paths as `A.B.C`, nested subquery results kept as record arrays)
- `export.ts` — CSV (RFC 4180) and JSON

## 5. Data flows

1. **First run:** Settings opens; user adds environment `{name, loginUrl, clientId, clientSecret?, apiVersion (default 62.0)}` and OpenAI key/model.
2. **Login:** PKCE authorize in system browser → callback on loopback → token exchange → store tokens encrypted → parse user/org id from token `id` URL + `SELECT Id, Name, Email, Username, Profile.Name, UserRole.Name, TimeZoneSidKey FROM User WHERE Id = :userId` → UserCard → background global describe.
3. **Environment switch:** if a refresh token exists, silently refresh; otherwise show Login.
4. **Run:** query with batch 500 → grid; Load more follows `nextRecordsUrl`; history entry `{query, ranAt, rowCount, durationMs, error?}` saved.
5. **Autocomplete:** object describes fetched lazily on first need, cached to disk; ⟳ Metadata clears the env cache.
6. **Beautify:** `formatQuery(text, { fieldMaxLineLength: 60 })` from soql-parser-js; parse failure → text unchanged, notice shown.
7. **Fix with AI:** send query, last error (Salesforce or parser), FROM-object field names + types, API version → show diff → Accept replaces editor text.

## 6. Storage & security

Location: Electron `userData` directory.

- `settings.json` — no secrets
- `secrets.bin` — per-env `{refreshToken, accessToken, instanceUrl, clientSecret?}` + OpenAI key; encrypted with `safeStorage`
- `history/<envId>.json`, `meta/<envId>/…` — plain JSON
- `logs/main.log`

Rules:
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, no remote scripts. Tokens and keys never sent to the renderer.
- Loopback server binds loopback only (`127.0.0.1` and `::1`, since browsers may resolve `localhost` to either), validates `state`, accepts one callback, closes after success or 2-minute timeout.
- Logout: revoke token, delete env secrets. Delete env: remove secrets, history, meta cache.

## 7. Error handling

- Salesforce query errors: show `errorCode` + message above the grid; parse `Row:x Column:y` into a Monaco marker; record in history.
- Network/timeout: banner with Retry; Cancel aborts request, grid keeps previous state.
- 401 → one refresh + retry; `invalid_grant` → environment "Logged out".
- OAuth: port busy, access denied, state mismatch, timeout → specific messages.
- AI: missing key → button disabled with hint; OpenAI 401/429/other → shown in dialog; unparseable response → "Couldn't parse suggestion"; nothing applied without Accept.
- Describe failure → keyword-only completion.
- Unexpected main-process errors → log file + generic toast.

## 8. Testing

- `soql/context` — table-driven cursor-marker tests: SELECT list, WHERE, ORDER BY/GROUP BY, multi-level relationship paths, child subqueries, value positions, date literals, incomplete input.
- `soql/completions` — with fake metadata.
- `soql/flatten`, `soql/export` — nested relationships, null parents, subquery cells, CSV escaping.
- `sf/client`, `auth/oauth`, `ai/openai`, `AppService` — fake `fetch`: PKCE params, 401 refresh/retry, paging, batchSize header, error mapping.
- Stores — temp dir + stubbed `safeStorage`: history cap, delete cascade.
- Manual smoke checklist against a real org (login, user card, query, load more, export, autocomplete, beautify, AI fix, logout).

## 9. Connected App prerequisites (user side)

- Callback URL: `http://localhost:1717/oauth/callback` (must match configured port)
- OAuth scopes: `api`, `refresh_token` (the app does not send a `scope` parameter; the Connected App's configured scopes apply)
- PKCE enabled; "Require secret" optional (app supports supplying the Consumer Secret)

## 10. Amendment: Azure AD SSO login (supersedes the Salesforce OAuth parts of §4.1, §5.2, §6, §9)

- Environment = `{ name, authUrl, tokenUrl, clientId, scope, redirectUri, sfTokenUrl, apiVersion }` (+ optional
  client secret stored encrypted). The loopback callback server and callback-port setting are removed.
- Login: Azure authorization code + PKCE in an in-app `BrowserWindow` (partition `persist:sso`); the redirect to the
  registered custom-scheme URI (`msauth://…`) is intercepted (`will-redirect` / `will-navigate` / `did-fail-load`).
  Token request sends client credentials in the body; `offline_access` is appended to the scope.
- `GET sfTokenUrl` with `Authorization: Bearer <Azure access token>` returns the Salesforce `access_token`,
  `instance_url` and identity `id`.
- Renewal: Salesforce 401 → new Salesforce token; Azure token refreshed first when expired (60 s margin) or when the
  token service answers 401; Azure `invalid_grant` → logged out.
- Stored per environment (encrypted): Azure access/refresh token + expiry, Salesforce access token, instance URL,
  user/org id. Logout clears them; the SSO cookie in the sign-in window is kept.
- Import/export: JSON `{ format: "querynator-environments", version: 1, environments: [...] }` without ids, secrets or
  tokens. Import validates all entries first; a matching name (case-insensitive) updates the existing environment.

## 11. Amendment: several users per environment

- Secrets per environment: `{ clientSecret?, activeAccountId?, accounts: { [salesforceUserId]: { name, username,
  accessToken, instanceUrl, orgId, azureAccessToken, azureRefreshToken, azureExpiresAt } } }`. The earlier flat
  single-session format is migrated on read.
- Login adds or updates the account identified by the Salesforce user id and makes it active. Queries, metadata and
  the AI helper use the active account. A failed renewal clears only that account's tokens (it stays listed as
  "login required").
- API: `connect`, `login`, `switchAccount`, `logout` return `EnvSession { accounts, activeAccountId, state }`;
  `logout` removes the active account.
- UI: user picker next to the environment picker with "+ Add user…"; switching environment reloads the list.
