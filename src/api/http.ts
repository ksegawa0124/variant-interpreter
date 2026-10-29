// 外部 API 呼び出しの共通基盤。
// 失敗してもアプリ全体は落とさず、SourceResult として「取得失敗」を返す。

export type SourceResult<T> =
  | { status: 'ok'; source: string; url: string; fetchedAt: string; data: T }
  | { status: 'failed'; source: string; url: string; fetchedAt: string; error: string }

export interface HttpOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  headers?: Record<string, string>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Retry-After（秒数 or HTTP 日付）をミリ秒へ。解釈できなければ null。 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const sec = Number(value)
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** 指数バックオフ（attempt は 0 始まり）。 */
export function backoffDelay(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** attempt)
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** JSON を取得する。429/5xx/ネットワーク/タイムアウトは指数バックオフで再試行し、Retry-After を尊重する。 */
export async function fetchJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const {
    fetchImpl = fetch,
    sleep = defaultSleep,
    timeoutMs = 20000,
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 15000,
    headers = { Accept: 'application/json' },
  } = opts

  let lastError: Error = new Error('unknown error')
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let waitMs = backoffDelay(attempt, baseDelayMs, maxDelayMs)
    try {
      const res = await fetchImpl(url, { headers, signal: ctrl.signal })
      if (res.ok) return (await res.json()) as T
      lastError = new HttpError(res.status, `HTTP ${res.status}`)
      if (!RETRYABLE.has(res.status)) throw lastError
      const ra = parseRetryAfter(res.headers.get('Retry-After'))
      if (ra !== null) waitMs = Math.max(waitMs, ra)
    } catch (e) {
      if (e instanceof HttpError && !RETRYABLE.has(e.status)) throw e
      if (!(e instanceof HttpError)) {
        lastError = new Error(
          e instanceof DOMException && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(e),
        )
      }
    } finally {
      clearTimeout(timer)
    }
    if (attempt < maxRetries) await sleep(waitMs)
  }
  throw lastError
}

/** fetchJson を SourceResult に包む。例外は投げない。 */
export async function wrapSource<T>(
  source: string,
  url: string,
  opts: HttpOptions = {},
  transform: (raw: unknown) => T = (raw) => raw as T,
): Promise<SourceResult<T>> {
  const fetchedAt = new Date().toISOString()
  try {
    const raw = await fetchJson<unknown>(url, opts)
    return { status: 'ok', source, url, fetchedAt, data: transform(raw) }
  } catch (e) {
    return { status: 'failed', source, url, fetchedAt, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 最小間隔でリクエストを直列化する簡易レートリミッタ（Ensembl: 15 req/s 以内）。 */
export function createRateLimiter(minIntervalMs: number, sleep = defaultSleep, now = Date.now) {
  let nextAt = 0
  return async function acquire(): Promise<void> {
    const t = now()
    const wait = Math.max(0, nextAt - t)
    nextAt = Math.max(t, nextAt) + minIntervalMs
    if (wait > 0) await sleep(wait)
  }
}
