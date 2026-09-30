# Querynator

Desktop SOQL client for Salesforce (Windows, macOS, Linux). Sign in with Azure AD SSO, see your User record, write SOQL
with metadata-aware autocomplete, view and export results, and ask OpenAI to fix a broken query.

## Features

- **Environments**: several orgs, each with its own Azure and Salesforce-token settings. **Import/Export** them as
  JSON (name included, secrets and tokens never).
- **Azure AD SSO → Salesforce token**: sign in to Azure (authorization code + PKCE) in an in-app window, then the
  Azure access token is exchanged for a Salesforce access token via the company token service. The Azure refresh
  token is stored encrypted with the OS keychain (Electron `safeStorage`), so you stay logged in; expired tokens are
  renewed automatically.
- **Several users per environment**: the user picker next to the environment lists everyone who has logged in to
  that environment; each keeps its own refresh token. **+ Add user…** signs in another account (Azure shows the
  account chooser), picking a user switches to it, **Logout** forgets only the active user.
- **User card**: Id, name, email, username, profile, role, time zone, org id and instance.
- **SOQL editor** (Monaco): syntax highlighting, **Beautify** (Shift+Alt+F), Ctrl+Enter to run.
- **Autocomplete**: objects after `FROM`, fields of the `FROM` object, relationship paths (`Owner.Manager.`), child
  subqueries (`(SELECT … FROM Contacts)`), picklist values after `=`/`IN (`, and date literals (`LAST_N_DAYS:n`…).
  Metadata is cached per environment; **⟳ Metadata** clears the cache.
- **Results**: 500-row pages with **Load more**, relationship columns flattened (`Owner.Name`), child subquery cells
  open in a popup, export to **CSV**/**JSON**, **Copy** as tab-separated text for spreadsheets, `queryAll` toggle.
- **History**: the last 100 queries per environment, searchable; click to load.
- **Objects tab**: browse every queryable object (search, custom-only filter) and inspect its fields — API name,
  label, type (`Text(255)`, `Lookup(User)`, `Currency(16, 2)`…), Required / Custom / Formula / External ID / Unique
  flags, help text, picklist values — plus child relationships for subqueries. Click a name to copy it, click a lookup
  target or child object to open it, tick fields and **Query selected** to write the SELECT into the editor.
- **Fix with AI**: sends the query, the Salesforce error and the object's field list to OpenAI and shows a diff you can
  accept or reject.

## Login flow

1. **Azure AD** — authorization code with PKCE. The authorize page opens in a Querynator window, because the
   registered redirect URI uses a custom scheme (`msauth://…`) that a system browser cannot hand back; the app
   intercepts that redirect. Client credentials are sent in the token request body. `offline_access` is added to the
   scope so Azure returns a refresh token. The window keeps its SSO cookies, so later sign-ins are usually one click.
2. **Salesforce token** — `GET <SF token URL>` with `Authorization: Bearer <Azure access token>` returns
   `access_token`, `instance_url` and `id` (user and org ids).
3. When Salesforce answers 401, step 2 is repeated; the Azure token is refreshed first if it has expired or the token
   service rejects it. If the Azure refresh token is no longer valid, that user is marked "login required".

Each sign-in is stored as a user of the environment, keyed by the Salesforce user id from step 2, so signing in again
as the same person updates that user instead of adding a duplicate. Users belong to one environment; switching the
environment switches the list. History and the metadata cache are per environment.

### Environment settings

| Field | Example |
|---|---|
| Auth URL | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` |
| Token URL | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` |
| Client ID | Azure app registration id |
| Scope | `api://<your-api>/<scope> …` |
| Callback URL | `msauth://<bundle-id>/<signature>` (must match the Azure app registration) |
| SF token URL | `https://<token-service>/…` — returns the Salesforce token for an Azure token |
| Client secret | optional, only for confidential clients |

Use **⚙ Settings → Import…** to add environments from a JSON export. **Export…** writes one environment, **Export
all…** all of them. Importing an environment whose name already exists updates it. `scripts/mock-environment.json`
shows the format.

For **Fix with AI**, paste your OpenAI API key and pick a model in Settings. The key is stored encrypted.

## Development

Requires Node 20.19+ or 22.12+.

```bash
npm install
```

```bash
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Build into `out/` |
| `npm run dist:win` | Windows installer (`Querynator Setup x.y.z.exe`) — on Windows |
| `npm run dist:linux` | Linux `AppImage`, `.deb`, `tar.gz` — on Windows via Docker Desktop |
| `npm run dist:mac` | macOS `.dmg` + `.zip` for Intel and Apple Silicon — on a Mac only |

`.npmrc` sets `legacy-peer-deps=true` to work around an npm 10.8 bug with Vitest's optional peer dependencies.

### Project layout

```
src/shared/     types and the typed IPC contract (Api)
src/soql/       pure SOQL logic: tokenizer, cursor context, completions, flatten, export, beautify
src/main/       Electron main process: OAuth, Salesforce + OpenAI clients, stores, AppService, IPC
src/preload/    exposes window.api to the renderer
src/renderer/   React UI and Monaco setup
tests/          Vitest tests for soql/ and main/
scripts/        mock Azure + Salesforce server for local smoke testing
```

All network calls and secrets live in the main process; the renderer only talks to `window.api`.

### Smoke test without a real org

`scripts/mock-salesforce.mjs` fakes Azure AD, the Salesforce token service, queries (1,200 accounts in 500-row pages)
and describes.
It also answers the OpenAI chat endpoint by fixing `FRO` → `FROM`. A development-only driver
(`src/main/devSmoke.ts`) logs in, runs a query and loads more, opens a subquery cell, checks picklist and relationship
autocomplete, Beautify, the error marker, silent reconnect after a reload, Fix with AI, and adding/switching/logging
out users (every mock sign-in is a new user), saving screenshots. Using a throwaway profile keeps your real settings untouched:

```bash
node scripts/mock-salesforce.mjs 8787
```

Create `<profile>/settings.json` containing the environment from `scripts/mock-environment.json` (with an `id`), then:

```bash
npm run build && QN_USER_DATA=<profile> QN_SMOKE=<screenshot dir> QN_OPENAI_URL=http://127.0.0.1:8787/v1/chat/completions npx electron-vite preview
```

## Installers

| Platform | Files | Notes |
|---|---|---|
| Windows | `Querynator Setup x.y.z.exe` | Not code-signed: SmartScreen shows "Windows protected your PC" → **More info → Run anyway**. |
| Linux | `Querynator-x.y.z.AppImage`, `querynator_x.y.z_amd64.deb`, `querynator-x.y.z.tar.gz` | `.deb`: `sudo apt install ./querynator_x.y.z_amd64.deb`. AppImage: `chmod +x` and run. Token storage uses the desktop keyring (libsecret). |
| macOS | `Querynator-x.y.z-arm64.dmg`, `Querynator-x.y.z.dmg` (Intel), plus `.zip` | Ad-hoc signed, not notarized: first launch via right-click → **Open**, or `xattr -dr com.apple.quarantine /Applications/Querynator.app`. |

macOS packages can only be built on a Mac. `.github/workflows/build.yml` builds all three platforms on GitHub-hosted
runners (Actions → **Build installers** → Run workflow, or push a `v*` tag) and attaches them as artifacts.

The app icon (`build/icon.png`, `resources/icon.png`) and the splash image (`resources/splash.png`) come from the
Querynator logo; the splash shows while the main window loads.

## Data locations

Everything is stored in the OS app-data folder (e.g. `%APPDATA%\querynator` on Windows): `settings.json`,
`secrets.bin` (encrypted), `history/`, `meta/` (describe cache) and `logs/main.log`.
