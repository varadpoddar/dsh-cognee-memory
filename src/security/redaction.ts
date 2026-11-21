import { RedactionBlockedError } from '../errors.js'

export type SecretKind =
  | 'private_key'
  | 'api_key'
  | 'github_token'
  | 'aws_access_key'
  | 'jwt'
  | 'bearer_token'
  | 'password_assignment'
  | 'cognee_token'

export interface SecretFinding {
  readonly kind: SecretKind
  readonly start: number
  readonly end: number
}

export interface RedactionResult {
  readonly text: string
  readonly findings: readonly SecretFinding[]
  readonly redacted: boolean
}

interface Pattern {
  readonly kind: SecretKind
  readonly regex: RegExp
}

/**
 * High-confidence credential shapes only. The generic assignment pattern is
 * filtered against placeholders so documentation like `api_key = $TOKEN`
 * is not treated as a secret.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'private_key',
    regex:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  { kind: 'api_key', regex: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{24,}\b/g },
  { kind: 'github_token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi },
  { kind: 'cognee_token', regex: /\bcognee[_-][A-Za-z0-9]{16,}\b/gi },
  {
    kind: 'password_assignment',
    regex:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
  },
]

const PLACEHOLDER = /(?:process\.env|env\.|os\.environ|\$[A-Z_]|\{\{|<[^>]+>|\*{3,}|\[REDACTED|REDACTED|placeholder|example|changeme|x{6,})/i

function isPlaceholderMatch(match: string): boolean {
  return PLACEHOLDER.test(match)
}

/** Locate credential material. Ranges are UTF-16 code-unit offsets. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0
    for (const match of text.matchAll(pattern.regex)) {
      if (match.index === undefined) continue
      if (pattern.kind === 'password_assignment' && isPlaceholderMatch(match[0])) continue
      findings.push({ kind: pattern.kind, start: match.index, end: match.index + match[0].length })
    }
  }
  findings.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: SecretFinding[] = []
  for (const finding of findings) {
    const previous = merged.at(-1)
    if (previous !== undefined && finding.start < previous.end) {
      if (finding.end > previous.end) {
        merged[merged.length - 1] = { kind: previous.kind, start: previous.start, end: finding.end }
      }
      continue
    }
    merged.push(finding)
  }
  return merged
}

/** Replace every detected credential with a non-reversible marker. */
export function redactSecrets(text: string): RedactionResult {
  const findings = findSecrets(text)
  if (findings.length === 0) return { text, findings, redacted: false }
  let output = ''
  let cursor = 0
  for (const finding of findings) {
    output += text.slice(cursor, finding.start)
    output += `[REDACTED:${finding.kind}]`
    cursor = finding.end
  }
  output += text.slice(cursor)
  return { text: output, findings, redacted: true }
}

/**
 * Gate immediately before any write. `reject` (default) refuses and reports
 * only the kinds, never the matched value; `redact` replaces matches.
 */
export function guardForWrite(
  text: string,
  mode: 'reject' | 'redact',
): { readonly text: string; readonly redacted: boolean } {
  const result = redactSecrets(text)
  if (!result.redacted) return { text, redacted: false }
  if (mode === 'reject') {
    throw new RedactionBlockedError(result.findings.map((finding) => finding.kind))
  }
  return { text: result.text, redacted: true }
}
