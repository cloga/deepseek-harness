/**
 * Check declared workflow publication authority, not arbitrary shell/script behavior.
 * The fork's delivery rule lives in .github/AGENTS.md; Desktop validates actual assets.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'

const forkExcluded = "github.repository != 'cloga/deepseek-harness'"
const publishers = new Map([
  ['release-publish.yml/publish', forkExcluded],
  ['release-vendor-publish.yml/publish', forkExcluded],
  ['node-addon-system-release.yml/publish', `${forkExcluded} && inputs.publish`],
  ['python-release.yml/publish-runtime', `${forkExcluded} && github.event_name == 'workflow_dispatch' && inputs.publish`],
  ['python-release.yml/publish-sdk', `${forkExcluded} && github.event_name == 'workflow_dispatch' && inputs.publish`],
])
const desktop = 'desktop-fork-release.yml/release'
const desktopPublishCommand = 'node apps/desktop/scripts/publish-fork-release.mjs release-assets'
const desktopPublishRuns = new Set([
  desktopPublishCommand,
  [
    "$ErrorActionPreference = 'Stop'",
    '$head = git rev-parse HEAD',
    'if ($LASTEXITCODE -ne 0 -or $head -cne $env:SOURCE_SHA)'
      + " { throw 'Publisher checkout differs from the reviewed build source' }",
    desktopPublishCommand,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n'),
])

// Admit only reviewed complete scripts; normalize line endings, never shell statements or comments.
function isApprovedDesktopRun(run: unknown): boolean {
  return typeof run === 'string' && desktopPublishRuns.has(run.replaceAll('\r\n', '\n').replace(/\n+$/u, ''))
}
const rehearsals = new Map([
  ['release.yml', ['dependencies', 'pack']],
  ['release-vendor.yml', ['pack']],
])

function object(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: expected a mapping`)
  return value as Record<string, unknown>
}

function permissions(value: unknown, label: string): Record<string, unknown> {
  if (value === 'read-all') return {}
  const result = object(value, `${label} permissions (explicit read-only default required; write-all is forbidden)`)
  for (const permission of Object.values(result)) {
    assert(['read', 'write', 'none'].includes(String(permission)), `${label}: unsupported permission expression`)
  }
  return result
}

/** Keep both reviewed run forms bound to the same single publisher and build checkout. */
function verifyDesktopPublisher(rawSteps: unknown[], key: string): void {
  const steps = rawSteps.map(step => object(step, `${key} step`))
  const approved = steps.filter(step => step.uses === undefined && isApprovedDesktopRun(step.run))
  assert.equal(approved.length, 1, `${key}: exactly one checked Desktop publisher required`)
  const publisher = object(approved[0], `${key} publisher`)
  assert.equal(publisher.id, 'publish', `${key}: publisher output identity differs`)
  assert.equal(publisher.shell, 'pwsh', `${key}: publisher must use pwsh`)
  assert.deepEqual(publisher.env, {
    GH_TOKEN: '${{ github.token }}',
    RELEASE_TAG: '${{ needs.build.outputs.tag }}',
    RELEASE_VERSION: '${{ needs.build.outputs.version }}',
    SOURCE_SHA: '${{ needs.build.outputs.source_sha }}',
  }, `${key}: publisher credentials and release identity must come from the reviewed build`)
  const checkouts = steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 1, `${key}: exactly one build checkout required`)
  const checkout = object(checkouts[0], `${key} checkout`)
  assert.equal(checkout.uses, 'actions/checkout@v6', `${key}: unreviewed checkout action`)
  assert.deepEqual(checkout.with, {
    ref: '${{ needs.build.outputs.source_sha }}', 'persist-credentials': false, clean: true,
  }, `${key}: checkout must bind the exact reviewed build source`)
  assert(steps.indexOf(checkout) < steps.indexOf(publisher), `${key}: checkout must precede publication`)
  for (const step of [checkout, publisher]) {
    for (const field of ['if', 'continue-on-error', 'working-directory']) {
      assert(step[field] === undefined, `${key}: checkout/publisher must not override ${field}`)
    }
  }
}

/** Read every Actions workflow, including .yaml additions, without consulting Git or remote state.
 * @param root - checkout containing .github/workflows.
 * @returns workflow basenames and YAML source.
 */
export function readReleaseWorkflows(root: string): Map<string, string> {
  const directory = resolve(root, '.github/workflows')
  return new Map(readdirSync(directory).filter(name => /\.ya?ml$/u.test(name)).sort()
    .map(name => [name, readFileSync(resolve(directory, name), 'utf8')]))
}

/** Reject unreviewed publication permissions and changes to the fork's known release entries.
 * @param sources - complete workflow directory, keyed by basename; titles are not identities.
 * @returns number of checked workflows; throws with the workflow/job and violated policy.
 */
export function verifyReleasePolicy(sources: ReadonlyMap<string, string>): number {
  const required = new Set([...rehearsals.keys(), 'desktop-fork-release.yml',
    ...[...publishers.keys()].map(key => key.slice(0, key.indexOf('/')))])
  for (const file of required) assert(sources.has(file), `Missing release policy workflow: ${file}`)
  const seenPublishers = new Set<string>()
  for (const [file, source] of sources) {
    const workflow = object(load(source, { schema: JSON_SCHEMA }), file)
    const defaults = permissions(workflow.permissions, file)
    for (const permission of ['contents', 'packages', 'id-token']) {
      assert(defaults[permission] !== 'write', `${file}: ${permission} write must not be a workflow default`)
    }
    const jobs = object(workflow.jobs, `${file} jobs`)
    assert(Object.keys(jobs).length > 0, `${file}: empty jobs`)
    const rehearsal = rehearsals.get(file)
    if (rehearsal) {
      assert.deepEqual(Object.keys(jobs).sort(), [...rehearsal].sort(), `${file}: CI pack jobs only`)
      assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ['master'] }, workflow_dispatch: null }, `${file}: CI pack events only`)
      assert(!/secrets\s*[.[]/u.test(JSON.stringify(workflow)), `${file}: CI pack must not consume secrets`)
    }
    for (const [id, raw] of Object.entries(jobs)) {
      const key = `${file}/${id}`
      const job = object(raw, key)
      const effective = job.permissions === undefined ? defaults : permissions(job.permissions, key)
      assert(effective.contents !== 'write' || key === desktop, `${key}: only Desktop may request contents write`)
      assert(effective.packages !== 'write', `${key}: no GitHub Packages publisher is authorized`)
      assert(effective['id-token'] !== 'write' || publishers.has(key) || key === 'docs-pages.yml/deploy', `${key}: unreviewed OIDC writer`)
      const expected = publishers.get(key)
      if (expected !== undefined) {
        assert.equal(job.if, expected, `${key}: require the fixed fork exclusion, without input/variable overrides`)
        seenPublishers.add(key)
      }
      const steps = job.steps === undefined ? [] : job.steps
      assert(Array.isArray(steps), `${key}: steps must be a sequence`)
      for (const rawStep of steps) {
        const step = object(rawStep, `${key} step`)
        // Recognized entry points supplement permissions; this is not shell interpretation.
        const command = typeof step.run === 'string' ? step.run : ''
        const action = typeof step.uses === 'string' ? step.uses : ''
        const writes = /\b(?:gh\s+release\s+(?:create|upload|edit|delete)|(?:npm|pnpm)\s+publish|twine\s+upload)\b/u.test(command)
          || /\b(?:release:publish|publish-(?:fork-)?release\.mjs)\b/u.test(command)
          || /^(?:softprops\/action-gh-release|ncipollo\/release-action|pypa\/gh-action-pypi-publish|JS-DevTools\/npm-publish)@/iu
            .test(action)
        const desktopPublisher = key === desktop && step.uses === undefined && isApprovedDesktopRun(step.run)
        assert(!writes || desktopPublisher || publishers.has(key), `${key}: unreviewed publication entry point`)
      }
      if (rehearsal) {
        assert(job.uses === undefined && job.secrets === undefined, `${key}: CI pack must not delegate publication`)
        assert(!Object.values(effective).includes('write'), `${key}: CI pack permissions must be read-only`)
        if (id === 'pack') {
          assert(steps.some((rawStep) => {
            const step = object(rawStep, key)
            return step.uses === 'actions/upload-artifact@v4'
              && object(step.with, `${key} artifact`).path === (file === 'release.yml' ? 'dist/npm/*' : 'dist/npm-vendor/*')
          }), `${key}: retain tarballs as CI artifacts`)
        }
      }
      if (key === desktop) {
        assert.equal(effective.contents, 'write', `${key}: retain Desktop publication`)
        assert.equal(job.environment, 'desktop-fork-release', `${key}: protected environment required`)
        assert.equal(job.needs, 'build', `${key}: verified build required`)
        assert.equal(job.if,
          "${{ github.event_name == 'workflow_dispatch' && !inputs.rehearsal && github.ref == 'refs/heads/master' }}",
          `${key}: rehearsal or non-dispatch event cannot publish`)
        verifyDesktopPublisher(steps, key)
      }
    }
    if (file === 'desktop-fork-release.yml') assert('release' in jobs, `${file}: Desktop release job required`)
  }
  assert.deepEqual([...seenPublishers].sort(), [...publishers.keys()].sort(), 'Known upstream publication jobs must remain explicitly guarded')
  return sources.size
}

if (import.meta.main) {
  const count = verifyReleasePolicy(readReleaseWorkflows(resolve(import.meta.dirname, '..')))
  console.log(`Release policy: ${count} workflows checked; fork publication is Desktop-only.`)
}
