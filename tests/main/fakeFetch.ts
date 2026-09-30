import type { FetchFn } from '../../src/main/errors'

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Routes by "METHOD urlSubstring". The first matching route wins; routes registered with `once`
 * are consumed after one use. Unmatched requests fail the test loudly.
 */
export function fakeFetch() {
  const routes: { key: string; handler: Handler; once: boolean }[] = []
  const requests: RecordedRequest[] = []

  const fetchFn: FetchFn = async (input, init = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k] = v))
    const req: RecordedRequest = { url: input, method: init.method ?? 'GET', headers, body: init.body as string | undefined }
    requests.push(req)
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const idx = routes.findIndex((r) => {
      const [method, part] = r.key.split(' ', 2)
      return method === req.method && req.url.includes(part)
    })
    if (idx < 0) throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    const route = routes[idx]
    if (route.once) routes.splice(idx, 1)
    const signal = init.signal
    if (!signal) return route.handler(req)
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      Promise.resolve(route.handler(req)).then(resolve, reject)
    })
  }

  return {
    fetchFn,
    requests,
    on(key: string, handler: Handler | Response) {
      routes.push({ key, handler: typeof handler === 'function' ? handler : () => handler.clone(), once: false })
      return this
    },
    once(key: string, handler: Handler | Response) {
      routes.push({ key, handler: typeof handler === 'function' ? handler : () => handler, once: true })
      return this
    }
  }
}
