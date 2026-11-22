# ROLLBACK — dsh-cognee-memory 1.0.0

Use this when 1.0.0 must be withdrawn: a regression that affects agent turns, a
failed install, or a settings-page/route outage. Memory data is preserved
throughout — the plugin never deletes datasets on rollback, and the fixture
datasets are not touched.

## Triggers

- Agent turns fail or degrade after the upgrade (e.g. prefetch timeouts).
- `deepseek-harness.service` does not become `active` after the restart.
- The settings/provenance routes answer `5xx` in a way that blocks operators.
- The installed artifact cannot be explained by the pinned tarball.

## Pre-checks (do these first, they are read-only)

```bash
pct exec 103 -- systemctl is-active deepseek-harness
pct exec 103 -- journalctl -u deepseek-harness -n 100 --no-pager | tail -40
pct exec 103 -- su dsh -s /bin/bash -c \
  'DSH_HOME=/var/lib/deepseek-harness/.dsh dsh plugin --profile web why dsh-cognee-memory'
pct exec 103 -- ls -l /var/lib/deepseek-harness/dsh-profile-web-*.tgz
```

If the service is unhealthy because of the model key rather than the plugin, fix
the key instead (see `docs/DEPLOYMENT.md` §8) — do not roll back blindly.

## Rollback procedure

```bash
# 1. stop the service
pct exec 103 -- systemctl stop deepseek-harness

# 2. remove the plugin from the service profile
pct exec 103 -- su dsh -s /bin/bash -c \
  'DSH_HOME=/var/lib/deepseek-harness/.dsh dsh plugin --profile web remove dsh-cognee-memory'

# 3. restore the profile backup taken before the change
#    (backup path: /var/lib/deepseek-harness/dsh-profile-web-<date>.tgz)
#    Extract into a staging dir and swap directories, so a partial extract
#    never leaves a half-written profile.
pct exec 103 -- bash -c '
  set -e
  rm -rf /var/lib/deepseek-harness/.dsh/.rollback
  mkdir -p /var/lib/deepseek-harness/.dsh/.rollback
  tar -C /var/lib/deepseek-harness/.dsh/.rollback -xzf \
    /var/lib/deepseek-harness/dsh-profile-web-<date>.tgz
  mv /var/lib/deepseek-harness/.dsh/profiles/web \
     /var/lib/deepseek-harness/.dsh/profiles/web.failed-$(date +%Y%m%dT%H%M%S)
  mv /var/lib/deepseek-harness/.dsh/.rollback/profiles/web \
     /var/lib/deepseek-harness/.dsh/profiles/web
  chown -R dsh:dsh /var/lib/deepseek-harness/.dsh/profiles/web
  rm -rf /var/lib/deepseek-harness/.dsh/.rollback
'

# 4. restart and verify
pct exec 103 -- systemctl start deepseek-harness
pct exec 103 -- systemctl is-active deepseek-harness        # → active
pct exec 103 -- su dsh -s /bin/bash -c \
  'DSH_HOME=/var/lib/deepseek-harness/.dsh dsh plugin --profile web why dsh-cognee-memory'
```

### Alternative: reinstall the previous tarball

If a profile backup does not exist, installing the previous artifact is enough
when the profile row is intact:

```bash
pct exec 103 -- su dsh -s /bin/bash -c '
  DSH_HOME=/var/lib/deepseek-harness/.dsh \
  dsh plugin --profile web add /var/lib/deepseek-harness/dsh-cognee-memory-0.2.1.tgz
'
pct exec 103 -- systemctl restart deepseek-harness
```

`/var/lib/deepseek-harness/` keeps the 0.1.0, 0.2.0 and 0.2.1 tarballs for this
path.

## Post-rollback

- Operator state is preserved: `$DSH_HOME/plugins/cognee-memory/settings.json`
  and `provenance.json` are outside the package. A 1.0.0 settings file is
  readable by 0.2.1 (same schema); delete it only if you want defaults.
- Memory records are not deleted by install/remove/rollback; recall works again
  as soon as the previous version is mounted.
- Keep the failed profile directory (`profiles/web.failed-<stamp>`) until the
  incident is understood, then remove it.
- Record the rollback reason, the artifact versions, and the verification
  output in the incident note.
