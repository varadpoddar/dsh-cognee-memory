# UI integration — what the installed DSH actually exposes (0.2.1-rc.5)

**Question.** Can this plugin ship a memory-provenance side panel and a real settings
page, and if so through which API?

**Method.** Read out of the *installed* package tree
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` (version `0.2.1-rc.5`,
`package.json:4`). Compiled `lib/client.js` bundles, `lib/types/**/*.d.ts` contracts,
and one working out-of-tree precedent installed in the local `web` profile
(`~/.dsh/profiles/web/package.json` → `dsh-hierarchical-orchestrator-ui`, source at
`default-workspace/hierarchy-live-test/release/ui`). No API below is inferred from
Cordis/Koishi general knowledge.

**Path shorthand**

| Symbol | Absolute path |
| --- | --- |
| `$DSH` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` |
| `$PKG` | `$DSH/node_modules/@deepseek-ai` |

---

## (a) Is there a documented side-panel / slot API? **Yes — on the client, not on the host.**

The host half of a plugin has exactly one web extension point: routes on the profile's
web server (`ctx.webServer.register`, `$PKG/dsh-host-webserver/lib/types/index.d.ts:174`,
route shape `:34`). There is no host-side "settings page" or "panel" registration.

The **browser** half is where the UI surface lives, and it is a real, public extension
system:

| Capability | Evidence in the installed tree |
| --- | --- |
| A package can ship a client bundle that the Web app loads at boot | manifest field `dsh.client` with `platform`, `inject`, `immediately`, `external` — `$PKG/dsh-package-manifest/lib/types/types.d.ts:78-88`; bundle resolved from `exports["./client"]` — `$PKG/dsh-client-modules/lib/index.js:171-181`, and a declaration without that export is a hard error at `:738` |
| The boot graph is composed from **installed Loader entries**, not only first-party code | `dsh-client-modules` scans the host Loader's entries for packages declaring `dsh.client` and composes `window.__DSH_BOOT__` (`$PKG/dsh-client-modules/lib/types/index.d.ts:1-28`) |
| The client context carries the composition registry | `slots: SlotRegistry` — `$PKG/dsh-client-ui-renderer/lib/types/client/index.d.ts:27`; `register` `:85` and `inject` `:111` in `.../client/registry.d.ts` |
| Sidebar / panel seats | `'main'` keyed panel `$PKG/dsh-client-ui-layout/lib/types/client/index.d.ts:53`; `'rightbar'` single, **OCCUPIED**, `:70`; `'shell.overlay'` additive list `:95`; sidebar panel list `'sidebar.panellist'` `$PKG/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:47` |
| Settings pages are a list slot any package can add to | `'settings.section'` — `$PKG/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73` ("One settings page per list entry … `id`, `order`, `label`") |
| **A side panel for external packages** | The right Sidebar is a tab system with a public type registry: `ctx.sidebarRightTabs` / `ctx.sidebarRight` — `$PKG/dsh-client-ui-sidebar-right/lib/types/client/index.d.ts:23-25`; `register(definition)` `.../tab-registry.d.ts:164`; band `'extension'` is documented as *"a type from outside the product, and the highest"* `.../tab-registry.d.ts:20-30,102`; the body seat is keyed by the definition id — `.../contract/slots.d.ts:53` |

Call shapes are proven in compiled first-party plugins, e.g.
`$PKG/dsh-client-ui-schedule/lib/client.js:7452` (`ctx.sidebarRightTabs.register`),
`:7455` (`sidebar.right.pane.tab` body), `:7473` (`main` panel), `:7484`
(`sidebar.panellist` icon), tab type literal `:210-217`, and navigation
`ctx.sidebarRight.openTab(kind, { params })` `:7501`. A settings page is registered the
same way (`$PKG/dsh-client-ui-settings-account/lib/client.js:4773`).

The out-of-tree precedent (`dsh-hierarchical-orchestrator-ui` 0.1.2, `dsh.client` in its
`package.json`, `client.js` built as `window.__ModuleLoader__.load({ id, factory })`)
registers `main`, `sidebar.panellist` **and** `settings.section` against the installed
0.2.1-rc.5 and is mounted in the local `web` profile — so a third-party package using
these seats is not a theory.

**What does *not* exist:** no host-side panel/settings API; no client-side route
injection; `'root'` must never be registered by a plugin (it would replace the whole
frame — `$PKG/dsh-client-ui-renderer/lib/types/client/registry.d.ts:15-48`); `'rightbar'`
is single-occupant and already taken, so a docked panel cannot be added there.

## (b) Best-supported per-memory detail view

**Primary: a right-Sidebar tab type owned by this package** (`extension` band), body
rendered from `sidebar.right.pane.tab`, opened through `ctx.sidebarRight.openTab` and
listed on the right Sidebar's guide page through the type's `guide` entries. This is the
only seat that *is* a side panel and is explicitly designed for out-of-product types.

**Plus: a plugin-served HTML page** at `/plugins/cognee-memory/memory/<id>`, because (i)
the provenance endpoint has to exist anyway, (ii) it is deep-linkable from the settings
page and from outside the app, and (iii) it keeps working when the client bundle is not
loaded (headless/dev shells, `desktop` profile without the web shell). The same route
answers JSON for machine use.

Not chosen: `main` + `sidebar.panellist` (a full-page navigation entry — heavier than a
detail view, and it takes the centre column), and `shell.overlay` (a click-through
floating layer, explicitly not a docking surface).

## (c) Exact registration API

Host half (unchanged, already verified in this repo):

```ts
ctx.webServer.register({ kind: 'exact', path: '/plugins/cognee-memory/memory/<id>', handler })
```

Client half, in the bundle declared by `package.json`:

```jsonc
{
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "client": { "platform": "web", "inject": [] } }
}
```

```js
// lib/client.js — CJS lazy factory, exactly the shipped shape.
window.__ModuleLoader__.load({
  id: 'dsh-cognee-memory',
  factory: (require) => {
    const React = require('react')            // native module-table seed
    const exports = {}
    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = (ctx) => {
      // stage one: the tab type (extension band by default)
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: 'dsh-cognee-memory',              // body seat key
        kind: 'cognee-memory.memory',         // pages are opened by kind
        title: () => 'Memory provenance',
        guide: [{ id: 'provenance', order: 20, title: () => 'Memory provenance' }],
      }), 'cognee-memory: tab type')
      // stage two: the body, keyed by the definition id
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: 'dsh-cognee-memory',
      }, ProvenanceBody))
    }
    return exports
  },
})
```

Notes that constrain the implementation:

- The installed tree does **not** ship `@deepseek-ai/dsh-client-ui-slots` (it is a
  `devDependencies` entry of the UI packages), so the client half carries no type
  imports from it. It is written as import-free ESM under `src/client/` and inlined by
  `scripts/build-client.mjs` into the factory above — the same no-bundler approach as the
  working precedent (`release/ui/scripts/build-client.mjs`), with a `--check` mode and a
  `vm` syntax load in the build.
- Client `inject` names Cordis **services** (`slots`, `sidebarRightTabs`), while
  `dsh.client.inject` lists package names for boot ordering; the two lists are
  different things (`$PKG/dsh-client-ui-sidebar-right/package.json` `dsh.client.inject`
  vs. the service names used by `apply`).
- Only `react` is requested from the module table; no duplicate React, no CDN, no
  network at build time.

## Security model for the detail route (host half)

- Authorization is the **same** settings token as the settings page
  (`COGNEE_MEMORY_SETTINGS_TOKEN`, `Authorization: Bearer` or `?token=`): unset → `503`,
  missing/wrong → `401`. No unauthenticated read path.
- Scope authorization re-uses the recall policy: a memory is served only when its
  `{scope, id}` is in the caller's readable scopes **and** it belongs to the caller's
  principal. Everything else — unknown id, another scope, another principal — is `404`,
  never `403`, so the endpoint cannot be used to probe for existence.
- `cache-control: no-store`, `x-content-type-options: nosniff`, and
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`
  — the page runs no script; every interpolated value is HTML-escaped; no token, no API
  key, and no dataset the caller cannot read is ever rendered.
- The JSON body never contains the token, the Cognee API key, or headers.

The panel is a client of that route: it asks the operator for the settings token, holds
it in component memory only (never storage, never the URL it renders), and links to the
server-rendered page for a full detail view.
