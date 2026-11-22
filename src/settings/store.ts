/**
 * Persisted, runtime-editable Cognee settings.
 *
 * WHY A FILE: the installed DSH 0.2.1-rc.5 exposes no host-side settings/config
 * service: `ctx.webServer.register` (`dsh-host-webserver/lib/types/index.d.ts:174`)
 * is the host's only web extension point, and runtime configuration is not a
 * service a plugin can provide into. The plugin therefore owns one JSON file,
 * re-reads it when its mtime/size changes, and serves a form over its own
 * authenticated routes (`./http.ts`). A native settings *section* would be a
 * client-slot registration (`settings.section`, see docs/UI_INTEGRATION.md) and
 * would not remove the need for this file.
 *
 * PRECEDENCE, highest first (asserted in `test/settings-store.test.ts`):
 *   1. stored setting   — the value an operator saved from the settings page
 *   2. environment      — `COGNEE_MEMORY_API_BASE_URL`, `COGNEE_MEMORY_MCP_URL`,
 *                         `COGNEE_MEMORY_ENABLED`
 *   3. profile config   — the `config:` block in the profile patch entry
 *   4. schema default   — `http://127.0.0.1:8000/api/v1`
 *
 * The stored value outranks the environment on purpose: the whole point of the
 * page is changing the target without editing unit files. Clearing the stored
 * value falls back to the environment, then to the profile.
 *
 * The Cognee API key is NEVER stored here. Only the name of the environment
 * variable that holds it is reported, and only as set/unset.
 */
import { readFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { parseConfig, DEFAULT_CONFIG } from '../config/schema.js'
import { validateCogneeUrl } from './url.js'

/** Environment variable naming the settings file. */
export const SETTINGS_FILE_ENV = 'COGNEE_MEMORY_SETTINGS_FILE'
/** Environment variables that seed a setting when no stored value exists. */
export const SETTINGS_ENV = Object.freeze({
  apiBaseUrl: 'COGNEE_MEMORY_API_BASE_URL',
  mcpUrl: 'COGNEE_MEMORY_MCP_URL',
  enabled: 'COGNEE_MEMORY_ENABLED',
  autoRecall: 'COGNEE_MEMORY_AUTO_RECALL',
  autoWrite: 'COGNEE_MEMORY_AUTO_WRITE',
})
/** Credential for the settings routes themselves (never the Cognee key). */
export const SETTINGS_TOKEN_ENV = 'COGNEE_MEMORY_SETTINGS_TOKEN'

/** Absolute path of the settings file for this process. */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[SETTINGS_FILE_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'settings.json')
}

export interface StoredSettings {
  readonly version: 1
  readonly apiBaseUrl?: string
  /** `null` records a deliberate clear, so it also outranks the environment. */
  readonly mcpUrl?: string | null
  readonly enabled?: boolean
  readonly autoRecall?: boolean
  readonly autoWrite?: boolean
  readonly updatedAt?: string
}

export interface SettingsStatus {
  readonly filePath: string
  readonly endpoint: string
  readonly mcpUrl: string | undefined
  readonly enabled: boolean
  readonly autoRecall: boolean
  readonly autoWrite: boolean
  readonly sources: {
    readonly apiBaseUrl: 'stored' | 'env' | 'profile' | 'default'
    readonly mcpUrl: 'stored' | 'env' | 'profile' | 'none'
    readonly autoRecall: 'stored' | 'env' | 'profile'
    readonly autoWrite: 'stored' | 'env' | 'profile'
  }
  /** The Cognee credential presence, never its value. */
  readonly keyVar: string
  readonly keySet: boolean
  readonly warnings: readonly string[]
}

export type SettingsUpdateResult =
  | { readonly ok: true; readonly config: CogneeMemoryConfig; readonly settings: StoredSettings }
  | { readonly ok: false; readonly errors: readonly string[] }

export interface SettingsStoreOptions {
  readonly filePath: string
  readonly baseConfig: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly clock?: () => Date
  readonly logger?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '') return undefined
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return undefined
}

/** Parse one persisted file. Unknown keys are rejected, never silently kept. */
export function parseStoredSettings(
  raw: unknown,
): { ok: true; settings: StoredSettings } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['settings file must contain a JSON object'] }
  const errors: string[] = []
  const settings: {
    version: 1
    apiBaseUrl?: string
    mcpUrl?: string | null
    enabled?: boolean
    autoRecall?: boolean
    autoWrite?: boolean
    updatedAt?: string
  } = { version: 1 }

  for (const key of Object.keys(raw)) {
    if (
      ![
        'version',
        'apiBaseUrl',
        'mcpUrl',
        'enabled',
        'autoRecall',
        'autoWrite',
        'updatedAt',
      ].includes(key)
    ) {
      errors.push(`unknown key "${key}"`)
    }
  }
  if (raw.version !== undefined && raw.version !== 1) errors.push('version must be 1')

  if (raw.apiBaseUrl !== undefined) {
    const result = validateCogneeUrl(raw.apiBaseUrl)
    if (result.ok) settings.apiBaseUrl = result.url
    else errors.push(`apiBaseUrl: ${result.error}`)
  }
  if (raw.mcpUrl !== undefined) {
    if (raw.mcpUrl === null) settings.mcpUrl = null
    else {
      const result = validateCogneeUrl(raw.mcpUrl)
      if (result.ok) settings.mcpUrl = result.url
      else errors.push(`mcpUrl: ${result.error}`)
    }
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled
    else errors.push('enabled must be a boolean')
  }
  if (raw.autoRecall !== undefined) {
    if (typeof raw.autoRecall === 'boolean') settings.autoRecall = raw.autoRecall
    else errors.push('autoRecall must be a boolean')
  }
  if (raw.autoWrite !== undefined) {
    if (typeof raw.autoWrite === 'boolean') settings.autoWrite = raw.autoWrite
    else errors.push('autoWrite must be a boolean')
  }
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt === 'string') settings.updatedAt = raw.updatedAt
    else errors.push('updatedAt must be a string')
  }

  return errors.length === 0 ? { ok: true, settings } : { ok: false, errors }
}

export class SettingsStore {
  readonly filePath: string
  private readonly baseConfig: CogneeMemoryConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly clock: () => Date
  private readonly logger: ((message: string) => void) | undefined
  private stored: StoredSettings = { version: 1 }
  private effective: CogneeMemoryConfig
  private stamp: string | undefined
  private warnings: string[] = []
  private readonly listeners = new Set<(config: CogneeMemoryConfig) => void>()

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath
    this.baseConfig = options.baseConfig
    this.env = options.env ?? process.env
    this.clock = options.clock ?? (() => new Date())
    this.logger = options.logger
    this.effective = this.compose()
    this.refresh()
  }

  /** Effective config; re-reads the file first when it changed on disk. */
  current(): CogneeMemoryConfig {
    this.refresh()
    return this.effective
  }

  /** Stored values only (never environment or defaults). */
  read(): StoredSettings {
    this.refresh()
    return this.stored
  }

  status(): SettingsStatus {
    this.refresh()
    const base = this.baseConfig
    const envApi = validateCogneeUrl(this.env[SETTINGS_ENV.apiBaseUrl] ?? '')
    const apiSource: SettingsStatus['sources']['apiBaseUrl'] =
      this.stored.apiBaseUrl !== undefined
        ? 'stored'
        : envApi.ok
          ? 'env'
          : base.apiBaseUrl === DEFAULT_CONFIG.apiBaseUrl
            ? 'default'
            : 'profile'

    const envMcp = this.env[SETTINGS_ENV.mcpUrl]?.trim() ?? ''
    const effectiveMcp = this.effective.mcpUrl
    const mcpSource: SettingsStatus['sources']['mcpUrl'] =
      this.stored.mcpUrl === null
        ? 'stored'
        : this.stored.mcpUrl !== undefined
          ? 'stored'
          : envMcp !== '' && effectiveMcp === envMcp
            ? 'env'
            : effectiveMcp === undefined
              ? 'none'
              : 'profile'

    const autoSource = (stored: boolean | undefined, envValue: boolean | undefined): 'stored' | 'env' | 'profile' =>
      stored !== undefined ? 'stored' : envValue !== undefined ? 'env' : 'profile'
    const envAutoRecall = envFlag(this.env[SETTINGS_ENV.autoRecall])
    const envAutoWrite = envFlag(this.env[SETTINGS_ENV.autoWrite])

    return {
      filePath: this.filePath,
      endpoint: this.effective.apiBaseUrl,
      mcpUrl: effectiveMcp,
      enabled: this.effective.enabled,
      autoRecall: this.effective.autoRecall,
      autoWrite: this.effective.autoWrite,
      sources: {
        apiBaseUrl: apiSource,
        mcpUrl: mcpSource,
        autoRecall: autoSource(this.stored.autoRecall, envAutoRecall),
        autoWrite: autoSource(this.stored.autoWrite, envAutoWrite),
      },
      keyVar: this.baseConfig.apiTokenEnv,
      keySet: (this.env[this.baseConfig.apiTokenEnv] ?? '').trim() !== '',
      warnings: [...this.warnings],
    }
  }

  /**
   * Validate a submitted change, persist it, then make it effective.
   * Memory is only mutated after the write succeeds, so a failed write cannot
   * leave the running process pointed at a value that will vanish on restart.
   */
  update(input: unknown): SettingsUpdateResult {
    if (!isRecord(input)) return { ok: false, errors: ['expected a form submission'] }
    const errors: string[] = []

    const apiBaseUrl = validateCogneeUrl(input.apiBaseUrl)
    if (!apiBaseUrl.ok) errors.push(`apiBaseUrl: ${apiBaseUrl.error}`)

    let mcpUrl: string | null
    const rawMcp = typeof input.mcpUrl === 'string' ? input.mcpUrl.trim() : ''
    if (rawMcp === '') mcpUrl = null
    else {
      const validated = validateCogneeUrl(rawMcp)
      if (validated.ok) mcpUrl = validated.url
      else {
        errors.push(`mcpUrl: ${validated.error}`)
        mcpUrl = null
      }
    }

    const enabled = input.enabled === true || input.enabled === 'true' || input.enabled === 'on'
    if (errors.length > 0 || !apiBaseUrl.ok) return { ok: false, errors }

    const previous = this.read()
    const toggle = (raw: unknown): boolean | undefined => {
      if (raw === true || raw === 'true' || raw === 'on') return true
      if (raw === false || raw === 'false' || raw === 'off') return false
      return undefined
    }
    const settings: StoredSettings = {
      version: 1,
      apiBaseUrl: apiBaseUrl.url,
      mcpUrl,
      enabled,
      autoRecall: toggle(input.autoRecall) ?? previous.autoRecall ?? true,
      autoWrite: toggle(input.autoWrite) ?? previous.autoWrite ?? true,
      updatedAt: this.clock().toISOString(),
    }

    try {
      this.persist(settings)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, errors: [`could not write ${this.filePath}: ${reason}`] }
    }

    this.stored = settings
    this.stamp = this.statStamp()
    this.applyEffective()
    return { ok: true, config: this.effective, settings }
  }

  /** Subscribe to effective-config changes; returns the unsubscribe. */
  onChange(listener: (config: CogneeMemoryConfig) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private envApiBaseUrl(): string | undefined {
    const validated = validateCogneeUrl(this.env[SETTINGS_ENV.apiBaseUrl] ?? '')
    return validated.ok ? validated.url : undefined
  }

  /** stored > env > profile > default, for the three settings this file owns. */
  private compose(): CogneeMemoryConfig {
    const envApi = this.envApiBaseUrl()
    const envMcp = validateCogneeUrl(this.env[SETTINGS_ENV.mcpUrl] ?? '')
    const envEnabled = envFlag(this.env[SETTINGS_ENV.enabled])
    const envAutoRecall = envFlag(this.env[SETTINGS_ENV.autoRecall])
    const envAutoWrite = envFlag(this.env[SETTINGS_ENV.autoWrite])

    const patch: Record<string, unknown> = {}
    if (this.stored.apiBaseUrl !== undefined) patch.apiBaseUrl = this.stored.apiBaseUrl
    else if (envApi !== undefined) patch.apiBaseUrl = envApi

    if (this.stored.mcpUrl === null) patch.mcpUrl = undefined
    else if (this.stored.mcpUrl !== undefined) patch.mcpUrl = this.stored.mcpUrl
    else if (envMcp.ok) patch.mcpUrl = envMcp.url

    if (this.stored.enabled !== undefined) patch.enabled = this.stored.enabled
    else if (envEnabled !== undefined) patch.enabled = envEnabled

    if (this.stored.autoRecall !== undefined) patch.autoRecall = this.stored.autoRecall
    else if (envAutoRecall !== undefined) patch.autoRecall = envAutoRecall

    if (this.stored.autoWrite !== undefined) patch.autoWrite = this.stored.autoWrite
    else if (envAutoWrite !== undefined) patch.autoWrite = envAutoWrite

    try {
      return parseConfig({ ...this.baseConfig, ...patch })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.warnings = [...this.warnings.filter((w) => !w.startsWith('config:')), `config: ${reason}`]
      return this.baseConfig
    }
  }

  private applyEffective(): void {
    const previous = this.effective
    this.effective = this.compose()
    if (
      previous.apiBaseUrl === this.effective.apiBaseUrl &&
      previous.mcpUrl === this.effective.mcpUrl &&
      previous.enabled === this.effective.enabled &&
      previous.autoRecall === this.effective.autoRecall &&
      previous.autoWrite === this.effective.autoWrite
    ) {
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(this.effective)
      } catch {
        // A listener failure must not roll back an already-persisted change.
      }
    }
  }

  private statStamp(): string | undefined {
    try {
      const stat = statSync(this.filePath)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return undefined
    }
  }

  /** Re-read when the file changed underneath us (hand edit, another process). */
  private refresh(): void {
    const stamp = this.statStamp()
    if (stamp === this.stamp && stamp !== undefined) return
    this.stamp = stamp
    if (stamp === undefined) {
      if (
        this.stored.apiBaseUrl !== undefined ||
        this.stored.enabled !== undefined ||
        this.stored.mcpUrl !== undefined ||
        this.stored.autoRecall !== undefined ||
        this.stored.autoWrite !== undefined
      ) {
        this.stored = { version: 1 }
        this.applyEffective()
      }
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.warnings = [...this.warnings.filter((w) => !w.startsWith('file:')), `file: ${reason}`]
      this.logger?.(`cognee-memory settings: ignoring unreadable file (${reason})`)
      return
    }
    const parsed = parseStoredSettings(raw)
    if (!parsed.ok) {
      this.warnings = [...this.warnings.filter((w) => !w.startsWith('file:')), `file: ${parsed.errors.join('; ')}`]
      this.logger?.(`cognee-memory settings: ignoring invalid file (${parsed.errors.join('; ')})`)
      return
    }
    this.warnings = this.warnings.filter((w) => !w.startsWith('file:'))
    this.stored = parsed.settings
    this.applyEffective()
  }

  /** Atomic replace: a truncated settings file would silently reset the target. */
  private persist(settings: StoredSettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.filePath)
  }
}
