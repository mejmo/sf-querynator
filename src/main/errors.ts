import type { AppError } from '../shared/types'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Error from a Salesforce REST call (non-2xx other than an unrecoverable 401). */
export class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message)
    this.name = 'SalesforceApiError'
  }
}

/** No valid session and it cannot be refreshed: the user has to log in again. */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired. Please log in again.') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

/** OAuth endpoint or login-flow error. `code` is e.g. invalid_grant, access_denied, PORT_IN_USE, STATE_MISMATCH, TIMEOUT. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'OpenAiError'
  }
}

/** User-fixable configuration problem (missing key, unknown environment...). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR')
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function toAppError(e: unknown): AppError {
  if (e instanceof SalesforceApiError) return { kind: 'salesforce', code: e.errorCode, message: e.message }
  if (e instanceof SessionExpiredError) return { kind: 'auth', code: 'SESSION_EXPIRED', message: e.message }
  if (e instanceof OAuthError) {
    return e.code === 'CANCELLED'
      ? { kind: 'cancelled', message: e.message }
      : { kind: 'auth', code: e.code, message: e.message }
  }
  if (e instanceof OpenAiError) return { kind: 'ai', code: String(e.status), message: e.message }
  if (e instanceof ConfigError) return { kind: 'config', message: e.message }
  if (isAbortError(e)) return { kind: 'cancelled', message: 'Cancelled' }
  if (e instanceof TypeError || /net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(errorMessage(e))) {
    return { kind: 'network', message: `Network error: ${errorMessage(e)}` }
  }
  return { kind: 'unknown', message: errorMessage(e) }
}
