/**
 * URL validation for runtime-editable Cognee addresses.
 *
 * The rule is deliberately the same one `Config` enforces (`httpUrlSchema`):
 * absolute http(s), no embedded credentials. Settings are typed by a human into
 * a form, so this module also rejects the shapes that parse but cannot be a
 * base URL (query, fragment) and returns a message fit for rendering.
 */
import { httpUrlSchema } from '../config/schema.js'

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
