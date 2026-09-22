import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'
import { assertNativeComposerProof, assertNativeComposerSeed } from './fixtures/native-composer-proof.ts'
import { nativeComposerInspection, nativeComposerSeed } from './native-composer-fixture.ts'

const plan = JSON.parse(readFileSync(new URL('../release/cloga-windows-x64.json', import.meta.url), 'utf8')) as {
  desktopProvisioning: { plugins: { source: DesktopGithubReleasePluginSource }[] }
}
const source = plan.desktopProvisioning.plugins[0]!.source
const clientSha256 = '7b4566ef30e1c3c11e64aee527cea8bc5adbf0f22ca356cc8bd3ab07661fd368'
const identity = { evidenceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
  runId: '123', runAttempt: '2', planSha256: 'c'.repeat(64), runtimeSha256: 'd'.repeat(64), executableSha256: 'e'.repeat(64),
  provisioningSha256: 'f'.repeat(64), capabilitySha256: '0'.repeat(64) }
const seed = nativeComposerSeed()
const seedSha256 = createHash('sha256').update(JSON.stringify(seed)).digest('hex')
function proof(): Record<string, unknown> {
  return { ...identity, schemaVersion: 2, scope: 'actual-packaged-native-composer-and-released-client', seedSha256,
    sessionHistory: 'synthetic-persisted-in-isolated-home', quota: 'signed-out-host-response-no-credentials',
    pluginSource: source, installedClientSha256: clientSha256, ...nativeComposerInspection(),
    rendererErrors: [], realModelRound: false, realOAuth: false }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected test-owned record')
  return value as Record<string, unknown>
}
function firstGeometry(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value.geometry)) throw new Error('Expected test geometry array')
  return object(value.geometry[0])
}
const verify = (value: unknown): void => { assertNativeComposerProof(value, identity, source, seedSha256, clientSha256) }

describe('strict current native composer proof', () => {
  it('admits complete independently bound inert observations without modifying their bytes', () => {
    const value = proof()
    const before = JSON.stringify(value)
    expect(() => { assertNativeComposerSeed(seed); verify(value) }).not.toThrow()
    expect(JSON.stringify(value)).toBe(before)
  })
  it.each(Object.keys(proof()))('rejects missing native field %s', (field) => {
    const value = proof(); Reflect.deleteProperty(value, field)
    expect(() => { verify(value) }).toThrow()
  })
  it.each(Object.keys(identity))('rejects wrong own-run identity %s', (field) => {
    const value = proof(); value[field] = 'foreign'
    expect(() => { verify(value) }).toThrow()
  })
  it.each(['legacy-schema', 'extra-key', 'seed-hash', 'client-hash', 'source', 'model', 'oauth', 'error', 'scope'])(
    'rejects %s rather than treating native evidence as an ignored additive field', (damage) => {
      const value = proof()
      if (damage === 'legacy-schema') value.schemaVersion = 1
      else if (damage === 'extra-key') value.pickerVerified = true
      else if (damage === 'seed-hash') value.seedSha256 = '0'.repeat(64)
      else if (damage === 'client-hash') value.installedClientSha256 = '0'.repeat(64)
      else if (damage === 'source') value.pluginSource = { ...source, version: '0.4.0-alpha.33' }
      else if (damage === 'model') value.realModelRound = true
      else if (damage === 'oauth') value.realOAuth = true
      else if (damage === 'error') value.rendererErrors = ['actual renderer failure']
      else value.scope = 'synthetic-only'
      expect(() => { verify(value) }).toThrow()
    },
  )
  it.each([NaN, Infinity, -Infinity, '12', null, 16385])('rejects nonfinite/unbounded/untyped rectangle scalar %s', (number) => {
    const value = proof(); object(firstGeometry(value).time).x = number
    expect(() => { verify(value) }).toThrow()
  })
  it.each(['missing', 'third', 'reversed', 'viewport', 'box-extra', 'zero', 'overlap', 'overflow', 'typography', 'bad-pixels'])(
    'rejects native geometry %s', (damage) => {
      const value = proof()
      const geometry = firstGeometry(value)
      if (damage === 'missing') value.geometry = []
      else if (damage === 'third') value.geometry = [...nativeComposerInspection().geometry, geometry]
      else if (damage === 'reversed') value.geometry = [...nativeComposerInspection().geometry].reverse()
      else if (damage === 'viewport') geometry.viewportWidth = 900
      else if (damage === 'box-extra') object(geometry.dock).html = 'not a scalar rectangle'
      else if (damage === 'zero') object(geometry.time).width = 0
      else if (damage === 'overlap') object(geometry.copilot).x = 112
      else if (damage === 'overflow') object(geometry.copilot).x = 1279
      else if (damage === 'typography') object(geometry.copilotStyle).color = 'other'
      else object(geometry.nativeStyle).fontSize = 'Infinitypx'
      expect(() => { verify(value) }).toThrow()
    },
  )
  it.each(['time', 'usage'])('requires opened/Escape/focus observations for %s', (dialog) => {
    for (const flag of ['opened', 'closedOnEscape', 'focusReturned']) {
      const value = proof(); object(object(value.nativeDialogs)[dialog])[flag] = false
      expect(() => { verify(value) }).toThrow()
    }
  })
  it.each(['signedOutObserved', 'sessionCreditsCount', 'resetCount', 'epochTextCount', 'focusReturned'])(
    'rejects false/retired signed-out dialog %s', (field) => {
      const value = proof(); object(value.copilotDialog)[field] = field.endsWith('Count') ? 1 : false
      expect(() => { verify(value) }).toThrow()
    },
  )
  it.each(Object.keys(seed))('requires exact synthetic seeder field %s', (field) => {
    const absent: Record<string, unknown> = { ...seed }; Reflect.deleteProperty(absent, field)
    expect(() => { assertNativeComposerSeed(absent) }).toThrow()
    expect(() => { assertNativeComposerSeed({ ...seed, [field]: 'wrong' }) }).toThrow()
  })
  it('rejects unknown seed fields and does not require cross-run geometry or UUID equality', () => {
    expect(() => { assertNativeComposerSeed({ ...seed, liveModelVerified: true }) }).toThrow()
    const value = proof()
    const next = { ...identity, evidenceId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }
    value.evidenceId = next.evidenceId
    object(firstGeometry(value).dock).height = 42
    expect(() => { assertNativeComposerProof(value, next, source, seedSha256, clientSha256) }).not.toThrow()
    expect(() => { verify(value) }).toThrow()
  })
})
