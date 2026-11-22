# Why a plugin can be installed and still be invisible in the `web` profile

**Status: diagnosis complete at code level; the confirming run on CT 103 was NOT
executed from this session (no SSH route to `control.nomad.opsc.io`, `pve`, or
`fremont`). Section 4 is the exact verification to run there.**

## 1. What `dsh plugin --profile web add <tarball>` actually does

Verified in the installed CLI:

- `$DSH/lib/plugin-BiveYA7h.js:77-101` — `runPlugin()` delegates to
  `runPluginCommand()` from `@deepseek-ai/dsh-plugin-manager/operations`: pnpm
  resolves/installs the package into the profile and records it in `package.json`.
- `$PKG/dsh-plugin-manager/lib/index.js:1034-1080` — the only YAML write is
  `writePluginEnabled()`, which appends or edits an entry holding just
  `{ id, disabled }`. It does not compose, mount, or load anything.
- No file watcher exists on the profile: `grep -rn "watch\|chokidar"` over
  `$PKG/dsh-app-boot/lib/*.js` and `$PKG/cordis-plugin-loader/lib/*.js` returns
  nothing. `loadProfileDirectory()` (`dsh-app-boot/lib/index.js:1015`) composes the
  bundle layers plus patch overlays **once**, at process start.

So a running harness keeps its boot-time tree. Installing a plugin changes files on
disk only.

## 2. Why `headless` appeared to work and `web` did not

This is the asymmetry in the report, and it is the signature of the cause above:

| Profile | Process lifetime | Consequence |
| --- | --- | --- |
| `headless` | a fresh `dsh headless ...` process per invocation, booted **after** the install | composes the new row → `memory_recall/remember/forget/status` registered, `memory_status` returned `reachable:true` |
| `web` | long-running `deepseek-harness.service` (systemd), started **before** the install | keeps the old tree → the plugin's tools never register in that process |

The in-app plugin manager can reconcile at runtime
(`$PKG/dsh-plugin-manager/lib/index.js:2347-2370`), but it reports
`application: "restart-required"`, `restartReason: "no-hmr"` when HMR is unavailable,
which is the normal state of a production systemd service. The CLI path taken on
CT 103 does not trigger reconciliation at all.

## 3. Ruled out (so the fix is not a reinstall)

- **Tool scoping by agent preset.** A root-level registration is visible to scoped
  agents: `ScopedLayers.merge()` seeds the effective map with the *global* layer and
  then overlays the scope chain (`$PKG/dsh-scope/lib/index.js:177-181`). Agent presets
  do not mount their own `tools` instance — the composed `web` dump has exactly one
  `id: tools` row, at root
  ([`docs/research/dump-config-web.yml:414`](research/dump-config-web.yml)).
- **A missing service dependency.** The plugin injects `['tools', 'systemPrompt']`
  (`src/index.ts:30`); both are mounted at root in the composed `web` tree
  (`dump-config-web.yml:414` and `:418`).
- **A different tool allowlist in `web`.** There is no allowlist; root rows for
  `tool-bash`/`tool-fs`/`tool-jobs` are individually `disabled: true` because presets
  re-declare them, which does not affect a plugin's own registrations.
- **`disabled: true` on the plugin row itself** — still possible, and test 2 below
  distinguishes it.

## 4. The confirming procedure on CT 103

```bash
pct exec 103 -- bash -lc 'dsh --profile web --dump-config | grep -n -A4 cognee'
```

- **Row present and not disabled** → the tree is correct on disk and the running
  service is stale. Fix: `systemctl restart deepseek-harness.service`, then confirm
  with `memory_status` (which reports the live endpoint) and the settings page.
- **Row present with `disabled: true`** → enable it (`dsh plugin --profile web` does
  this through the manager) and restart.
- **Row absent** → the package landed in `package.json` without a mount row; add one
  to `~/.dsh/profiles/web/cordis.patch.yml` as a new top-level element and restart:

  ```yaml
  - id: cognee-memory
    name: dsh-cognee-memory
    config:
      apiBaseUrl: http://10.20.10.15:8000/api/v1
      apiTokenEnv: COGNEE_API_KEY
  ```

  Merge into the existing sequence — never replace it.

## 5. What this repository changed to make the web profile useful

The plugin now registers `/plugins/cognee-memory/settings` (HTML) and
`/plugins/cognee-memory/settings.json` through `ctx.webServer.register` when the
profile mounts a web server, and reports its live endpoint through `memory_status`.
See [SETTINGS.md](SETTINGS.md). This does not make a stale process pick up a newly
installed plugin; only a restart does that.
