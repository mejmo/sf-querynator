<p align="center">
  <img src="docs/images/logo.png" alt="Querynator — Salesforce SOQL" width="520" />
</p>

<p align="center">Desktop SOQL client for Salesforce — Windows, macOS and Linux.</p>

![Query results](docs/images/results.png)

## Features

- **Azure AD SSO** → Salesforce token, several environments, several users per environment
- **SOQL editor** with highlighting, Beautify and context-aware autocomplete (fields, relationships, picklists, date literals)
- **Results grid** with Load more, subquery drill-down and CSV / JSON / clipboard export
- **Objects tab** to browse objects, fields, picklist values and child relationships
- **Fix with AI** (OpenAI) with a side-by-side diff
- **Query history**, User card, environment import/export

| Autocomplete | Objects | Fix with AI |
|---|---|---|
| ![Autocomplete](docs/images/autocomplete.png) | ![Objects tab](docs/images/objects.png) | ![Fix with AI](docs/images/ai-fix.png) |

## Setup

Open **⚙ Settings → Add environment** (or **Import…** a JSON export) and fill in:

| Field | Example |
|---|---|
| Auth URL / Token URL | `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` · `…/token` |
| Client ID, Scope | Azure app registration id, `api://<your-api>/<scope> …` |
| Callback URL | `msauth://<bundle-id>/<signature>` — must match the Azure app registration |
| SF token URL | Service that returns a Salesforce token for an Azure token |
| Client secret | Optional, confidential clients only |

For **Fix with AI**, add an OpenAI API key and model in the same dialog.

**How login works:** Azure sign-in (auth code + PKCE) runs in an app window that catches the `msauth://` redirect.
The Azure token is exchanged at the SF token URL (`Authorization: Bearer …`) for a Salesforce token and instance URL.
Tokens are renewed automatically. Refresh tokens and keys are encrypted with the OS keychain, and exports never
contain secrets.

## Installers

| Platform | Files | First launch |
|---|---|---|
| Windows | `Querynator Setup x.y.z.exe` | Unsigned: SmartScreen → **More info → Run anyway** |
| Linux | `.AppImage`, `.deb`, `.tar.gz` | `sudo apt install ./querynator_*.deb` or `chmod +x` the AppImage |
| macOS | `.dmg` / `.zip` (Intel + Apple Silicon) | Not notarized: right-click → **Open** |

GitHub Actions (**Build installers**, or push a `v*` tag) builds all three. macOS can only be built on a Mac.

## Development

Requires Node 20.19+ or 22.12+.

```bash
npm install
```

```bash
npm run dev
```

| Script | |
|---|---|
| `npm test` / `npm run typecheck` | Vitest unit tests / TypeScript check |
| `npm run build` | Build into `out/` |
| `npm run dist:win` · `dist:linux` · `dist:mac` | Installers (Linux via Docker on Windows; macOS on a Mac) |

```
src/soql/       SOQL tokenizer, cursor context, completions, flatten, export, beautify
src/main/       Electron main: Azure/Salesforce/OpenAI clients, encrypted stores, IPC
src/renderer/   React UI + Monaco
tests/          Vitest
scripts/        mock Azure + Salesforce server for smoke tests
```

**Smoke test without an org:** run `node scripts/mock-salesforce.mjs 8787`, create `<profile>/settings.json` with the
environment from `scripts/mock-environment.json` (plus an `id`), then run
`QN_USER_DATA=<profile> QN_SMOKE=<dir> QN_OPENAI_URL=http://127.0.0.1:8787/v1/chat/completions npx electron-vite preview`
after `npm run build`. It clicks through the whole app and saves screenshots to `<dir>`.

App data lives in the OS app-data folder (`%APPDATA%\Querynator` on Windows).
