/** Verify observer-failure cleanup against the real packaged Copilot acceptance fixture. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runPackagedCopilotAcceptance } from './copilot-release-smoke.ts'

const { values } = parseArgs({
  options: { application: { type: 'string' }, output: { type: 'string' } },
  allowPositionals: false,
})
assert(values.application && values.output, 'Packaged application and evidence directory are required')
const application = resolve(values.application)
const output = resolve(values.output)
mkdirSync(output, { recursive: true })
const marker = new Error('packaged observer cleanup canary')
const captures: Array<{ home: string; profile: string; legacySdk: string }> = []
await assert.rejects(runPackagedCopilotAcceptance({
  application,
  output,
  inspectProfile(paths) {
    assert.equal(captures.length, 0, 'Observer must run once')
    assert(Object.isFrozen(paths), 'Observer paths must be immutable')
    assert.deepEqual(Object.keys(paths).sort(), ['application', 'home', 'output', 'profile', 'runtimeRoot'])
    assert.equal(paths.application, application)
    assert.equal(paths.output, output)
    assert(existsSync(paths.profile), 'Real provisioned profile must exist during inspection')
    captures.push({
      home: paths.home,
      profile: paths.profile,
      legacySdk: realpathSync(join(paths.home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')),
    })
    throw marker
  },
}), error => error === marker)
const captured = captures[0]
assert(captured, 'Real acceptance must reach the observer')
assert(!existsSync(captured.home), 'Observer failure must remove its owned home')
assert(!existsSync(captured.profile), 'Observer failure must remove its owned profile')
assert(!existsSync(captured.legacySdk), 'Observer failure must remove its owned ancestor canary')
assert(!existsSync(join(output, 'acceptance.json')), 'Observer failure must not publish successful acceptance')
const failure: unknown = JSON.parse(readFileSync(join(output, 'failure.json'), 'utf8'))
assert(typeof failure === 'object' && failure !== null && 'error' in failure
  && typeof failure.error === 'string' && failure.error.includes(marker.message), 'Failure evidence must name the canary')
writeFileSync(join(output, 'observer-cleanup.json'), JSON.stringify({
  schemaVersion: 1,
  observerInvokedOnce: true,
  ownedHomeRemoved: true,
  ownedLegacySdkRemoved: true,
  successReceiptWithheld: true,
  realOAuth: false,
  realModelRound: false,
}, undefined, 2) + '\n', { flag: 'wx' })
console.log('Packaged observer cleanup canary passed')
