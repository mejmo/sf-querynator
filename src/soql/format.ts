import { formatQuery } from '@jetstreamapp/soql-parser-js'

export type BeautifyResult = { ok: true; text: string } | { ok: false; error: string }

export function beautify(soql: string): BeautifyResult {
  try {
    return { ok: true, text: formatQuery(soql, { fieldMaxLineLength: 60 }) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Salesforce MALFORMED_QUERY messages contain "Row:1:Column:11" (both 1-based). */
export function parseErrorPosition(message: string): { line: number; column: number } | null {
  const m = /Row:(\d+):Column:(\d+)/.exec(message)
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null
}
