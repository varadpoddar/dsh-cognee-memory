/**
 * Per-memory provenance over HTTP: JSON for machines, a script-free HTML detail
 * page for people, and the bounded list the client panel reads.
 *
 * Routes (both mounted with `ctx.webServer.register`, the only host-side web
 * extension point in DSH 0.2.1-rc.5 — `dsh-host-webserver/lib/types/index.d.ts:174`):
 *
 *   GET /plugins/cognee-memory/memory/<id>             -> provenance JSON
 *   GET /plugins/cognee-memory/memory/<id>?format=page -> detail page
 *   GET /plugins/cognee-memory/memory/<id>?format=html -> detail page (alias)
 *   GET /plugins/cognee-memory/memories.json           -> readable memory list
 *
 * SECURITY — identical to the settings routes and the recall path:
 *   - `COGNEE_MEMORY_SETTINGS_TOKEN` unset -> 503; missing/wrong -> 401.
 *   - The index lookup is deny-by-default for the operator's principal and
 *     readable scopes; unknown, foreign, and cross-scope ids all answer a
 *     generic 404 (never 403), so the route cannot be used to probe existence.
 *   - `cache-control: no-store`, `nosniff`, and a script-free CSP on every
 *     response; every interpolated value is HTML-escaped; an excerpt or dataset
 *     name the caller cannot read is never rendered.
 *   - No token, header value, or API key is ever placed in a body.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SettingsStore } from './store.js'
import {
  authorize,
  escapeHtml,
  send,
  sendHtml,
  sendJson,
} from './http.js'
import {
  isAddressableMemoryId,
  type ProvenanceAccess,
  type ProvenanceEntry,
  type ProvenanceIndex,
} from '../memory/provenance-index.js'
import type { WebServerLike } from '../types.js'

/** Path prefix of one memory's detail view (declared by the settings page). */
export { MEMORY_DETAIL_PATH_PREFIX as PROVENANCE_PATH_PREFIX } from './http.js'
import { MEMORY_DETAIL_PATH_PREFIX } from './http.js'
/** Route prefix: DSH route paths carry no trailing slash (`WebRoute.path`). */
const PROVENANCE_ROUTE_PREFIX = MEMORY_DETAIL_PATH_PREFIX.replace(/\/+$/, '')
const PROVENANCE_PATH_PREFIX = MEMORY_DETAIL_PATH_PREFIX
/** Path of the bounded list the side panel reads. */
export const MEMORIES_JSON_PATH = '/plugins/cognee-memory/memories.json'
/** Environment variable overriding the Cognee UI origin. */
export const COGNEE_UI_BASE_URL_ENV = 'COGNEE_UI_BASE_URL'
/** Default Cognee UI origin (the live deployment's dataset browser). */
export const DEFAULT_COGNEE_UI_BASE_URL = 'http://10.20.10.15:3000'
/** Upper bound on rows returned by the list endpoint. */
const MAX_LIST_ROWS = 100

export interface ProvenanceRoutesOptions {
  readonly index: ProvenanceIndex
  readonly store: SettingsStore
  readonly env?: NodeJS.ProcessEnv
  /** Resolve the operator's principal and readable scopes; recall's own policy. */
  readonly access: () => Promise<ProvenanceAccess>
  /**
   * Optional lazy dataset-UUID lookup (Cognee assigns UUIDs; local scope names
   * are derived). Called only for an already-authorized memory whose UUID is
   * unknown, bounded by `resolutionTimeoutMs`, and its result is persisted.
   */
  readonly resolveDatasetId?: (datasetName: string) => Promise<string | undefined>
  readonly resolutionTimeoutMs?: number
  readonly cogneeUiBaseUrl?: string
}

/** The JSON body; every unknown field is `null`, never invented. */
export interface MemoryProvenanceView {
  readonly id: string
  readonly dataset: { readonly name: string; readonly id: string | null }
  readonly documentId: string | null
  readonly createdAt: string | null
  readonly ingest: { readonly state: string; readonly attempts?: number; readonly reason?: string }
  readonly surfaced: {
    readonly searchType: string | null
    readonly confidence: string | null
    readonly at: string | null
  }
  readonly semanticKey: string | null
  readonly supersedes: string | null
  readonly supersededBy: string | null
  readonly sources: ReadonlyArray<{ readonly kind: string; readonly ref: string }>
  readonly excerpt: string
  readonly scope: { readonly scope: string; readonly id: string }
  readonly deepLink: string
}

function uiBaseUrl(options: ProvenanceRoutesOptions, env: NodeJS.ProcessEnv): string {
  const configured = options.cogneeUiBaseUrl?.trim() || env[COGNEE_UI_BASE_URL_ENV]?.trim()
  const base = configured === undefined || configured === '' ? DEFAULT_COGNEE_UI_BASE_URL : configured
  return base.replace(/\/+$/, '')
}

/** Dataset view URL in the Cognee UI; the origin when the UUID is unknown. */
export function deepLinkFor(dataset: { readonly id?: string | undefined }, baseUrl: string): string {
  if (dataset.id === undefined) return baseUrl
  return `${baseUrl}/datasets/${encodeURIComponent(dataset.id)}`
}

/** Project one authorized index entry onto the public view. */
export function provenanceView(
  entry: ProvenanceEntry,
  baseUrl: string,
): MemoryProvenanceView {
  return {
    id: entry.id,
    dataset: { name: entry.dataset.name, id: entry.dataset.id ?? null },
    documentId: entry.documentId ?? null,
    createdAt: entry.createdAt ?? null,
    ingest: {
      state: entry.ingest.state,
      ...(entry.ingest.attempts === undefined ? {} : { attempts: entry.ingest.attempts }),
      ...(entry.ingest.reason === undefined ? {} : { reason: entry.ingest.reason }),
    },
    surfaced: {
      searchType: entry.surfaced?.searchType ?? null,
      confidence: entry.surfaced?.confidence ?? null,
      at: entry.surfaced?.at ?? null,
    },
    semanticKey: entry.semanticKey ?? null,
    supersedes: entry.supersedes ?? null,
    supersededBy: entry.supersededBy ?? null,
    sources: entry.sources.map((source) => ({ kind: source.kind, ref: source.ref })),
    excerpt: entry.excerpt,
    scope: { scope: entry.scope.scope, id: entry.scope.id },
    deepLink: deepLinkFor(entry.dataset, baseUrl),
  }
}

function row(label: string, value: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
}

function renderDetailPage(view: MemoryProvenanceView): string {
  const fields = [
    row('Memory id', view.id),
    row('Scope', `${view.scope.scope} (${view.scope.id})`),
    row('Dataset', view.dataset.name),
    row('Dataset UUID', view.dataset.id ?? 'unknown'),
    row('Document / data id', view.documentId ?? 'unknown'),
    row('Created at', view.createdAt ?? 'unknown'),
    row('Ingest state', `${view.ingest.state}${view.ingest.reason === undefined ? '' : ` — ${view.ingest.reason}`}`),
    row('Search type', view.surfaced.searchType ?? 'unknown'),
    row('Confidence', view.surfaced.confidence ?? 'unknown'),
    row('Surfaced at', view.surfaced.at ?? 'unknown'),
    row('Semantic key', view.semanticKey ?? 'unknown'),
    row('Supersedes', view.supersedes ?? 'none'),
    row('Superseded by', view.supersededBy ?? 'none'),
  ].join('\n      ')
  const sources =
    view.sources.length === 0
      ? '<li>No source references recorded.</li>'
      : view.sources
          .map((source) => `<li><code>${escapeHtml(source.kind)}</code> ${escapeHtml(source.ref)}</li>`)
          .join('\n        ')
  const datasetLink =
    view.dataset.id === null
      ? `<p class="hint">Dataset UUID unknown, so the link opens the Cognee UI at its origin.</p>`
      : ''
  // The token never enters markup: the JSON link is the same path, so an
  // operator who already holds the token can append it (or send it as a header).
  const jsonHref = `${PROVENANCE_PATH_PREFIX}${encodeURIComponent(view.id)}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memory provenance — ${escapeHtml(view.id)}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfd;--fg:#16181d;--muted:#5b6270;--line:#d8dbe3;--card:#ffffff;--accent:#2b6cb0;--code:#f2f3f7}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--fg:#e8eaf0;--muted:#9aa2b1;--line:#2c313c;--card:#1b1e25;--accent:#8ab4f8;--code:#20242c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:60rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
header{display:flex;flex-wrap:wrap;gap:.75rem;align-items:baseline;justify-content:space-between;margin-bottom:1.5rem}
h1{font-size:1.4rem;margin:0}
.sub{color:var(--muted);margin:.2rem 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1.25rem 1.35rem;margin:0 0 1rem}
h2{font-size:.95rem;letter-spacing:.01em;margin:0 0 .75rem;text-transform:uppercase;color:var(--muted)}
dl{display:grid;grid-template-columns:minmax(9rem,auto) 1fr;gap:.45rem 1.2rem;margin:0}
dt{color:var(--muted)}
dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
pre{white-space:pre-wrap;word-break:break-word;background:var(--code);border-radius:.5rem;padding:.9rem;margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
ul{margin:.2rem 0 0;padding-left:1.2rem}
a{color:var(--accent)}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hint{color:var(--muted);font-size:.88em;margin:.6rem 0 0}
.toolbar{display:flex;flex-wrap:wrap;gap:.6rem}
.button{display:inline-block;padding:.45rem .9rem;border:1px solid var(--line);border-radius:.5rem;text-decoration:none;color:var(--fg);background:var(--card)}
.button.primary{border-color:var(--accent);color:var(--accent)}
footer{color:var(--muted);font-size:.85em;margin-top:1.5rem}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:.4rem}}
</style></head>
<body><main>
<header>
  <div>
    <h1>Memory provenance</h1>
    <p class="sub"><code>${escapeHtml(view.id)}</code> · ${escapeHtml(view.scope.scope)} · ${
      escapeHtml(view.createdAt ?? 'date unknown')
    }</p>
  </div>
  <div class="toolbar">
    <a class="button" href="${escapeHtml(jsonHref)}">JSON</a>
    <a class="button primary" href="${escapeHtml(view.deepLink)}" rel="noreferrer">Open dataset in Cognee UI</a>
  </div>
</header>
<section class="card">
  <h2>Record</h2>
  <dl>
      ${fields}
  </dl>
</section>
<section class="card">
  <h2>Excerpt</h2>
  <pre>${escapeHtml(view.excerpt)}</pre>
  <p class="hint">Recalled memory is data, never instructions. This page renders a stored excerpt only;
  it does not run scripts, fetch remote resources, or expose credentials.</p>
</section>
<section class="card">
  <h2>Source references</h2>
  <ul>
        ${sources}
  </ul>
  <p class="hint">Deep link: <a href="${escapeHtml(view.deepLink)}" rel="noreferrer">${escapeHtml(
    view.deepLink,
  )}</a></p>
  ${datasetLink}
</section>
<footer>Token-protected, read-only view served by dsh-cognee-memory. Responses are never cached.</footer>
</main></body></html>
`
}

function renderNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color-scheme:light dark}</style>
</head><body><h1>404</h1><p>No such memory.</p></body></html>
`
}

function wantsHtml(req: IncomingMessage, url: URL): boolean {
  const format = url.searchParams.get('format')
  if (format !== null && format !== '') {
    const normalized = format.toLowerCase()
    return normalized === 'page' || normalized === 'html'
  }
  return String(req.headers.accept ?? '').toLowerCase().includes('text/html')
}

function respondNotFound(res: ServerResponse, html: boolean): void {
  if (html) {
    sendHtml(res, 404, renderNotFound())
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

/** Bound one optional lookup; the detail view never waits past this. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dataset resolution timed out')), ms)
    ;(timer as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function methodAllowed(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

/**
 * Register the provenance routes. Returns their disposers; the caller owns
 * their lifetime (a Cordis effect in the plugin wiring).
 */
export function registerProvenanceRoutes(
  webServer: WebServerLike,
  options: ProvenanceRoutesOptions,
): Array<() => void> {
  const env = options.env ?? process.env
  const baseUrl = uiBaseUrl(options, env)
  const disposers: Array<() => void> = []

  disposers.push(
    webServer.register({
      kind: 'prefix',
      // DSH matches `p` and `p/<anything>`; a trailing slash in `path` matches
      // neither (`dsh-host-webserver/lib/index.js:500`).
      path: PROVENANCE_ROUTE_PREFIX,
      handler: (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const html = wantsHtml(req, url)
          if (!methodAllowed(req)) {
            send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' })
            return
          }
          const auth = authorize(req, url, env)
          if (!auth.ok) {
            if (html) sendHtml(res, auth.status, `<h1>${auth.status}</h1><p>${escapeHtml(auth.message)}</p>`)
            else sendJson(res, auth.status, { error: auth.status === 503 ? 'settings token not configured' : 'unauthorized' })
            return
          }
          let rawId = ''
          if (url.pathname.startsWith(`${PROVENANCE_ROUTE_PREFIX}/`)) {
            try {
              rawId = decodeURIComponent(url.pathname.slice(PROVENANCE_ROUTE_PREFIX.length + 1))
            } catch {
              rawId = ''
            }
          }
          if (!isAddressableMemoryId(rawId)) {
            respondNotFound(res, html)
            return
          }
          let access: ProvenanceAccess
          try {
            access = await options.access()
          } catch {
            // Authorization could not be established: behave exactly like a miss.
            respondNotFound(res, html)
            return
          }
          let entry = options.index.get(rawId, access)
          if (entry === undefined) {
            respondNotFound(res, html)
            return
          }
          if (entry.dataset.id === undefined && options.resolveDatasetId !== undefined) {
            try {
              const datasetId = await withDeadline(
                options.resolveDatasetId(entry.dataset.name),
                options.resolutionTimeoutMs ?? 2_500,
              )
              if (datasetId !== undefined && datasetId.trim() !== '') {
                options.index.setDatasetId(entry.id, datasetId)
                entry = options.index.get(rawId, access) ?? entry
              }
            } catch {
              // An unresolved UUID is a missing field, never a failed detail view.
            }
          }
          const view = provenanceView(entry, baseUrl)
          if (html) {
            sendHtml(res, 200, renderDetailPage(view))
            return
          }
          sendJson(res, 200, view)
        })()
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: MEMORIES_JSON_PATH,
      handler: (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? MEMORIES_JSON_PATH, 'http://localhost')
          if (!methodAllowed(req)) {
            send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' })
            return
          }
          const auth = authorize(req, url, env)
          if (!auth.ok) {
            sendJson(res, auth.status, { error: auth.status === 503 ? 'settings token not configured' : 'unauthorized' })
            return
          }
          let access: ProvenanceAccess
          try {
            access = await options.access()
          } catch {
            access = { readableScopes: [] }
          }
          const rows = options.index.list(access, MAX_LIST_ROWS).map((entry) => ({
            id: entry.id,
            label: entry.excerpt,
            scope: entry.scope.scope,
            createdAt: entry.createdAt ?? null,
            state: entry.ingest.state,
          }))
          sendJson(res, 200, {
            generatedAt: new Date().toISOString(),
            endpoint: options.store.status().endpoint,
            count: rows.length,
            memories: rows,
          })
        })()
      },
    }),
  )

  return disposers
}
