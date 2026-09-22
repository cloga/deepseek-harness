/** One-shot CI-only acquisition diagnostic; downloaded plugin code is never loaded or installed. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { acquireDesktopPluginArtifact, parseDesktopPluginSource } from '../src/plugin-source.ts'
import { desktopSmokeEnvironment } from './smoke-environment.ts'
import { observePluginAcquisition } from './plugin-acquisition-observer.ts'

/** Reviewed checkout and raw plan identity; no caller-supplied URL or credential is accepted. */
export interface AcquisitionDiagnosticOptions {
  readonly sourceCommit: string
  readonly planSha256: string
  readonly plan: string
  readonly scratch: string
  readonly output: string
}

/**
 * Acquire the exact reviewed alpha35 source once using unchanged product validation, then remove owned bytes.
 * @param options - Source-bound plan and diagnostic-owned paths.
 * @param fetcher - Original anonymous transport, replaceable only for offline tests.
 * @returns Safe report, also written on acquisition/cleanup failure before rejecting.
 */
export async function diagnosePluginAcquisition(options: AcquisitionDiagnosticOptions, fetcher: typeof fetch = fetch): Promise<object> {
  assert.match(options.sourceCommit, /^[a-f0-9]{40}$/u)
  assert.match(options.planSha256, /^[a-f0-9]{64}$/u)
  const planBytes = readFileSync(options.plan)
  assert.equal(createHash('sha256').update(planBytes).digest('hex'), options.planSha256, 'Reviewed raw plan hash mismatch')
  const plan: unknown = JSON.parse(planBytes.toString('utf8'))
  assert(typeof plan === 'object' && plan !== null)
  const provisioning: unknown = Reflect.get(plan, 'desktopProvisioning')
  assert(typeof provisioning === 'object' && provisioning !== null)
  const plugins: unknown = Reflect.get(provisioning, 'plugins')
  assert(Array.isArray(plugins) && plugins.length === 1, 'One exact release-owned plugin is required')
  const entry: unknown = plugins[0]
  assert(typeof entry === 'object' && entry !== null && Reflect.get(entry, 'required') === true)
  const source = parseDesktopPluginSource(Reflect.get(entry, 'source'))
  assert(source.type === 'githubRelease' && source.checksumManifest !== undefined)
  assert.equal(source.owner, 'cloga')
  assert.equal(source.repo, 'dsh-github-copilot')
  assert.equal(source.packageName, 'dsh-github-copilot')
  assert.equal(source.version, '0.4.0-alpha.35')
  assert.equal(source.tag, 'v0.4.0-alpha.35')
  const observer = observePluginAcquisition({
    owner: source.owner, repo: source.repo, tag: source.tag,
    assetId: source.assetId, checksumAssetId: source.checksumManifest.assetId,
  }, fetcher)
  mkdirSync(options.scratch, { recursive: true })
  const owned = mkdtempSync(join(options.scratch, 'plugin-acquisition-'))
  let outcome: 'verified' | 'failed' = 'failed'
  let cleanup: 'removed' | 'failed' = 'failed'
  let releaseId: number | undefined
  try {
    const verified = await acquireDesktopPluginArtifact(source, owned, observer.fetch)
    releaseId = verified.releaseId
    outcome = 'verified'
  } catch {
    // Acquisition can contain arbitrary remote/parser text. Its failure is
    // retained as a verdict; only the allowlisted observer facts cross into JSON.
    outcome = 'failed'
  } finally {
    try {
      rmSync(owned, { recursive: true, force: true })
      cleanup = 'removed'
    } catch {
      // Cleanup failure remains a failing result without leaking an arbitrary filesystem error.
      cleanup = 'failed'
    }
  }
  const report = {
    schemaVersion: 1,
    scope: 'source-acquisition-same-policy-not-packaged-electron-carrier',
    sourceCommit: options.sourceCommit, planSha256: options.planSha256,
    runtime: { platform: process.platform, node: process.versions.node },
    package: { name: source.packageName, version: source.version, assetId: source.assetId,
      checksumAssetId: source.checksumManifest.assetId, sourceCommit: source.targetCommit, sha256: source.sha256 },
    attemptCount: 1, outcome, cleanup, observerRejection: observer.rejection,
    ...(releaseId === undefined ? {} : { releaseId }),
    requests: observer.observations,
    installed: false, executedPlugin: false,
  }
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, JSON.stringify(report, undefined, 2) + '\n', { flag: 'wx' })
  if (outcome !== 'verified' || cleanup !== 'removed') throw new Error('Anonymous acquisition diagnostic failed; inspect sanitized report')
  return report
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'source-sha': { type: 'string' }, 'plan-sha256': { type: 'string' },
    plan: { type: 'string' }, scratch: { type: 'string' }, output: { type: 'string' }, collect: { type: 'boolean' },
  } })
  assert(values['source-sha'] && values['plan-sha256'] && values.plan && values.scratch && values.output)
  const options = { sourceCommit: values['source-sha'], planSha256: values['plan-sha256'],
    plan: resolve(values.plan), scratch: resolve(values.scratch), output: resolve(values.output) }
  if (values.collect) {
    const forbidden = Object.keys(process.env).some(name => /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NODE_OPTIONS/iu.test(name))
    assert(!forbidden, 'Collector environment must omit ambient credential and loader overrides')
    await diagnosePluginAcquisition(options)
    return
  }
  mkdirSync(options.scratch, { recursive: true })
  const home = mkdtempSync(join(options.scratch, 'diagnostic-home-'))
  try {
    const result = spawnSync(process.execPath, [
      '--import', 'tsx/esm', fileURLToPath(import.meta.url), '--collect',
      '--source-sha', options.sourceCommit, '--plan-sha256', options.planSha256,
      '--plan', options.plan, '--scratch', options.scratch, '--output', options.output,
    ], { cwd: process.cwd(), env: { ...desktopSmokeEnvironment(home), DSH_TELEMETRY_DISABLED: '1' }, stdio: 'inherit', windowsHide: true })
    assert(result.error === undefined && result.signal === null && result.status === 0, 'Collector did not complete successfully')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try { await main() } catch {
    console.error('Desktop anonymous acquisition diagnostic failed; inspect available sanitized report')
    process.exitCode = 1
  }
}
