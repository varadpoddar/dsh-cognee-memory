#!/usr/bin/env node
/**
 * Milestone 11 — F: recall after the Cognee container is restarted.
 *
 * Runs from an operator machine that can reach the Proxmox host and the Cognee
 * origin. It restarts only the Cognee container on CT 106 (non-destructive: the
 * data volume is kept), waits for `/health`, then asks the harness — in a fresh
 * process on CT 103 — for a memory written before the restart.
 *
 *   DSH_SSH_KEY=~/.ssh/dsh DSH_CONTROL=root@control.nomad.opsc.io \
 *   DSH_CT=103 DSH_COGNEE=http://10.20.10.15:8000 \
 *   node tests/eval/check-backend-restart.mjs --run-id <id> --out <json>
 *
 * No secret is read or printed: the harness wrapper sources /etc/dsh/*.env inside
 * CT 103, and the container restart needs no credentials.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const RUN_ID = flag('run-id', 'm11-unknown')
const OUT = flag('out', `/tmp/m11-eval/report-backend-restart-${RUN_ID}.json`)
const KEY = (process.env.DSH_SSH_KEY ?? path.join(os.homedir(), '.ssh', 'dsh')).replace(/^~/, os.homedir())
const CONTROL = process.env.DSH_CONTROL ?? 'root@control.nomad.opsc.io'
const CT = process.env.DSH_CT ?? '103'
const ORIGIN = process.env.DSH_COGNEE ?? 'http://10.20.10.15:8000'
const QUESTION = 'What is the amber launch code? Reply with the code only.'
const EXPECTED = `eval-amber-${RUN_ID}-0`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ssh = (host, command, timeout = 240_000) =>
  execFileSync('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '-i', KEY, host, command], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })

function askHarness() {
  const promptFile = '/tmp/m11-backend-restart-prompt.txt'
  const inner =
    'printf %s ' + JSON.stringify(QUESTION) + ` > ${promptFile}; chmod 644 ${promptFile}; ` +
    'su dsh -s /bin/bash -c "set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a; ' +
    `DSH_HOME=/var/lib/deepseek-harness/.dsh timeout 150 dsh --profile headless --patch /tmp/m11-eval/patch-tools-off.yml headless --json \\"$(cat ${promptFile})\\""`
  const started = Date.now()
  try {
    const out = ssh(CONTROL, `pct exec ${CT} -- bash -lc ${JSON.stringify(inner)}`, 200_000)
    return { ms: Date.now() - started, out, ok: true }
  } catch (error) {
    return { ms: Date.now() - started, out: `${error.stdout ?? ''}\n${error.stderr ?? ''}`, ok: false }
  }
}

async function health() {
  try {
    const response = await fetch(`${ORIGIN}/health`)
    return { status: response.status, body: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 0, error: String(error).slice(0, 120) }
  }
}

const tail = (out, lines = 12) => out.split('\n').filter((line) => line.trim() !== '').slice(-lines).join('\n')

const report = { runId: RUN_ID, generatedAt: new Date().toISOString(), scenarios: [], notes: [] }
let restart = 'not-attempted'
let wait = null
let run = { ok: false, out: '', ms: 0 }
try {
  const before = await health()
  restart = ssh(CONTROL, `pct exec 106 -- docker restart cognee`, 120_000).trim()
  const started = Date.now()
  let current = await health()
  while (Date.now() - started < 180_000 && current.status !== 200) {
    await sleep(2_000)
    current = await health()
  }
  wait = { ms: Date.now() - started, status: current.status, body: current.body }
  run = askHarness()
  const events = run.out.split('\n').map((line) => { try { return JSON.parse(line) } catch { return null } })
  const finalEvent = events.find((event) => event?.type === 'final')
  const answer = typeof finalEvent?.text === 'string' ? finalEvent.text : tail(run.out)
  const toolEvents = events.filter((event) => event?.type === 'tool_call').length
  report.scenarios.push({
    id: 'F',
    title: 'Recall after docker restart cognee (CT 106)',
    status: restart === 'cognee' && current.status === 200 && run.ok && answer.includes(EXPECTED) ? 'PASS' : 'FAIL',
    summary:
      `container restarted (${restart}); /health back in ${wait.ms} ms; a fresh harness process ` +
      `${answer.includes(EXPECTED) ? 'recalled' : 'did NOT recall'} the pre-restart codeword.`,
    evidence:
      `before /health: ${JSON.stringify(before)}\n` +
      `docker restart output: ${restart}\n` +
      `after /health: ${JSON.stringify(wait.body)}\n` +
      `tool_events: ${toolEvents}\n` +
      `recall final:\n${answer.slice(0, 700)}`,
    commands: [
      'pct exec 106 -- docker restart cognee',
      `dsh headless "What is the amber launch code? …"  (CT ${CT})`,
    ],
  })
} catch (error) {
  report.scenarios.push({
    id: 'F',
    title: 'Recall after docker restart cognee (CT 106)',
    status: 'BLOCKED',
    summary: 'the container restart probe could not complete.',
    evidence: String(error).slice(0, 600),
  })
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ done: true, out: OUT, status: report.scenarios[0]?.status }))
