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
 * reports only whether the configured key variable is set.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SETTINGS_TOKEN_ENV, type SettingsStatus, type SettingsStore } from './store.js'
import type { WebServerLike } from '../types.js'

/** Path of the settings page. */
export const SETTINGS_PAGE_PATH = '/plugins/cognee-memory/settings'
/** Path of the machine-readable status. */
export const SETTINGS_JSON_PATH = '/plugins/cognee-memory/settings.json'

/** A settings form is small; anything larger is not a submission. */
const MAX_BODY_BYTES = 8_192

export interface SettingsRoutesOptions {
  readonly store: SettingsStore
  readonly env?: NodeJS.ProcessEnv
  readonly logger?: (message: string) => void
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

/** Render the settings page. Every interpolated value is HTML-escaped. */
export function renderSettingsPage(
  status: SettingsStatus,
  options: { readonly errors?: readonly string[]; readonly notice?: string; readonly token?: string } = {},
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
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem}
h1{font-size:1.35rem;margin:0 0 .25rem}
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
button{padding:.5rem 1rem;font:inherit;border-radius:.35rem;border:1px solid #8888;cursor:pointer}
.err{border:1px solid #c44;background:#c4411f22;padding:.6rem .8rem;border-radius:.4rem;margin:0 0 1rem}
.ok{border:1px solid #2a2;background:#2a222;background:#2a22;padding:.6rem .8rem;border-radius:.4rem;margin:0 0 1rem}
code{font-family:ui-monospace,monospace}
</style></head>
<body>
<h1>Cognee memory settings</h1>
<p class="sub">Saved to <code>${escapeHtml(status.filePath)}</code>. The address applies to subsequent
memory tools calls; no restart is needed for a URL or enable/disable change.</p>
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
            sendHtml(res, 200, renderSettingsPage(store.status(), { token }))
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
          })
          if (!result.ok) {
            options.logger?.(`cognee-memory settings: rejected a change (${result.errors.join('; ')})`)
            sendHtml(res, 400, renderSettingsPage(store.status(), { errors: result.errors, token }))
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
          sendJson(res, 200, {
            endpoint: status.endpoint,
            mcpUrl: status.mcpUrl ?? null,
            enabled: status.enabled,
            sources: status.sources,
            filePath: status.filePath,
            credential: { variable: status.keyVar, state: status.keySet ? 'set' : 'unset' },
            warnings: status.warnings,
          })
        })()
      },
    }),
  )

  return disposers
}
