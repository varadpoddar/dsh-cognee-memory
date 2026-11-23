import { describe, expect, it } from 'vitest'
import {
  PermissionViolation,
  assertEnvFileMode,
  assertNotWorldReadable,
  assertProfileOwnership,
  collectViolations,
  type FileStat,
  type Ownership,
} from './helpers/permissions.js'

/**
 * These encode the two on-disk rules the deployment depends on:
 *
 *   /etc/dsh/*.env         0640 root:dsh   (Cognee API key, LLM credentials)
 *   $DSH_HOME/**           owned by dsh    (profiles, sessions, memory ledger)
 *
 * The second one is not cosmetic: a root-owned profile manifest is what a
 * `pnpm`/`dsh plugin` run as root leaves behind, and the service can no longer
 * rewrite its own state afterwards. The tests assert that such a file fails
 * loudly, with the path and the fix in the message.
 */

const DSHD: Ownership = { uid: 999, gid: 999, label: 'dsh:dsh' }
const ROOT_DSH: Ownership = { uid: 0, gid: 999, label: 'root:dsh' }

const stat = (uid: number, gid: number, mode: number): FileStat => ({ uid, gid, mode })

describe('/etc/dsh env files', () => {
  it('accepts 0640 root:dsh', () => {
    expect(() =>
      assertEnvFileMode('/etc/dsh/cognee.env', stat(0, 999, 0o640), ROOT_DSH),
    ).not.toThrow()
  })

  it('rejects a world-readable secret and names the file and the fix', () => {
    let error: unknown
    try {
      assertEnvFileMode('/etc/dsh/cognee.env', stat(0, 999, 0o644), ROOT_DSH)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PermissionViolation)
    const violation = error as PermissionViolation
    expect(violation.message).toContain('/etc/dsh/cognee.env')
    expect(violation.message).toContain('0644')
    expect(violation.message).toContain('0640')
    expect(violation.fix).toContain('install -m 0640')
  })

  it('rejects a group-writable secret', () => {
    expect(() => assertEnvFileMode('/etc/dsh/dsh.env', stat(0, 999, 0o660), ROOT_DSH)).toThrow(
      /is not 0640/,
    )
  })

  it('rejects the right mode on the wrong owner', () => {
    expect(() => assertEnvFileMode('/etc/dsh/llm.env', stat(0, 0, 0o640), ROOT_DSH)).toThrow(
      /owner 0:0 is not 0:999 \(root:dsh\)/,
    )
  })

  it('reports every broken entry instead of stopping at the first', () => {
    const violations = collectViolations(
      [
        { path: '/etc/dsh/cognee.env', stat: stat(0, 999, 0o640) },
        { path: '/etc/dsh/dsh.env', stat: stat(0, 0, 0o644) },
        { path: '/etc/dsh/llm.env', stat: stat(999, 999, 0o640) },
      ],
      (path, st) => assertEnvFileMode(path, st, ROOT_DSH),
    )
    expect(violations.map((v) => v.path)).toEqual(['/etc/dsh/dsh.env', '/etc/dsh/llm.env'])
  })
})

describe('profile ownership under $DSH_HOME', () => {
  it('accepts a dsh-owned profile directory', () => {
    expect(() =>
      assertProfileOwnership('/var/lib/deepseek-harness/.dsh/profiles/web', stat(999, 999, 0o700), DSHD),
    ).not.toThrow()
  })

  it('fails loudly on a root-owned profile manifest', () => {
    // The exact aftermath of running plugin commands as root: the file exists,
    // is small and looks harmless, and is owned by uid 0.
    const path = '/var/lib/deepseek-harness/.dsh/profiles/web/cordis.patch.yml'
    let error: unknown
    try {
      assertProfileOwnership(path, stat(0, 0, 0o600), DSHD)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(PermissionViolation)
    const violation = error as PermissionViolation
    // Loud: the message is a diagnosis, not a boolean.
    expect(violation.message).toContain(path)
    expect(violation.message).toContain('owned by uid 0, expected uid 999 (dsh:dsh)')
    expect(violation.message).toContain('ran as root')
    // Actionable: it says how to recover, and warns against repeating it.
    expect(violation.fix).toContain('chown -R dsh:dsh')
    expect(violation.fix).toContain('never as root')
    // It is a distinct, catchable type, so a caller cannot mistake it for I/O noise.
    expect(violation.name).toBe('PermissionViolation')
  })

  it('fails on a group-writable profile directory', () => {
    expect(() =>
      assertProfileOwnership('/var/lib/deepseek-harness/.dsh/profiles/headless', stat(999, 999, 0o770), DSHD),
    ).toThrow(/group- or world-writable/)
  })

  it('rejects a world-readable profile tree', () => {
    expect(() => assertNotWorldReadable('/var/lib/deepseek-harness/.dsh/sessions', stat(999, 999, 0o705)))
      .toThrow(/world-readable/)
    expect(() => assertNotWorldReadable('/var/lib/deepseek-harness/.dsh/sessions', stat(999, 999, 0o700),))
      .not.toThrow()
  })

  it('accepts the production layout end to end', () => {
    const layout = [
      { path: '/var/lib/deepseek-harness/.dsh', stat: stat(999, 999, 0o700) },
      { path: '/var/lib/deepseek-harness/.dsh/profiles', stat: stat(999, 999, 0o700) },
      { path: '/var/lib/deepseek-harness/.dsh/profiles/web', stat: stat(999, 999, 0o700) },
      { path: '/var/lib/deepseek-harness/.dsh/plugins/cognee-memory/provenance.json', stat: stat(999, 999, 0o600) },
    ]
    const violations = collectViolations(layout, (path, st) => {
      assertProfileOwnership(path, st, DSHD)
      assertNotWorldReadable(path, st)
    })
    expect(violations).toEqual([])
  })
})
