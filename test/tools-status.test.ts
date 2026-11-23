import { describe, expect, it } from 'vitest'
import { createStatusTool } from '../src/tools/status.js'
import { createHarness } from './helpers/fake-coordinator.js'

function exec() {
  return { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }
}

describe('memory_status tool', () => {
  it('reports transport, reachability, counters, and a safe endpoint', async () => {
    const harness = createHarness()
    const tool = createStatusTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({}, exec())) as {
      enabled: boolean
      transport: string
      reachable: boolean
      endpoint: string
      authMode: string
      failureMode: string
      counters: Record<string, number>
      details: Record<string, unknown>
    }
    expect(value).toMatchObject({
      enabled: true,
      transport: 'rest',
      reachable: true,
      endpoint: 'http://127.0.0.1:9',
      authMode: 'none',
      failureMode: 'open',
    })
    expect(value.counters).toHaveProperty('recall.requests')
    expect(value.details.datasetCount).toBe(1)
  })

  it('renders status without token or credential values', async () => {
    const harness = createHarness()
    const tool = createStatusTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({}, exec())) as never
    const rendered = tool.output.render({}, value)[0]?.text ?? ''
    expect(rendered).toContain('Cognee memory status')
    expect(rendered).not.toMatch(/bearer|secret|password|sk-/i)
  })

  it('reports unreachable backends without throwing', async () => {
    const harness = createHarness({
      async status() {
        return {
          transport: 'rest',
          reachable: false,
          checkedAt: '2026-01-01T00:00:00.000Z',
          details: { errorCode: 'UNAVAILABLE' },
        }
      },
    })
    const tool = createStatusTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({}, exec())) as { reachable: boolean; details: Record<string, unknown> }
    expect(value.reachable).toBe(false)
    expect(value.details.errorCode).toBe('UNAVAILABLE')
  })

  it('rejects unknown arguments', async () => {
    const harness = createHarness()
    const tool = createStatusTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ anything: 'ignored' }, exec())).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })
})
describe('memory_status settings discoverability', () => {
  it('prints the exact settings URL with a placeholder and never the token value', async () => {
    const harness = createHarness()
    const token = 'super-secret-token'
    const tool = createStatusTool({
      coordinator: harness.coordinator,
      config: harness.config,
      extraction: undefined,
      settings: {
        url: `https://dsh.nomad.opsc.io/plugins/cognee-memory/settings?token=<COGNEE_MEMORY_SETTINGS_TOKEN>`,
        tokenSet: true,
        tokenSource: 'COGNEE_MEMORY_SETTINGS_TOKEN in /etc/dsh/cognee.env (service environment)',
      },
    })
    const value = (await tool.execute({}, exec())) as { details: Record<string, unknown> }
    const rendered = tool.output.render({}, value)[0]?.text ?? ''
    expect(rendered).toContain(
      'settings page: https://dsh.nomad.opsc.io/plugins/cognee-memory/settings?token=<COGNEE_MEMORY_SETTINGS_TOKEN>',
    )
    expect(rendered).toContain('/etc/dsh/cognee.env')
    expect(rendered).not.toContain(token)
    expect(JSON.stringify(value)).not.toContain(token)
    expect(value.details.settings).toMatchObject({ tokenSet: true })
  })

  it('omits the settings lines when the plugin has no web-facing location', async () => {
    const harness = createHarness()
    const tool = createStatusTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({}, exec())) as { details: Record<string, unknown> }
    const rendered = tool.output.render({}, value)[0]?.text ?? ''
    expect(rendered).not.toContain('settings page:')
    expect(value.details.settings).toBeUndefined()
  })
})
