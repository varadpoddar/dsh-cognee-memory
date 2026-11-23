/**
 * Ownership / mode invariants for the memory stack's on-disk state.
 *
 * These are pure functions over an injected `stat`-like record so that privileged
 * situations (a root-owned profile manifest, a world-readable secret) can be
 * asserted in a unit test that never runs as root and never touches a real
 * `/etc/dsh` or `$DSH_HOME`.
 *
 * The invariants themselves come from production, where getting them wrong has
 * already cost one outage: `/etc/dsh/*.env` is `0640 root:dsh`, and everything
 * under `$DSH_HOME` is owned by `dsh` because running `pnpm`/`dsh plugin` as root
 * there leaves root-owned files that the service can no longer rewrite.
 */

/** The subset of `fs.Stats` these checks need. */
export interface FileStat {
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

/** Expected ownership, expressed as numeric ids so the check works without a passwd db. */
export interface Ownership {
  readonly uid: number
  readonly gid: number
  readonly label: string
}

/** A loud, actionable failure. Never swallowed: callers either rethrow or report. */
export class PermissionViolation extends Error {
  readonly path: string
  readonly problems: readonly string[]
  readonly fix: string

  constructor(path: string, problems: readonly string[], fix: string) {
    super(`${path}: ${problems.join('; ')} — fix: ${fix}`)
    this.name = 'PermissionViolation'
    this.path = path
    this.problems = problems
    this.fix = fix
  }
}

const oct = (mode: number): string => `0${(mode & 0o777).toString(8)}`

/**
 * `/etc/dsh/<name>.env` holds the Cognee API key and the LLM credentials. It must
 * be readable by the `dsh` group only.
 */
export function assertEnvFileMode(path: string, st: FileStat, owner: Ownership): void {
  const problems: string[] = []
  const perms = st.mode & 0o777
  if (perms !== 0o640) {
    problems.push(`mode ${oct(st.mode)} is not 0640`)
  }
  if (st.uid !== owner.uid || st.gid !== owner.gid) {
    problems.push(`owner ${st.uid}:${st.gid} is not ${owner.uid}:${owner.gid} (${owner.label})`)
  }
  if (problems.length > 0) {
    throw new PermissionViolation(path, problems, `install -m 0640 -o root -g dsh ${path}`)
  }
}

/**
 * A profile directory (or any file inside it) must be owned by the service user.
 * A root-owned profile manifest is the exact failure mode that took the harness
 * down: the file looks fine, `dsh` just cannot rewrite it, and the next plugin
 * operation fails at the least convenient moment.
 */
export function assertProfileOwnership(path: string, st: FileStat, owner: Ownership): void {
  if (st.uid !== owner.uid) {
    throw new PermissionViolation(
      path,
      [
        `owned by uid ${st.uid}, expected uid ${owner.uid} (${owner.label})`,
        'a root-owned file under $DSH_HOME means something ran as root where it must not',
      ],
      `chown -R ${owner.label} ${path}, then re-run as ${owner.label.split(':')[0]} (never as root)`,
    )
  }
  if ((st.mode & 0o022) !== 0) {
    throw new PermissionViolation(
      path,
      [`mode ${oct(st.mode)} is group- or world-writable`],
      `chmod -R go-w ${path}`,
    )
  }
}

/** Profile state must never be world-readable: sessions and the memory ledger live there. */
export function assertNotWorldReadable(path: string, st: FileStat): void {
  if ((st.mode & 0o004) !== 0) {
    throw new PermissionViolation(
      path,
      [`mode ${oct(st.mode)} is world-readable`],
      `chmod -R o-rwx ${path}`,
    )
  }
}

/** Check every entry of a directory listing; returns all violations instead of the first. */
export function collectViolations(
  entries: ReadonlyArray<{ path: string; stat: FileStat }>,
  check: (path: string, st: FileStat) => void,
): PermissionViolation[] {
  const violations: PermissionViolation[] = []
  for (const entry of entries) {
    try {
      check(entry.path, entry.stat)
    } catch (error) {
      if (error instanceof PermissionViolation) violations.push(error)
      else throw error
    }
  }
  return violations
}
