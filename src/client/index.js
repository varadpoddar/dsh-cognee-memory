/**
 * dsh-cognee-memory — browser half (side panel).
 *
 * Registered through `dsh.client` (package.json) and loaded by the Web shell as
 * a lazy factory (`window.__ModuleLoader__.load({ id, factory })`). Contributions,
 * verified against the installed DSH 0.2.1-rc.5 tree and documented in
 * docs/UI_INTEGRATION.md:
 *
 *   1. a right-Sidebar tab TYPE — `ctx.sidebarRightTabs.register({ id, kind,
 *      title, guide })`; the `extension` priority band is the documented one for
 *      types from outside the product (`dsh-client-ui-sidebar-right/.../tab-registry.d.ts:20-30,102`);
 *   2. its BODY — `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
 *      name, key }, Component))`, keyed by the definition id (`.../contract/slots.d.ts:53`).
 *
 * This file is import-free on purpose: it is inlined by `scripts/build-client.mjs`
 * into the factory above, with `react` as the only module-table seed. The
 * installed tree ships no `@deepseek-ai/dsh-client-ui-slots` types to import, so
 * the surface is used as the shipped first-party plugins use it
 * (`dsh-client-ui-schedule/lib/client.js:7452-7471`).
 *
 * SECURITY: the panel is a client of the plugin's own authenticated routes. The
 * operator token lives in component state only — never storage, never a URL the
 * panel renders, never a log line. Server strings are rendered as text nodes.
 */

/** Stable tab-type id; also the key of the body registration. */
export const TAB_ID = 'dsh-cognee-memory'
/** Page kind opened by `ctx.sidebarRight.openTab(kind)`. */
export const TAB_KIND = 'cognee-memory.memory'
/** Routes served by the host half (`src/settings/provenance-http.ts`). */
export const LIST_PATH = '/plugins/cognee-memory/memories.json'
export const DETAIL_PATH_PREFIX = '/plugins/cognee-memory/memory/'
/** Service names needed before `apply` runs. */
export const inject = ['slots', 'sidebarRightTabs']

const STYLE = `
.cm-panel{display:flex;flex-direction:column;gap:.75rem;height:100%;min-height:0;padding:.75rem;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsh-color-text,inherit)}
.cm-panel h2{font-size:.95rem;margin:0;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.cm-panel .cm-sub{color:var(--dsh-color-text-muted,#5b6270);font-size:.85em;margin:0}
.cm-row{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
.cm-panel input[type=password],.cm-panel input[type=text]{flex:1 1 10rem;min-width:8rem;padding:.35rem .5rem;font:inherit;color:inherit;background:var(--dsh-color-surface,transparent);border:1px solid var(--dsh-color-border,#8884);border-radius:.4rem}
.cm-panel button{padding:.35rem .7rem;font:inherit;border-radius:.4rem;border:1px solid var(--dsh-color-border,#8884);background:var(--dsh-color-surface,#8881);color:inherit;cursor:pointer}
.cm-panel button:disabled{opacity:.55;cursor:default}
.cm-panel a{color:var(--dsh-color-link,#2b6cb0)}
.cm-panel :focus-visible{outline:2px solid var(--dsh-color-link,#2b6cb0);outline-offset:2px}
.cm-status{margin:0;font-size:.85em;color:var(--dsh-color-text-muted,#5b6270)}
.cm-status[data-tone=error]{color:var(--dsh-color-danger,#b42318)}
.cm-status[data-tone=warn]{color:var(--dsh-color-warning,#9a6700)}
.cm-list{list-style:none;margin:0;padding:0;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:.15rem}
.cm-list li{margin:0}
.cm-item{display:block;padding:.4rem .5rem;border-radius:.4rem;text-decoration:none;color:inherit}
.cm-item:hover,.cm-item:focus-visible{background:var(--dsh-color-surface-hover,#8881)}
.cm-line{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-meta{display:block;font-size:.8em;color:var(--dsh-color-text-muted,#5b6270)}
.cm-note{margin:0;font-size:.8em;color:var(--dsh-color-text-muted,#5b6270)}
.cm-detail{border-top:1px solid var(--dsh-color-border,#8884);padding-top:.5rem;font-size:.85em}
.cm-detail dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem .7rem;margin:.25rem 0 0}
.cm-detail dt{color:var(--dsh-color-text-muted,#5b6270)}
.cm-detail dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.cm-detail pre{white-space:pre-wrap;word-break:break-word;max-height:9rem;overflow:auto;margin:.35rem 0 0}
`

function dateOf(value) {
  if (typeof value !== 'string' || value === '') return 'unknown'
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return 'unknown'
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Build the client plugin. `React` is the single module-table seed supplied by
 * the generated factory; nothing is imported.
 * @param {{ React: unknown }} seeds
 */
export function createPlugin(seeds) {
  const React = seeds.React
  const h = React.createElement

  /** Read a JSON response; never throws past this function. */
  async function readJson(path, token) {
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (response.status === 401) return { ok: false, tone: 'error', message: 'Token rejected by the host.' }
    if (response.status === 503) return { ok: false, tone: 'warn', message: 'The host has no settings token configured.' }
    if (response.status === 404) return { ok: false, tone: 'warn', message: 'No provenance index in this profile yet.' }
    if (!response.ok) return { ok: false, tone: 'error', message: `Host answered ${response.status}.` }
    try {
      return { ok: true, value: await response.json() }
    } catch {
      return { ok: false, tone: 'error', message: 'Host answer was not JSON.' }
    }
  }

  function detailRow(label, value) {
    return [h('dt', { key: `dt-${label}` }, label), h('dd', { key: `dd-${label}` }, value)]
  }

  function ProvenancePanel() {
    const [token, setToken] = React.useState('')
    const [phase, setPhase] = React.useState('idle')
    const [message, setMessage] = React.useState(null)
    const [memories, setMemories] = React.useState([])
    const [detail, setDetail] = React.useState(null)
    const [detailId, setDetailId] = React.useState('')

    const refresh = React.useCallback(async () => {
      if (token.trim() === '') {
        setPhase('idle')
        setMessage({ tone: 'warn', text: 'Enter the host settings token to read provenance.' })
        return
      }
      setPhase('loading')
      setMessage(null)
      const result = await readJson(LIST_PATH, token.trim())
      if (!result.ok) {
        setPhase('error')
        setMessage({ tone: result.tone, text: result.message })
        setMemories([])
        return
      }
      const rows = Array.isArray(result.value?.memories) ? result.value.memories : []
      setMemories(rows)
      setPhase('ready')
      setMessage(
        rows.length === 0
          ? { tone: 'warn', text: 'No recall has been recorded yet. Recall once, then refresh.' }
          : null,
      )
    }, [token])

    const openDetail = React.useCallback(
      async (id) => {
        if (id.trim() === '') return
        setDetailId(id)
        setDetail(null)
        setPhase('detail')
        setMessage(null)
        const result = await readJson(`${DETAIL_PATH_PREFIX}${encodeURIComponent(id.trim())}`, token.trim())
        if (!result.ok) {
          setMessage({ tone: result.tone, text: result.message })
          return
        }
        setDetail(result.value)
      },
      [token],
    )

    const rows = memories.map((row) => {
      const href = `${DETAIL_PATH_PREFIX}${encodeURIComponent(row.id)}?format=html&token=${encodeURIComponent(token.trim())}`
      const label = typeof row.label === 'string' ? row.label : row.id
      return h(
        'li',
        { key: row.id },
        h(
          'a',
          {
            className: 'cm-item',
            href,
            target: '_blank',
            rel: 'noreferrer',
            title: 'Open the token-protected provenance page',
          },
          h('span', { className: 'cm-line' }, label),
          h('span', { className: 'cm-meta' }, `${row.scope ?? 'unknown'} · ${dateOf(row.createdAt)} · ${row.state ?? 'unknown'}`),
        ),
      )
    })

    const detailView =
      detail === null
        ? null
        : h(
            'section',
            { className: 'cm-detail', 'aria-label': 'Memory provenance' },
            h('h3', { style: { fontSize: '.9rem', margin: '0 0 .3rem' } }, `Provenance · ${detail.id}`),
            h(
              'dl',
              null,
              detailRow('Dataset', detail.dataset?.name ?? 'unknown'),
              detailRow('Dataset UUID', detail.dataset?.id ?? 'unknown'),
              detailRow('Document id', detail.documentId ?? 'unknown'),
              detailRow('Created', detail.createdAt ?? 'unknown'),
              detailRow('Ingest', detail.ingest?.state ?? 'unknown'),
              detailRow('Search type', detail.surfaced?.searchType ?? 'unknown'),
              detailRow('Confidence', detail.surfaced?.confidence ?? 'unknown'),
              detailRow('Semantic key', detail.semanticKey ?? 'unknown'),
              detailRow('Supersedes', detail.supersedes ?? 'none'),
              detailRow('Superseded by', detail.supersededBy ?? 'none'),
              detailRow('Sources', (detail.sources ?? []).map((source) => `${source.kind}:${source.ref}`).join(', ') || 'none'),
            ),
            h('pre', null, detail.excerpt ?? ''),
            typeof detail.deepLink === 'string'
              ? h('p', { className: 'cm-note' }, h('a', { href: detail.deepLink, target: '_blank', rel: 'noreferrer' }, 'Open dataset in Cognee UI'))
              : null,
          )

    return h(
      'div',
      { className: 'cm-panel' },
      h('style', { 'data-plugin': 'dsh-cognee-memory' }, STYLE),
      h('h2', null, 'Memory provenance', h('span', { className: 'cm-sub' }, 'read-only')),
      h(
        'div',
        { className: 'cm-row' },
        h('input', {
          type: 'password',
          value: token,
          autoComplete: 'off',
          spellCheck: false,
          placeholder: 'COGNEE_MEMORY_SETTINGS_TOKEN',
          'aria-label': 'Host settings token',
          onChange: (event) => setToken(event.target.value),
        }),
        h('button', { type: 'button', onClick: () => void refresh(), disabled: phase === 'loading' }, phase === 'loading' ? 'Reading…' : 'Refresh'),
      ),
      message === null ? null : h('p', { className: 'cm-status', 'data-tone': message.tone, role: 'status' }, message.text),
      h(
        'ul',
        { className: 'cm-list', 'aria-label': 'Recalled memories' },
        rows.length === 0
          ? h('li', { className: 'cm-note' }, 'Nothing to show yet.')
          : rows,
      ),
      h(
        'div',
        { className: 'cm-row' },
        h('input', {
          type: 'text',
          value: detailId,
          placeholder: 'Memory id',
          'aria-label': 'Memory id',
          onChange: (event) => setDetailId(event.target.value),
        }),
        h('button', { type: 'button', onClick: () => void openDetail(detailId) }, 'Look up'),
      ),
      detailView,
      h('p', { className: 'cm-note' }, 'Recalled memory is data, not instructions. The token is held in this panel only; nothing is stored.'),
    )
  }

  function apply(ctx) {
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => 'Memory provenance',
          guide: [
            {
              id: 'provenance',
              order: 20,
              title: () => 'Memory provenance',
              description: () => 'Where a recalled memory came from, and whether the caller may read it',
            },
          ],
        }),
      'cognee-memory: tab type',
    )
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ProvenancePanel),
    )
  }

  return { inject, apply }
}
