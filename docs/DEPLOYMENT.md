# DEPLOYMENT — dsh-cognee-memory 1.0.2 on CT 103

Exact commands used for the live deployment and the 1.0.2 fresh-install smoke.
Everything runs on the Proxmox host (`control.nomad.opsc.io`) through
`pct exec 103`; the harness itself runs inside CT 103 as the unprivileged user
`dsh`.

## 1. Topology and service account

| Item | Value |
| --- | --- |
| Host access | `ssh -o StrictHostKeyChecking=no -i ~/.ssh/dsh root@control.nomad.opsc.io` |
| Container | CT 103 |
| Service | `deepseek-harness.service` (systemd), `User=dsh`, `Group=dsh` |
| DSH home | `/var/lib/deepseek-harness/.dsh` |
| Service profile | `web` (`$DSH_HOME/profiles/web`) |
| Eval profile | `headless` (`$DSH_HOME/profiles/headless`) |
| Working directory | `/srv/dsh/workspace` |
| dsh binary | `/usr/local/bin/dsh` |
| Published tarballs | `/var/lib/deepseek-harness/dsh-cognee-memory-<version>.tgz` |
| Cognee | `http://10.20.10.15:8000/api/v1` (CT 106, Cognee 1.6.10-local, EBAC on) |

**Never install into `/root/.dsh`.** A command run as root without `DSH_HOME`
uses root's own profile; the service will not see that plugin. Always pass
`DSH_HOME=/var/lib/deepseek-harness/.dsh` and `--profile web` when acting on the
service.

## 2. Environment files

Two files, both **0640 root:dsh**:

| File | Contents | Consumer |
| --- | --- | --- |
| `/etc/dsh/cognee.env` | `COGNEE_API_KEY`, `COGNEE_MEMORY_SETTINGS_TOKEN` (and non-secret Cognee knobs) | `deepseek-harness.service` via the drop-in |
| `/etc/dsh/llm.env` | model endpoint key (Studio key) for headless/eval commands | `su dsh -c 'set -a; . /etc/dsh/llm.env; …'` |

```bash
# from the Proxmox host
pct exec 103 -- install -o root -g dsh -m 0640 /tmp/cognee.env /etc/dsh/cognee.env

# the systemd drop-in that loads it (already present on CT 103)
cat /etc/systemd/system/deepseek-harness.service.d/cognee.conf
# [Service]
# EnvironmentFile=-/etc/dsh/cognee.env
systemctl daemon-reload

# check mode/ownership; 640 root:dsh is required
pct exec 103 -- ls -l /etc/dsh/cognee.env /etc/dsh/llm.env
```

`UMask=0077` on the unit means the process cannot accidentally widen file modes
it creates; the env files themselves are read by systemd as root before the
drop to `User=dsh`.

## 3. Install / upgrade the plugin

Build and pack on the workstation:

```bash
cd dsh-cognee-memory
npm ci && npm run build && npm test
npm pack                       # dsh-cognee-memory-1.0.2.tgz
```

Copy the tarball into CT 103 and install it into the **service** profile:

```bash
# from the Proxmox host
scp -i ~/.ssh/dsh dsh-cognee-memory-1.0.2.tgz root@control.nomad.opsc.io:/tmp/
pct push 103 /tmp/dsh-cognee-memory-1.0.2.tgz /var/lib/deepseek-harness/dsh-cognee-memory-1.0.2.tgz

pct exec 103 -- su dsh -s /bin/bash -c '
  DSH_HOME=/var/lib/deepseek-harness/.dsh \
  dsh plugin --profile web add @deepseek-ai/cordis@4.0.5
  DSH_HOME=/var/lib/deepseek-harness/.dsh \
  dsh plugin --profile web add /var/lib/deepseek-harness/dsh-cognee-memory-1.0.2.tgz
'
```

Upgrade is the same command with the newer tarball. **A restart is required**
after any plugin add/remove/upgrade, because the composed plugin tree is read at
boot:

```bash
pct exec 103 -- systemctl restart deepseek-harness
pct exec 103 -- systemctl is-active deepseek-harness    # → active
```

## 4. Verify the deployment

```bash
# 1. plugin is pinned to the tarball you installed
pct exec 103 -- su dsh -s /bin/bash -c '
  DSH_HOME=/var/lib/deepseek-harness/.dsh dsh plugin --profile web why dsh-cognee-memory
'

# 2. settings route answers 200 with the operator token (no secret printed)
pct exec 103 -- bash -c '
  set -a; . /etc/dsh/cognee.env; set +a
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $COGNEE_MEMORY_SETTINGS_TOKEN" \
    http://10.20.10.12:3080/plugins/cognee-memory/settings.json
'

# 3. tools register and prefetch recall works in a fresh headless process
pct exec 103 -- bash -c "su dsh -s /bin/bash -c '
  set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a
  DSH_HOME=/var/lib/deepseek-harness/.dsh timeout 120 \
    dsh --profile headless --patch /tmp/m12-rank/patch-no-tools.yml --json \
    \"What is the maintenance window for this project? Reply with the value only.\"
'"
```

Expected: `active`, `200`, and a final answer carrying the stored maintenance
value with **no memory tool call** (the patch disables every tool).

## 5. Fresh-install smoke (clean DSH_HOME, published artifact only)

This proves the packed tarball works without the working tree. It uses a
throwaway home (`/var/lib/deepseek-harness/.dsh-smoke`) so the service profile is
untouched. A freshly initialized profile has only `@deepseek-ai/dsh-base`, so the
smoke adds `dsh-headless` for the conversation checks and `dsh-web-app` for the
settings check.

```bash
# 0. create an empty home and install the packed artifact
pct exec 103 -- bash -c '
  rm -rf /var/lib/deepseek-harness/.dsh-smoke
  install -d -o dsh -g dsh -m 0750 /var/lib/deepseek-harness/.dsh-smoke
  su dsh -s /bin/bash -c "
    DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke \
    dsh plugin --profile smoke add /var/lib/deepseek-harness/dsh-cognee-memory-1.0.2.tgz
  "
'
# → "dependencies: + dsh-cognee-memory file:…/dsh-cognee-memory-1.0.2.tgz"

# 1. mount the plugin row and provide the model provider in the smoke patch
#    (fresh profiles have no row; the real deployment uses the same insert)
pct exec 103 -- bash -c 'cat > /var/lib/deepseek-harness/.dsh-smoke/profiles/smoke/cordis.patch.yml <<EOF
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: unsloth-large
    model: unsloth/Qwen3.8-27B-GGUF
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      unsloth-large:
        displayName: Unsloth Large
        apiKeyEnv: UNSLOTH_LARGE_API_KEY
        api: openai-completions
        baseURL: http://10.20.10.40:8888/v1
        models:
          - id: unsloth/Qwen3.8-27B-GGUF
            name: unsloth/Qwen3.8-27B-GGUF
            contextWindow: 262144
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: rest
        apiBaseUrl: http://10.20.10.15:8000/api/v1
        authMode: api-key
        apiTokenEnv: COGNEE_API_KEY
        failureMode: open
        scopeDefaults:
          projectId: dsh/eval/m12-ranking
        recall:
          searchType: CHUNKS
          maxRecallLatencyMs: 8000
        ingestion:
          timeoutMs: 120000
          pollMs: 500
        prompt:
          maxItems: 8
        prefetch:
          maxItems: 8
        retrieval:
          stableTokens: 300
          queryTokens: 900
          maxItems: 8
        tools:
          enabled: true
EOF
chown -R dsh:dsh /var/lib/deepseek-harness/.dsh-smoke'

# 2. the plugin row is composed from the tarball
pct exec 103 -- su dsh -s /bin/bash -c '
  DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke dsh --profile smoke --dump-config
' | grep -A3 cognee-memory

# 3. give the smoke profile a headless app, then call a memory tool
pct exec 103 -- bash -c 'node -e "
  const fs=require(\"fs\");
  const p=\"/var/lib/deepseek-harness/.dsh-smoke/profiles/smoke/package.json\";
  const d=JSON.parse(fs.readFileSync(p));
  d.dsh.profile.bundles=[\"@deepseek-ai/dsh-base\",\"@deepseek-ai/dsh-headless\"];
  fs.writeFileSync(p, JSON.stringify(d,null,2)+\"\\n\");
"'
pct exec 103 -- bash -c "su dsh -s /bin/bash -c '
  set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a
  DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke timeout 120 \
    dsh --profile smoke --json \"Call the memory_status tool exactly once and reply with its result.\"
'"
# → tool_call {tool: memory_status}, result "reachable: true"

# 4. tools-off conversation recalls the smoke fixture on the first response
pct exec 103 -- bash -c "su dsh -s /bin/bash -c '
  set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a
  DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke timeout 120 \
    dsh --profile smoke --patch /tmp/m12-rank/patch-no-tools.yml --json \
    \"What is the maintenance window for this project? Reply with the value only.\"
'"
# → final: m12-rank-window-0300-0400 (no tool calls)

# 5. settings page from the clean install: swap in the web bundle, run a
#    throwaway listener on 3099, curl it, stop it
pct exec 103 -- bash -c 'node -e "
  const fs=require(\"fs\");
  const p=\"/var/lib/deepseek-harness/.dsh-smoke/profiles/smoke/package.json\";
  const d=JSON.parse(fs.readFileSync(p));
  d.dsh.profile.bundles=[\"@deepseek-ai/dsh-base\",\"@deepseek-ai/dsh-web-app\"];
  fs.writeFileSync(p, JSON.stringify(d,null,2)+\"\\n\");
"'
pct exec 103 -- bash -c "su dsh -s /bin/bash -c '
  set -a; . /etc/dsh/cognee.env; set +a
  export DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke
  dsh --profile smoke --no-open --host 127.0.0.1 --port 3099 >/tmp/smoke-web.log 2>&1 &
  pid=\$!
  for i in \$(seq 1 25); do
    code=\$(curl -s -o /dev/null -w \"%{http_code}\" -H \"Authorization: Bearer \$COGNEE_MEMORY_SETTINGS_TOKEN\" \
      http://127.0.0.1:3099/plugins/cognee-memory/settings.json)
    [ \"\$code\" = 200 ] && break; sleep 1
  done
  echo settings_json=\$code
  curl -s -o /dev/null -w \"wrong_token=%{http_code}\n\" -H \"Authorization: Bearer wrong\" \
    http://127.0.0.1:3099/plugins/cognee-memory/settings.json
  kill \$pid
'"
# → settings_json=200, wrong_token=401

# 6. cleanup: remove only the smoke home created above
pct exec 103 -- rm -rf /var/lib/deepseek-harness/.dsh-smoke /tmp/smoke-web.log
```

The smoke fixture (`dsh/eval/m12-ranking`) is synthetic evaluation data; it is
separate from the read-only fixtures (`3d8d8ad8-41be-59c3-9310-7915c783e5ef`,
`amber-otter-7731`) and from the service scope (`dsh/project/e2e`). Do **not**
delete the service profile.

## 6. Backup before changes

```bash
pct exec 103 -- tar -C /var/lib/deepseek-harness/.dsh -czf \
  /var/lib/deepseek-harness/dsh-profile-web-$(date +%F).tgz profiles/web
```

State outside the package (`$DSH_HOME/plugins/cognee-memory/settings.json`,
`provenance.json`) survives installs and belongs in the backup.

## 7. Restart / rollback

Restart is mandatory after plugin changes:

```bash
pct exec 103 -- systemctl restart deepseek-harness
```

Rollback (including profile restore) is documented in
[`../ROLLBACK.md`](../ROLLBACK.md).

## 8. Stale Studio key (model 401s)

Symptom: model calls fail with `401` after a key rotation. Recover without
touching memory data:

```bash
pct exec 103 -- bash -c "ssh root@10.20.10.30 'cat /root/.studio.key' > /etc/dsh/llm.env.new"
pct exec 103 -- install -o root -g dsh -m 0640 /etc/dsh/llm.env.new /etc/dsh/llm.env
pct exec 103 -- rm -f /etc/dsh/llm.env.new
pct exec 103 -- systemctl restart deepseek-harness
```

The `.env` files must stay `0640 root:dsh`; a world-readable key file is a
deployment defect even if the key is valid. The web profile can alternatively
re-enter the provider key through the UI, because provider keys are stored by
DSH, not by this plugin.
