/**
 * The ordered ingest redaction pipeline.
 *
 *   1. deterministic secret redaction  (`redaction.ts`, high-confidence shapes)
 *   2. LLM PII pass                    (`pii.ts`, names/addresses/etc -> placeholders)
 *   3. re-scan for secrets            (the model must not have reintroduced any)
 *   4. only then hand text to the adapter
 *
 * Step 3 is not theatre: the PII pass rewrites the string, and a partial
 * replacement can splice a token back together (for example dropping the
 * prefix of a key so the remainder no longer matches the original regex but
 * still looks like a credential). Re-running the deterministic scan on the
 * final text is the only way to assert "no secrets remain in what we upload".
 *
 * The placeholder map is returned for local inspection and is deliberately not
 * part of `text`. Callers persist it themselves with `saveMap`.
 */
import { redactSecrets, findSecrets, type SecretKind } from './redaction.js'
import {
  applyPlaceholders,
  detectPii,
  PlaceholderMap,
  type DetectionOptions,
  type PiiFinding,
} from './pii.js'

export interface IngestRedactionOptions {
  /** PII pass is skipped when omitted; secrets still apply. */
  readonly pii?: DetectionOptions
  readonly map?: PlaceholderMap
  /** Deterministic mode for credentials. Defaults to `redact`. */
  readonly secretMode?: 'reject' | 'redact'
}

export interface IngestRedactionResult {
  readonly text: string
  readonly secretKinds: readonly SecretKind[]
  readonly piiFindings: readonly PiiFinding[]
  /** Secrets found in the *final* text; non-empty means the text must not ship. */
  readonly residualSecretKinds: readonly SecretKind[]
  readonly map: PlaceholderMap
  readonly piiApplied: boolean
}

/** Raised when the post-PII re-scan still finds credential material. */
export class ResidualSecretError extends Error {
  readonly kinds: readonly SecretKind[]
  constructor(kinds: readonly SecretKind[]) {
    super(`redaction left ${kinds.length} credential match(es) in the text`)
    this.name = 'ResidualSecretError'
    this.kinds = kinds
  }
}

/** Run the full ordered pass. Throws {@link ResidualSecretError} on step 3. */
export async function redactForIngest(
  text: string,
  options: IngestRedactionOptions = {},
): Promise<IngestRedactionResult> {
  const map = options.map ?? new PlaceholderMap()

  // 1. Deterministic secrets.
  const secretPass = redactSecrets(text)
  if (secretPass.redacted && (options.secretMode ?? 'redact') === 'reject') {
    throw new ResidualSecretError(secretPass.findings.map((finding) => finding.kind))
  }
  let working = secretPass.text
  const secretKinds = secretPass.findings.map((finding) => finding.kind)

  // 2. LLM PII pass.
  let piiFindings: readonly PiiFinding[] = []
  let piiApplied = false
  if (options.pii !== undefined) {
    const entities = await detectPii(working, options.pii)
    const applied = applyPlaceholders(working, entities, map)
    working = applied.text
    piiFindings = applied.findings
    piiApplied = entities.length > 0
  }

  // 3. Re-scan the text that would actually be uploaded.
  const residual = findSecrets(working)
  if (residual.length > 0) {
    throw new ResidualSecretError(residual.map((finding) => finding.kind))
  }

  return { text: working, secretKinds, piiFindings, residualSecretKinds: [], map, piiApplied }
}

/** Entity-type histogram for reports; values are never included. */
export function summarizePii(findings: readonly PiiFinding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1
  return counts
}
