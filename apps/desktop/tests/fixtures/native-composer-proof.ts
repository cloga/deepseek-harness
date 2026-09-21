/** Strict current native-composer proof shared by its producer and the read-only qualification consumer. */
import assert from 'node:assert/strict'
import { assertReviewedCopilotUsageClient } from '../../scripts/copilot-usage-client-policy.ts'
import type { DesktopGithubReleasePluginSource } from '../../src/plugin-source.ts'
import type { PackagedProofIdentity } from './copilot-observer-smoke.ts'
import { assertNativeComposerGeometry, type NativeComposerGeometry } from './native-composer-geometry.ts'

const identityFields = ['evidenceId', 'sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'planSha256', 'runtimeSha256',
  'executableSha256', 'provisioningSha256', 'capabilitySha256'] as const
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected native composer evidence object')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'Native composer evidence fields differ')
}
function yes(value: Record<string, unknown>, fields: readonly string[]): void {
  exact(value, fields)
  for (const field of fields) assert.equal(value[field], true, `Native composer observation required: ${field}`)
}

/** Require the original six-field synthetic seeder contract; this is not live model or account evidence. */
export function assertNativeComposerSeed(value: unknown): void {
  const seed = record(value)
  exact(seed, ['sessionId', 'scope', 'workspaceRegistered', 'provider', 'seederModelCalls', 'liveAccountQuota'])
  assert.equal(seed.sessionId, 'desktop-inline-composer-synthetic')
  assert.equal(seed.scope, 'test-owned-persisted-session-with-synthetic-history-and-token-counts')
  assert.equal(seed.workspaceRegistered, true)
  assert.equal(seed.provider, 'github-copilot')
  assert.equal(seed.seederModelCalls, 0)
  assert.equal(seed.liveAccountQuota, false)
}

/** Validate strict schema-2 native observations against this run's owned identity and original seeder bytes. */
export function assertNativeComposerProof(
  value: unknown,
  identity: PackagedProofIdentity,
  source: DesktopGithubReleasePluginSource,
  seedSha256: string,
  installedClientSha256: string,
): void {
  const proof = record(value)
  exact(proof, ['schemaVersion', 'scope', ...identityFields, 'seedSha256', 'sessionHistory', 'quota', 'pluginSource',
    'installedClientSha256', 'geometry', 'nativeDialogs', 'copilotDialog', 'rendererErrors', 'realModelRound', 'realOAuth'])
  assert.equal(proof.schemaVersion, 2)
  assert.equal(proof.scope, 'actual-packaged-native-composer-and-released-client')
  for (const field of identityFields) assert.equal(proof[field], identity[field], `Native composer identity differs: ${field}`)
  assert.match(identity.evidenceId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
  for (const field of ['sourceCommit', 'sourceTree'] as const) assert.match(identity[field], /^[a-f0-9]{40}$/u)
  for (const field of ['planSha256', 'runtimeSha256', 'executableSha256', 'provisioningSha256', 'capabilitySha256'] as const) {
    assert.match(identity[field], /^[a-f0-9]{64}$/u)
  }
  for (const field of ['runId', 'runAttempt'] as const) {
    assert(identity[field] === null || typeof identity[field] === 'string' && /^\d+$/u.test(identity[field]))
  }
  assert.match(seedSha256, /^[a-f0-9]{64}$/u)
  assert.equal(proof.seedSha256, seedSha256)
  assert.deepEqual(proof.pluginSource, source)
  assert.equal(proof.installedClientSha256, installedClientSha256)
  assertReviewedCopilotUsageClient(source, installedClientSha256)
  assert.equal(proof.sessionHistory, 'synthetic-persisted-in-isolated-home')
  assert.equal(proof.quota, 'signed-out-host-response-no-credentials')
  assert.equal(proof.realModelRound, false)
  assert.equal(proof.realOAuth, false)
  assert.deepEqual(proof.rendererErrors, [])
  assert(Array.isArray(proof.geometry) && proof.geometry.length === 2)
  for (const [index, value] of proof.geometry.entries()) {
    const geometry = record(value)
    exact(geometry, ['viewportWidth', 'dock', 'time', 'usage', 'copilot', 'nativeStyle', 'copilotStyle'])
    assert.equal(geometry.viewportWidth, index === 0 ? 1280 : 400)
    for (const name of ['dock', 'time', 'usage', 'copilot']) {
      const box = record(geometry[name])
      exact(box, ['x', 'y', 'width', 'height'])
      for (const [field, number] of Object.entries(box)) {
        assert(typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 16384, 'Invalid measured rectangle')
        if (field === 'width' || field === 'height') assert(number > 0)
      }
    }
    for (const name of ['nativeStyle', 'copilotStyle']) {
      const style = record(geometry[name])
      exact(style, ['fontSize', 'lineHeight', 'color'])
      for (const text of Object.values(style)) assert(typeof text === 'string' && text.length > 0 && text.length <= 128)
      for (const field of ['fontSize', 'lineHeight']) {
        assert(typeof style[field] === 'string' && /^(?:\d+(?:\.\d+)?)px$/u.test(style[field]))
        const pixels = Number.parseFloat(style[field])
        assert(pixels > 0 && pixels <= 256)
      }
    }
    // Shape and finite scalar checks above precede the shared physical-geometry assertions.
    assertNativeComposerGeometry(geometry as unknown as NativeComposerGeometry, index === 0)
  }
  const dialogs = record(proof.nativeDialogs)
  exact(dialogs, ['time', 'usage'])
  for (const name of ['time', 'usage']) yes(record(dialogs[name]), ['opened', 'closedOnEscape', 'focusReturned'])
  const copilot = record(proof.copilotDialog)
  exact(copilot, ['signedOutObserved', 'sessionCreditsCount', 'resetCount', 'epochTextCount', 'focusReturned'])
  assert.equal(copilot.signedOutObserved, true)
  assert.equal(copilot.focusReturned, true)
  for (const field of ['sessionCreditsCount', 'resetCount', 'epochTextCount']) assert.equal(copilot[field], 0)
}
