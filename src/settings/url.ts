/**
 * URL validation for runtime-editable Cognee addresses.
 *
 * The rule is deliberately the same one `Config` enforces (`httpUrlSchema`):
 * absolute http(s), no embedded credentials. Settings are typed by a human into
 * a form, so this module also rejects the shapes that parse but cannot be a
 * base URL (query, fragment) and returns a message fit for rendering.
 */
import { httpUrlSchema } from '../config/schema.js'

/** Path of the settings page (declared here to avoid a route/helper import cycle). */
export const SETTINGS_PAGE_PATH = '/plugins/cognee-memory/settings'

/** The token placeholder printed by `memory_status`; never the token value. */
export const SETTINGS_TOKEN_PLACEHOLDER = '<COGNEE_MEMORY_SETTINGS_TOKEN>'

/**
 * Environment variable holding the operator token. Duplicated as a literal on
 * purpose: `store.ts` imports `validateCogneeUrl` from this module, so importing
 * the constant back would create an ESM cycle that failed at live load
 * ("Cannot access 'SETTINGS_TOKEN_ENV' before initialization").
 */
const SETTINGS_TOKEN_ENV = 'COGNEE_MEMORY_SETTINGS_TOKEN'

/** Where the real token lives, for the operator reading status output. */
export const SETTINGS_TOKEN_SOURCE =
  `${SETTINGS_TOKEN_ENV} in /etc/dsh/cognee.env (service environment)`

export interface SettingsPageLocation {
  /** Exact page URL, with the token as a literal placeholder. */
  readonly url: string
  /** Whether the token variable is present; the value itself is never read. */
  readonly tokenSet: boolean
  readonly tokenSource: string
}

/**
 * Build the operator-facing settings URL. `publicBaseUrl` is the deployment's
 * browser origin (Traefik/reverse proxy) because the plugin does not know it at
 * runtime; without one the path alone is returned, which is still useful in a
 * headless log.
 *
 * The real token is deliberately not interpolated: status output may reach the
 * model, logs, or a transcript, while the operator can read the variable from
 * the service environment.
 */
export function buildSettingsUrl(
  publicBaseUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): SettingsPageLocation {
  const base = (publicBaseUrl ?? '').trim().replace(/\/+$/, '')
  const tokenSet = (env[SETTINGS_TOKEN_ENV] ?? '').trim() !== ''
  return {
    url: `${base}${SETTINGS_PAGE_PATH}?token=${SETTINGS_TOKEN_PLACEHOLDER}`,
    tokenSet,
    tokenSource: SETTINGS_TOKEN_SOURCE,
  }
}

/** A base URL longer than this is a mistake, not a deployment. */
const MAX_URL_LENGTH = 2_048

export type UrlValidationResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string }

/**
 * Validate and normalize one Cognee endpoint.
 *
 * Normalization strips trailing slashes so `http://h:8000/api/v1/` and
 * `http://h:8000/api/v1` are one configured value.
 */
export function validateCogneeUrl(raw: unknown): UrlValidationResult {
  if (typeof raw !== 'string') return { ok: false, error: 'must be a string' }
  const value = raw.trim()
  if (value === '') return { ok: false, error: 'must not be empty' }
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, error: `must be at most ${MAX_URL_LENGTH} characters` }
  }

  const parsed = httpUrlSchema.safeParse(value)
  if (!parsed.success) {
    const issue: string = parsed.error.issues[0]?.message ?? 'is not a valid URL'
    return { ok: false, error: issue }
  }

  const url = new URL(parsed.data as string)
  if (url.search !== '') return { ok: false, error: 'must not contain a query string' }
  if (url.hash !== '') return { ok: false, error: 'must not contain a fragment' }
  if (url.hostname === '') return { ok: false, error: 'must include a host' }

  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${url.origin}${path}` }
}
