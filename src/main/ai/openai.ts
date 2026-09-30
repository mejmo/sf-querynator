import type { AiSuggestion } from '../../shared/types'
import { OpenAiError, type FetchFn } from '../errors'

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_FIELDS = 800

export interface FixRequest {
  soql: string
  error: string | null
  objectName: string | null
  fields: { name: string; type: string }[]
  apiVersion: string
}

const SYSTEM_PROMPT = [
  'You are an expert in Salesforce SOQL.',
  'Fix the user\'s SOQL query so it is valid and matches their evident intent.',
  'Only use fields that exist in the provided field list when one is given. Keep the query otherwise unchanged.',
  'Respond with a JSON object: {"query": "<corrected SOQL>", "explanation": "<one or two sentences>"}.',
  'Do not include markdown or code fences in the query.'
].join(' ')

export function buildUserPrompt(r: FixRequest): string {
  const parts = [`API version: ${r.apiVersion}`, `Query:\n${r.soql}`]
  if (r.error) parts.push(`Error:\n${r.error}`)
  if (r.objectName && r.fields.length) {
    const list = r.fields
      .slice(0, MAX_FIELDS)
      .map((f) => `${f.name} (${f.type})`)
      .join(', ')
    parts.push(`Fields of ${r.objectName}: ${list}`)
  }
  return parts.join('\n\n')
}

export async function suggestFix(
  fetchFn: FetchFn,
  p: { apiKey: string; model: string; request: FixRequest; signal?: AbortSignal; url?: string }
): Promise<AiSuggestion> {
  const res = await fetchFn(p.url ?? OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(p.request) }
      ]
    }),
    signal: p.signal
  })
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string }
    choices?: { message?: { content?: string } }[]
  } | null
  if (!res.ok) {
    const reason = data?.error?.message ?? res.statusText
    const prefix = res.status === 401 ? 'OpenAI rejected the API key' : res.status === 429 ? 'OpenAI rate limit or quota exceeded' : 'OpenAI error'
    throw new OpenAiError(res.status, `${prefix}: ${reason}`)
  }
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '') as Partial<AiSuggestion>
    if (typeof parsed.query !== 'string' || !parsed.query.trim()) throw new Error('missing query')
    return { query: parsed.query.trim(), explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' }
  } catch {
    throw new OpenAiError(0, "Couldn't parse the AI suggestion. Try again.")
  }
}
