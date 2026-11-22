/**
 * Cognee memory settings over HTTP, served through the verified extension point
 * `ctx.webServer.register({ kind, path, handler })`
 * (`dsh-host-webserver/lib/types/index.d.ts:169-174`, handler receives node's
 * `IncomingMessage`/`ServerResponse`).
 *
 * There is no settings-page slot for a third-party plugin in 0.2.1-rc.5, so the
 * page is plain HTML the plugin owns. Authentication is mandatory: the routes
 * answer with 503 unless `COGNEE_MEMORY_SETTINGS_TOKEN` is set, and then require
 * that token as `Authorization: Bearer ...` or `?token=...`.
 *
 * Nothing here ever reads, stores, echoes, or logs the Cognee API key. The page
 * reports only whether the configured key variable is set. Milestone 9 adds
 * read-only inspection (`SettingsInspection`): auto-recall/auto-write toggles,
 * scope inspection, candidate queue, ingestion counts, recall hit rate and
 * latency percentiles, context tokens, memory count, and per-memory states.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SETTINGS_TOKEN_ENV, type SettingsStatus, type SettingsStore } from './store.js'
import { MEMORY_INSPECTION_STATES, type SettingsInspection } from './inspect.js'
import { withTimeout } from '../memory/context-format.js'
import type { WebServerLike } from '../types.js'

/** Path of the settings page. */
export const SETTINGS_PAGE_PATH = '/plugins/cognee-memory/settings'
/** Path of the machine-readable status. */
export const SETTINGS_JSON_PATH = '/plugins/cognee-memory/settings.json'

/** A settings form is small; anything larger is not a submission. */
const MAX_BODY_BYTES = 8_192
const INSPECTION_TIMEOUT_MS = 2_500

export interface SettingsRoutesOptions {
  readonly store: SettingsStore
  readonly env?: NodeJS.ProcessEnv
  readonly logger?: (message: string) => void
  /** Read-only inspection; omitted profiles get a "not wired" note, never an error. */
  readonly inspect?: () => Promise<SettingsInspection | { error: string }>
  readonly inspectionTimeoutMs?: number
}

type Authorization = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 503; readonly message: string }

function readToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  const query = url.searchParams.get('token')
  return query === null || query === '' ? undefined : query
}

function tokensMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(supplied, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authorize(req: IncomingMessage, url: URL, env: NodeJS.ProcessEnv): Authorization {
  const expected = (env[SETTINGS_TOKEN_ENV] ?? '').trim()
  if (expected === '') {
    return {
      ok: false,
      status: 503,
      message:
        `Settings are disabled: set ${SETTINGS_TOKEN_ENV} in the harness environment and restart the ` +
        `service once. The page never reads or stores your Cognee key.`,
    }
  }
  const supplied = readToken(req, url)
  if (supplied === undefined || !tokensMatch(expected, supplied)) {
    return { ok: false, status: 401, message: `Missing or invalid token. Pass ?token=... or Authorization: Bearer ...` }
  }
  return { ok: true }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function pageToken(url: URL): string {
  const token = url.searchParams.get('token')
  return token === null ? '' : token
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  return `${Math.round(value * 1000) / 10}%`
}

function renderInspection(inspection: SettingsInspection | undefined, error: string | undefined): string {
  if (inspection === undefined) {
    return `<fieldset><legend>Inspection</legend><p class="hint">${
      error === undefined
        ? 'Inspection is not wired in this profile.'
        : `Inspection unavailable: ${escapeHtml(error)}`
    }</p></fieldset>`
  }
  const operations = inspection.candidates.operations
  const operationRows =
    operations.length === 0
      ? '<tr><td colspan="6">No queued or completed write operations.</td></tr>'
      : operations
          .map(
            (operation) => `<tr>
  <td>${escapeHtml(operation.state)}</td>
  <td>${escapeHtml(operation.operation)}</td>
  <td>${escapeHtml(operation.dataset)}</td>
  <td>${operation.attempts}</td>
  <td>${escapeHtml(operation.reason ?? '')}</td>
  <td>${escapeHtml(operation.preview)}</td>
</tr>`,
          )
          .join('')
  const memories = inspection.memories
  const memoryRows =
    memories.length === 0
      ? '<tr><td colspan="5">No memories recorded in this process.</td></tr>'
      : memories
          .map(
            (row) => `<tr>
  <td>${escapeHtml(row.state)}</td>
  <td>${escapeHtml(row.dataset)}</td>
  <td>${escapeHtml(row.preview)}</td>
  <td>${row.attempts ?? ''}</td>
  <td>${escapeHtml(row.reason ?? '')}</td>
</tr>`,
          )
          .join('')
  const scopes =
    inspection.scopes.readable.length === 0
      ? '<tr><td colspan="3">No readable scope.</td></tr>'
      : inspection.scopes.readable
          .map(
            (scope) =>
              `<tr><td>${escapeHtml(scope.scope)}</td><td>${escapeHtml(scope.id)}</td><td>${escapeHtml(scope.dataset)}</td></tr>`,
          )
          .join('')
  const datasets =
    inspection.memory.datasets.length === 0
      ? '<tr><td colspan="3">No dataset inventory available.</td></tr>'
      : inspection.memory.datasets
          .map(
            (dataset) =>
              `<tr><td>${escapeHtml(dataset.name)}</td><td>${dataset.dataCount ?? '?'}</td><td>${
                dataset.searchable === undefined ? (dataset.state === undefined ? '' : escapeHtml(dataset.state)) : dataset.searchable ? 'searchable' : 'not searchable'
              }</td></tr>`,
          )
          .join('')
  const legend = MEMORY_INSPECTION_STATES.map(
    (state) => `${escapeHtml(state)}: ${inspection.stateCounts[state]}`,
  ).join(' · ')

  return `<fieldset>
  <legend>Inspection (read-only)</legend>
  <dl>
    <dt>Principal</dt><dd>${escapeHtml(inspection.scopes.principal)}</dd>
    <dt>Project dataset</dt><dd>${escapeHtml(inspection.scopes.project)}</dd>
    <dt>Default write scope</dt><dd>${escapeHtml(inspection.scopes.defaultWriteScope)}</dd>
    <dt>Memory count</dt><dd>${inspection.memory.count === null ? 'unknown' : inspection.memory.count}</dd>
    <dt>Ingestion</dt><dd>${inspection.ingestion.succeeded} succeeded · ${inspection.ingestion.failed} failed</dd>
    <dt>First-turn recall</dt><dd>${formatPercent(inspection.recall.firstTurn.hitRate)} (${inspection.recall.firstTurn.hits}/${inspection.recall.firstTurn.attempts})</dd>
    <dt>Recall latency</dt><dd>p50 ${inspection.recall.latency.recall.p50} ms · p95 ${inspection.recall.latency.recall.p95} ms (n=${inspection.recall.latency.recall.count})</dd>
    <dt>Prefetch latency</dt><dd>p50 ${inspection.recall.latency.prefetch.p50} ms · p95 ${inspection.recall.latency.prefetch.p95} ms (n=${inspection.recall.latency.prefetch.count})</dd>
    <dt>Context tokens</dt><dd>last ${inspection.recall.contextTokens.last} · p95 ${inspection.recall.contextTokens.p95} · total ${inspection.recall.contextTokens.total}</dd>
    <dt>Candidate queue</dt><dd>${inspection.candidates.queued} queued · ${inspection.candidates.ingested} ingested · ${inspection.candidates.failed} failed · ${inspection.candidates.total} accepted</dd>
  </dl>
  <p class="hint">States — ${legend}</p>
  <h2>Readable scopes</h2>
  <table><thead><tr><th>Scope</th><th>Id</th><th>Dataset</th></tr></thead><tbody>${scopes}</tbody></table>
  <h2>Candidate / write queue</h2>
  <table><thead><tr><th>State</th><th>Op</th><th>Dataset</th><th>Attempts</th><th>Reason</th><th>Preview</th></tr></thead><tbody>${operationRows}</tbody></table>
  <h2>Datasets</h2>
  <table><thead><tr><th>Dataset</th><th>Records</th><th>State</th></tr></thead><tbody>${datasets}</tbody></table>
  <h2>Memories</h2>
  <table><thead><tr><th>State</th><th>Dataset</th><th>Preview</th><th>Attempts</th><th>Reason</th></tr></thead><tbody>${memoryRows}</tbody></table>
  <p class="hint">Inspection is read-only in this pass: deletion, correction, and consolidation are deferred.
  Inspected at ${escapeHtml(inspection.inspectedAt)}.${
    inspection.memory.degraded === undefined ? '' : ` ${escapeHtml(inspection.memory.degraded)}.`
  }</p>
</fieldset>`
}

/** Render the settings page. Every interpolated value is HTML-escaped. */
export function renderSettingsPage(
  status: SettingsStatus,
  options: {
    readonly errors?: readonly string[]
    readonly notice?: string
    readonly token?: string
    readonly inspection?: SettingsInspection
    readonly inspectionError?: string
  } = {},
): string {
  const token = options.token ?? ''
  // `action=""` reposts to this exact URL, so the ?token= stays in the address
  // bar and out of the markup: the page never reflects a credential.
  const action = ''
  const errors =
    options.errors === undefined || options.errors.length === 0
      ? ''
      : `<div class="err" role="alert"><strong>Not saved</strong><ul>${options.errors
          .map((error) => `<li>${escapeHtml(error)}</li>`)
          .join('')}</ul></div>`
  const notice =
    options.notice === undefined ? '' : `<div class="ok" role="status">${escapeHtml(options.notice)}</div>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cognee memory settings</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem}
h1{font-size:1.35rem;margin:0 0 .25rem}
h2{font-size:1rem;margin:1.2rem 0 .4rem}
p.sub{margin:0 0 1.25rem;opacity:.75}
fieldset{border:1px solid #8884;border-radius:.5rem;padding:1rem;margin:0 0 1rem}
legend{padding:0 .4rem;font-weight:600}
label{display:block;margin:.6rem 0 .2rem;font-weight:500}
input[type=url]{width:100%;box-sizing:border-box;padding:.45rem;font:inherit;border:1px solid #8888;border-radius:.35rem}
.hint{font-size:.85em;opacity:.7;margin:.15rem 0 0}
.row{display:flex;gap:.5rem;align-items:center;margin:.4rem 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .9rem;margin:.5rem 0 0;font-size:.92em}
dt{opacity:.7}
dd{margin:0;font-family:ui-monospace,monospace;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:.85em;margin:.2rem 0 0}
th,td{text-align:left;vertical-align:top;padding:.3rem .4rem;border-top:1px solid #8883}
th{opacity:.7;font-weight:600}
td{word-break:break-word}
button{padding:.5rem 1rem;font:inherit;border-radius:.35rem;border:1px solid #8888;cursor:pointer}
.err{border:1px solid #c44;background:#c4411f22;padding:.6rem .8rem;border-radius:.4rem;margin:0 0 1rem}
.ok{border:1px solid #2a2;background:#2a222;background:#2a22;padding:.6rem .8rem;border-radius:.4rem;margin:0 0 1rem}
code{font-family:ui-monospace,monospace}
</style></head>
<body>
<h1>Cognee memory settings</h1>
<p class="sub">Saved to <code>${escapeHtml(status.filePath)}</code>. The address applies to subsequent
memory tools calls; no restart is needed for a URL, toggle, or enable/disable change.</p>
${notice}${errors}
<form method="post" action="${escapeHtml(action)}">
  <fieldset>
    <legend>Backend</legend>
    <label for="apiBaseUrl">Cognee REST base URL</label>
    <input id="apiBaseUrl" name="apiBaseUrl" type="url" required value="${escapeHtml(status.endpoint)}">
    <p class="hint">Absolute http(s) URL, no credentials. Source: ${escapeHtml(status.sources.apiBaseUrl)}.</p>
    <label for="mcpUrl">Cognee MCP URL (optional)</label>
    <input id="mcpUrl" name="mcpUrl" type="url" value="${escapeHtml(status.mcpUrl ?? '')}">
    <p class="hint">Leave empty for REST. Source: ${escapeHtml(status.sources.mcpUrl)}.</p>
    <div class="row">
      <input id="enabled" name="enabled" type="checkbox"${status.enabled ? ' checked' : ''}>
      <label for="enabled" style="margin:0">Memory enabled</label>
    </div>
    <div class="row">
      <input id="autoRecall" name="autoRecall" type="checkbox"${status.autoRecall ? ' checked' : ''}>
      <label for="autoRecall" style="margin:0">Auto-recall (inject known context)</label>
    </div>
    <div class="row">
      <input id="autoWrite" name="autoWrite" type="checkbox"${status.autoWrite ? ' checked' : ''}>
      <label for="autoWrite" style="margin:0">Auto-write (extract from committed turns)</label>
    </div>
  </fieldset>
  <fieldset>
    <legend>Credential</legend>
    <dl>
      <dt>${escapeHtml(status.keyVar)}</dt><dd>${status.keySet ? 'set' : 'unset'}</dd>
      <dt>Transport</dt><dd>${escapeHtml(status.mcpUrl === undefined ? 'rest' : 'mcp-http')}</dd>
    </dl>
    <p class="hint">The key is read from the environment only. It is never shown here, never logged,
    and never written to the settings file.</p>
  </fieldset>
  <button type="submit">Save settings</button>
</form>
${renderInspection(options.inspection, options.inspectionError)}
</body></html>
`
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: string, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // No scripts anywhere on this page; forms may only post back here.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    ...headers,
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, `${JSON.stringify(value, null, 2)}\n`, 'application/json; charset=utf-8')
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  send(res, status, html, 'text/html; charset=utf-8')
}

async function inspectWithDeadline(
  options: SettingsRoutesOptions,
): Promise<{ inspection?: SettingsInspection; error?: string }> {
  if (options.inspect === undefined) return {}
  try {
    const result = await withTimeout(options.inspect(), options.inspectionTimeoutMs ?? INSPECTION_TIMEOUT_MS)
    if ('error' in result) return { error: result.error }
    return { inspection: result }
  } catch {
    return { error: 'inspection did not complete in time' }
  }
}

/**
 * Register the settings routes. Returns their disposers; a caller that registered
 * inside a Cordis effect gets the same cleanup from the owning fiber.
 */
export function registerSettingsRoutes(
  webServer: WebServerLike,
  options: SettingsRoutesOptions,
): Array<() => void> {
  const env = options.env ?? process.env
  const store = options.store
  const disposers: Array<() => void> = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: SETTINGS_PAGE_PATH,
      handler: (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? SETTINGS_PAGE_PATH, 'http://localhost')
          const auth = authorize(req, url, env)
          if (!auth.ok) {
            sendHtml(res, auth.status, `<h1>${auth.status}</h1><p>${escapeHtml(auth.message)}</p>`)
            return
          }
          const token = pageToken(url)
          if ((req.method ?? 'GET').toUpperCase() === 'GET') {
            const { inspection, error } = await inspectWithDeadline(options)
            sendHtml(
              res,
              200,
              renderSettingsPage(store.status(), {
                token,
                ...(inspection === undefined ? {} : { inspection }),
                ...(error === undefined ? {} : { inspectionError: error }),
              }),
            )
            return
          }
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { allow: 'GET, POST' })
            return
          }
          const contentType = String(req.headers['content-type'] ?? '')
          if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
            sendHtml(res, 415, `<h1>415</h1><p>Expected application/x-www-form-urlencoded.</p>`)
            return
          }
          let form: URLSearchParams
          try {
            form = new URLSearchParams(await readBody(req))
          } catch (error) {
            sendHtml(res, 413, `<h1>413</h1><p>${escapeHtml(error instanceof Error ? error.message : 'body too large')}</p>`)
            return
          }
          const result = store.update({
            apiBaseUrl: form.get('apiBaseUrl') ?? '',
            mcpUrl: form.get('mcpUrl') ?? '',
            enabled: form.get('enabled') === 'on' || form.get('enabled') === 'true',
            autoRecall: form.get('autoRecall') === 'on' || form.get('autoRecall') === 'true',
            autoWrite: form.get('autoWrite') === 'on' || form.get('autoWrite') === 'true',
          })
          if (!result.ok) {
            options.logger?.(`cognee-memory settings: rejected a change (${result.errors.join('; ')})`)
            const { inspection, error } = await inspectWithDeadline(options)
            sendHtml(
              res,
              400,
              renderSettingsPage(store.status(), {
                errors: result.errors,
                token,
                ...(inspection === undefined ? {} : { inspection }),
                ...(error === undefined ? {} : { inspectionError: error }),
              }),
            )
            return
          }
          options.logger?.(`cognee-memory settings: endpoint updated to ${result.config.apiBaseUrl}`)
          send(res, 303, '', 'text/plain; charset=utf-8', {
            location: `${SETTINGS_PAGE_PATH}?token=${encodeURIComponent(token)}`,
          })
        })()
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: SETTINGS_JSON_PATH,
      handler: (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? SETTINGS_JSON_PATH, 'http://localhost')
          const auth = authorize(req, url, env)
          if (!auth.ok) {
            sendJson(res, auth.status, { error: auth.message })
            return
          }
          const status = store.status()
          const { inspection, error } = await inspectWithDeadline(options)
          sendJson(res, 200, {
            endpoint: status.endpoint,
            mcpUrl: status.mcpUrl ?? null,
            enabled: status.enabled,
            autoRecall: status.autoRecall,
            autoWrite: status.autoWrite,
            sources: status.sources,
            filePath: status.filePath,
            credential: { variable: status.keyVar, state: status.keySet ? 'set' : 'unset' },
            warnings: status.warnings,
            toggles: { autoRecall: status.autoRecall, autoWrite: status.autoWrite },
            inspection: inspection ?? null,
            ...(error === undefined ? {} : { inspectionError: error }),
          })
        })()
      },
    }),
  )

  return disposers
}
