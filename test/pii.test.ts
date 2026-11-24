import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPlaceholders,
  decryptMap,
  detectPii,
  encryptMap,
  loadMap,
  PlaceholderMap,
  resolveMapKey,
  resolvePiiMapPath,
  saveMap,
  type PiiEntity,
} from '../src/security/pii.js'
import {
  redactForIngest,
  ResidualSecretError,
  summarizePii,
} from '../src/security/ingest-redaction.js'

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

describe('placeholder map', () => {
  it('assigns stable placeholders per value, not per occurrence', () => {
    const map = new PlaceholderMap()
    const first = applyPlaceholders('Dana met Dana at Base Camp', [{ kind: 'PERSON', value: 'Dana' }], map)
    expect(first.text).toBe('PERSON_1 met PERSON_1 at Base Camp')
    const second = applyPlaceholders('Dana again', [{ kind: 'PERSON', value: 'Dana' }], map)
    // Same person, same number, across documents.
    expect(second.text).toBe('PERSON_1 again')
    expect(map.size).toBe(1)
  })

  it('prefers the longest match and never double-replaces', () => {
    const map = new PlaceholderMap()
    const entities: PiiEntity[] = [
      { kind: 'PERSON', value: 'Dana' },
      { kind: 'PERSON', value: 'Dana Whitfield' },
    ]
    const result = applyPlaceholders('Owner: Dana Whitfield.', entities, map)
    expect(result.text).toBe('Owner: PERSON_1.')
    expect(result.findings).toHaveLength(1)
  })

  it('numbers each kind independently', () => {
    const map = new PlaceholderMap()
    expect(map.assign('PERSON', 'a')).toBe('PERSON_1')
    expect(map.assign('ADDR', 'b')).toBe('ADDR_1')
    expect(map.assign('PERSON', 'c')).toBe('PERSON_2')
  })
})

describe('encrypted local map', () => {
  it('round-trips and never stores plaintext on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-pii-'))
    const key = Buffer.alloc(32, 7)
    const map = new PlaceholderMap()
    map.assign('PERSON', 'Dana Whitfield')
    map.assign('ADDR', '12 Rue de Rivoli')
    const file = join(dir, 'pii-map.enc.json')
    saveMap(file, map, key)

    const body = readFileSync(file, 'utf8')
    expect(body).not.toContain('Dana')
    expect(body).not.toContain('Rivoli')
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const restored = loadMap(file, key)
    expect(restored.lookup('PERSON', 'Dana Whitfield')).toBe('PERSON_1')
    // Continuation keeps numbering instead of restarting at 1.
    expect(restored.assign('PERSON', 'Someone Else')).toBe('PERSON_2')
  })

  it('fails closed when the key is wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-pii-'))
    const map = new PlaceholderMap()
    map.assign('PERSON', 'Dana')
    const file = join(dir, 'map.json')
    saveMap(file, map, Buffer.alloc(32, 1))
    expect(loadMap(file, Buffer.alloc(32, 2)).size).toBe(0)
  })

  it('encrypts with a GCM envelope and rejects tampering', () => {
    const key = Buffer.alloc(32, 3)
    const envelope = JSON.parse(encryptMap(new PlaceholderMap(), key)) as Record<string, string>
    expect(envelope.alg).toBe('aes-256-gcm')
    const tampered = { ...envelope, data: Buffer.from('nope').toString('base64') }
    expect(() => decryptMap(JSON.stringify(tampered), key)).toThrow()
  })

  it('resolves a local-only path and key', () => {
    expect(resolvePiiMapPath({ DSH_HOME: '/tmp/dsh' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/dsh/plugins/cognee-memory/pii-map.enc.json',
    )
    const hex = 'a'.repeat(64)
    expect(resolveMapKey({ COGNEE_PII_MAP_KEY: hex } as NodeJS.ProcessEnv)).toHaveLength(32)
  })
})

describe('LLM detection', () => {
  it('parses a JSON reply and drops placeholder echoes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        'Here you go:\n{"entities":[{"kind":"PERSON","value":"Dana Whitfield"},' +
          '{"kind":"EMAIL","value":"dana@example.com"},{"kind":"PERSON","value":"PERSON_1"},' +
          '{"kind":"NOT_A_KIND","value":"x"}]}',
      ),
    ) as unknown as typeof fetch
    const entities = await detectPii('text', {
      endpoint: 'http://localhost:8888/v1',
      model: 'qwen',
      fetchImpl,
    })
    expect(entities).toEqual([
      { kind: 'PERSON', value: 'Dana Whitfield' },
      { kind: 'EMAIL', value: 'dana@example.com' },
    ])
  })

  it('returns no entities when the endpoint fails, never throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      detectPii('text', { endpoint: 'http://localhost:1/v1', model: 'qwen', fetchImpl }),
    ).resolves.toEqual([])
  })

  it('sends the text and asks for JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"entities":[]}')) as unknown as typeof fetch
    await detectPii('Dana called', {
      endpoint: 'http://localhost:8888/v1/',
      model: 'qwen',
      apiKey: 'k',
      fetchImpl,
    })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[0]).toBe('http://localhost:8888/v1/chat/completions')
    const body = JSON.parse(String((call?.[1] as RequestInit).body))
    expect(body.messages.at(-1).content).toBe('Dana called')
    expect(body.temperature).toBe(0)
  })
})

describe('ordered ingest pipeline', () => {
  it('redacts secrets first, then PII, then re-scans', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"entities":[{"kind":"PERSON","value":"Dana Whitfield"}]}'),
    ) as unknown as typeof fetch
    const result = await redactForIngest(
      'Dana Whitfield pasted sk-abcdefghijklmnopqrstuvwxyz012345 into chat',
      {
        pii: { endpoint: 'http://localhost:8888/v1', model: 'qwen', fetchImpl },
      },
    )
    expect(result.text).toBe('PERSON_1 pasted [REDACTED:api_key] into chat')
    expect(result.secretKinds).toEqual(['api_key'])
    expect(result.residualSecretKinds).toEqual([])
    expect(result.piiFindings[0]?.placeholder).toBe('PERSON_1')
    expect(summarizePii(result.piiFindings)).toEqual({ PERSON: 1 })
  })

  it('skips the PII pass when no endpoint is configured but still strips secrets', async () => {
    const result = await redactForIngest('token AKIAIOSFODNN7EXAMPLE here')
    expect(result.text).toContain('[REDACTED:aws_access_key]')
    expect(result.piiApplied).toBe(false)
    expect(result.map.size).toBe(0)
  })

  it('refuses when the mode is reject and a secret is present', async () => {
    await expect(
      redactForIngest('ghp_abcdefghijklmnopqrstuvwxyz0123456789', { secretMode: 'reject' }),
    ).rejects.toBeInstanceOf(ResidualSecretError)
  })

  it('keeps the placeholder map out of the uploaded text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('{"entities":[{"kind":"PERSON","value":"Dana Whitfield"},{"kind":"ADDR","value":"12 Rue de Rivoli"}]}'),
    ) as unknown as typeof fetch
    const result = await redactForIngest('Dana Whitfield lives at 12 Rue de Rivoli', {
      pii: { endpoint: 'http://localhost:8888/v1', model: 'qwen', fetchImpl },
    })
    expect(result.text).toBe('PERSON_1 lives at ADDR_1')
    // The values live only in the local map, never in the text handed to Cognee.
    expect(result.text).not.toContain('Dana')
    expect(result.text).not.toContain('Rivoli')
    expect(result.map.lookup('PERSON', 'Dana Whitfield')).toBe('PERSON_1')
  })
})
