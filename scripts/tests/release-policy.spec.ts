/** Workflow mutations exercise the same parsed-source check that CI executes. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { dump, load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { gatesForMode } from '../run-gates.ts'
import { readReleaseWorkflows, verifyReleasePolicy } from '../verify-release-policy.ts'

const root = resolve(import.meta.dirname, '../..')
interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  id?: string
  shell?: string
  [key: string]: unknown
}
interface Job { if?: string; permissions?: unknown; uses?: string; secrets?: unknown; steps?: Step[]; [key: string]: unknown }
interface Workflow { name?: string; on?: unknown; permissions?: unknown; jobs: Record<string, Job> }
function mutate(file: string, edit: (workflow: Workflow) => void): Map<string, string> {
  const sources = readReleaseWorkflows(root)
  const workflow = load(sources.get(file)!) as Workflow
  edit(workflow)
  sources.set(file, dump(workflow))
  return sources
}
const legacyPublisherRun = 'node apps/desktop/scripts/publish-fork-release.mjs release-assets'
// The source-checked producer uses YAML `|`, including its final newline.
const sourceCheckedPublisherRun = [
  "$ErrorActionPreference = 'Stop'",
  '$head = git rev-parse HEAD',
  'if ($LASTEXITCODE -ne 0 -or $head -cne $env:SOURCE_SHA)'
    + " { throw 'Publisher checkout differs from the reviewed build source' }",
  'node apps/desktop/scripts/publish-fork-release.mjs release-assets',
  'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  '',
].join('\n')
const publisherForms = [['legacy', legacyPublisherRun], ['source-checked', sourceCheckedPublisherRun]] as const
function mutatePublisher(run: string, change?: (step: Step, job: Job) => void): Map<string, string> {
  return mutate('desktop-fork-release.yml', (workflow) => {
    const job = workflow.jobs.release!
    const step = job.steps!.find(candidate => candidate.id === 'publish')
    if (step === undefined) throw new Error('Publisher fixture is missing')
    step.run = run
    change?.(step, job)
  })
}
const writer = { 'runs-on': 'ubuntu-latest', permissions: { contents: 'write' }, steps: [{ run: 'node scripts/core-release.mjs' }] }
const upstreamJobs = [
  ['release-publish.yml', 'publish'], ['release-vendor-publish.yml', 'publish'],
  ['node-addon-system-release.yml', 'publish'], ['python-release.yml', 'publish-runtime'], ['python-release.yml', 'publish-sdk'],
] as const

describe('fork Desktop publication policy', () => {
  it('reads both workflow extensions without treating non-workflow files as Actions', ({ onTestFinished }) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'release-policy-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const workflows = resolve(directory, '.github/workflows')
    mkdirSync(workflows, { recursive: true })
    for (const file of ['first.yml', 'second.yaml', 'README.md', 'backup.yml.bak']) writeFileSync(resolve(workflows, file), file)
    expect([...readReleaseWorkflows(directory)]).toEqual([['first.yml', 'first.yml'], ['second.yaml', 'second.yaml']])
  })

  it('accepts current source, including pack artifacts, upstream publishers and Pages OIDC', () => {
    expect(() => verifyReleasePolicy(readReleaseWorkflows(root))).not.toThrow()
  })

  it('runs as a blocking leaf of the static CI job', ({ onTestFinished }) => {
    vi.stubEnv('npm_execpath', resolve(root, 'node_modules/pnpm/bin/pnpm.cjs'))
    onTestFinished(() => { vi.unstubAllEnvs() })
    const leaf = gatesForMode('ci-static').find(gate => gate.id === 'release-policy')
    expect(leaf).toMatchObject({ displayCommand: 'pnpm run verify-release-policy' })
    expect(leaf?.allowFailure).not.toBe(true)
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['verify-release-policy']).toBe('tsx scripts/verify-release-policy.ts')
    const ci = load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow
    expect(Object.values(ci.jobs).some(job => job.steps?.some(step => step.run === 'pnpm run check:ci:static'))).toBe(true)
  })

  it('rejects the alpha5 failure mode: a public Core/Web writer added to the CI pack workflow', () => {
    const sources = mutate('release.yml', (workflow) => {
      workflow.jobs['github-release'] = { ...writer, steps: [{ run: 'gh release create dsh-v0.1.6-alpha.5 dist/npm/*.tgz --title "Core/Web"' }] }
    })
    expect(() => verifyReleasePolicy(sources)).toThrow('CI pack jobs only')
  })

  it.each(['innocent.yaml', 'desktop-copy.yml'])('discovers an independent contents-write job regardless of filename/title: %s', (file) => {
    const sources = readReleaseWorkflows(root)
    sources.set(file, dump({ name: 'Desktop installer', permissions: { contents: 'read' }, jobs: { upload: writer } }))
    expect(() => verifyReleasePolicy(sources)).toThrow('only Desktop may request contents write')
  })

  it.each(['contents', 'packages', 'id-token'])('rejects inherited workflow-level %s write', (permission) => {
    const sources = mutate('ci.yml', (workflow) => { workflow.permissions = { [permission]: 'write' } })
    expect(() => verifyReleasePolicy(sources)).toThrow('write must not be a workflow default')
  })

  it.each(['write-all', '${{ inputs.permissions }}', undefined])('requires explicit restricted workflow permissions: %s', (permissions) => {
    expect(() => verifyReleasePolicy(mutate('ci.yml', (workflow) => { workflow.permissions = permissions }))).toThrow('explicit read-only default required')
  })

  it('rejects dynamic permission values rather than assuming they are read-only', () => {
    expect(() => verifyReleasePolicy(mutate('ci.yml', (workflow) => {
      workflow.permissions = { contents: '${{ inputs.permission }}' }
    }))).toThrow('unsupported permission expression')
  })

  it('rejects job-level write-all rather than treating it as a map', () => {
    expect(() => verifyReleasePolicy(mutate('release.yml', (workflow) => { workflow.jobs.pack!.permissions = 'write-all' }))).toThrow('write-all is forbidden')
  })

  it.each(['packages', 'id-token'])('rejects new job-level %s authority', (permission) => {
    expect(() => verifyReleasePolicy(mutate('ci.yml', (workflow) => {
      workflow.jobs.unreviewed = { permissions: { [permission]: 'write' }, steps: [] }
    }))).toThrow(permission === 'packages' ? 'no GitHub Packages publisher' : 'unreviewed OIDC writer')
  })

  it.each([
    { uses: 'softprops/action-gh-release@v2' },
    { uses: 'pypa/gh-action-pypi-publish@release/v1' },
    { run: 'pnpm run release:publish --family dsh --from dist/npm' },
    { run: 'npm publish package.tgz' },
    { run: 'gh release upload some-tag dist/npm/*.tgz' },
  ])('rejects recognized publication steps even under read-only token permissions: %j', (step) => {
    expect(() => verifyReleasePolicy(mutate('release.yml', (workflow) => { workflow.jobs.pack!.steps!.push(step) }))).toThrow('unreviewed publication entry point')
  })

  it('does not let the Desktop job authorize a second recognized publisher', () => {
    expect(() => verifyReleasePolicy(mutate('desktop-fork-release.yml', (workflow) => {
      workflow.jobs.release!.steps!.push({ run: 'gh release create raw-core dist/npm/*.tgz' })
    }))).toThrow('unreviewed publication entry point')
  })

  describe.each(publisherForms)('%s Desktop publisher', (_name, run) => {
    it.each(['authored', 'CRLF', 'trailing newlines'])('accepts only the reviewed full run with %s line endings', (format) => {
      const script = format === 'CRLF' ? run.replaceAll('\n', '\r\n') + '\r\n' : format === 'trailing newlines' ? run + '\n\n' : run
      expect(() => verifyReleasePolicy(mutatePublisher(script))).not.toThrow()
    })

    it.each([
      ['second node', (script: string) => script + '\n' + legacyPublisherRun],
      ['second gh writer', (script: string) => script + '\ngh release create raw dist/npm/*.tgz'],
      ['second npm writer', (script: string) => script + '\nnpm publish package.tgz'],
      ['prepended statement', (script: string) => 'Write-Output unreviewed\n' + script],
      ['unknown wrapper', (script: string) => 'if ($true) {\n' + script + '\n}'],
      ['comment suffix', (script: string) => script + '\n# unreviewed wrapper'],
      ['different assets', (script: string) => script.replace(' release-assets', ' dist/npm')],
      ['leading newline', (script: string) => '\n' + script],
      ['horizontal whitespace', (script: string) => script + ' '],
    ] as const)('rejects an altered command block: %s', (_case, alter) => {
      expect(() => verifyReleasePolicy(mutatePublisher(alter(run)))).toThrow('unreviewed publication entry point')
    })

    it.each([legacyPublisherRun, sourceCheckedPublisherRun, 'gh release upload raw dist/npm/*.tgz'])('rejects a second publisher step: %s', (second) => {
      expect(() => verifyReleasePolicy(mutatePublisher(run, (step, job) => {
        job.steps!.push({ ...step, run: second })
      }))).toThrow(/exactly one checked Desktop publisher|unreviewed publication entry point/u)
    })

    it.each(['GH_TOKEN', 'RELEASE_TAG', 'RELEASE_VERSION', 'SOURCE_SHA'])('rejects changed or missing %s binding', (field) => {
      for (const absent of [false, true]) {
        expect(() => verifyReleasePolicy(mutatePublisher(run, (step) => {
          if (absent) Reflect.deleteProperty(step.env!, field)
          else step.env![field] = '${{ inputs.unreviewed }}'
        }))).toThrow('publisher credentials and release identity')
      }
    })

    it.each(['extra env', 'shell', 'missing shell', 'id', 'if', 'continue-on-error', 'working-directory', 'action'])(
      'rejects publisher invocation changes: %s', (field) => {
        expect(() => verifyReleasePolicy(mutatePublisher(run, (step) => {
          if (field === 'extra env') step.env!.PATH = 'unreviewed'
          else if (field === 'missing shell') delete step.shell
          else if (field === 'action') step.uses = 'actions/github-script@v7'
          else if (field === 'continue-on-error') step[field] = true
          else if (field === 'if') step[field] = '${{ always() }}'
          else step[field] = field === 'shell' ? 'bash' : 'other'
        }))).toThrow(/publisher|publication entry point/u)
      },
    )

    it.each(['ref', 'persist-credentials', 'clean', 'path', 'repository', 'if', 'continue-on-error', 'working-directory', 'action', 'missing', 'duplicate', 'late'])(
      'rejects checkout changes: %s', (field) => {
        expect(() => verifyReleasePolicy(mutatePublisher(run, (_step, job) => {
          const checkout = job.steps![0]!
          if (field === 'missing') job.steps!.shift()
          else if (field === 'duplicate') job.steps!.push({ ...checkout })
          else if (field === 'late') { job.steps!.shift(); job.steps!.push(checkout) }
          else if (field === 'action') checkout.uses = 'actions/checkout@v5'
          else if (field === 'if') checkout[field] = '${{ always() }}'
          else if (field === 'continue-on-error') checkout[field] = true
          else if (field === 'working-directory') checkout[field] = 'other'
          else if (field === 'path') checkout.with!.path = 'other'
          else if (field === 'repository') checkout.with!.repository = 'outsider/repository'
          else checkout.with![field] = field === 'persist-credentials' ? true : field === 'clean' ? false : '${{ github.sha }}'
        }))).toThrow(/checkout/u)
      },
    )
  })

  it.each([0, 1, 2, 3, 4])('rejects a source-check wrapper missing line %s', (line) => {
    const script = sourceCheckedPublisherRun.split('\n').filter((_value, index) => index !== line).join('\n')
    expect(() => verifyReleasePolicy(mutatePublisher(script))).toThrow(/publication entry point|checked Desktop publisher/u)
  })

  it.each([
    ["$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Continue'"],
    ['git rev-parse HEAD', 'git rev-parse master'],
    ['$LASTEXITCODE -ne 0 -or', '$LASTEXITCODE -ne 0 -and'],
    ['$head -cne', '$head -ne'],
    ['$env:SOURCE_SHA', '$env:EXPECTED_SOURCE_SHA'],
    ['exit $LASTEXITCODE', 'exit 0'],
    ["throw 'Publisher checkout", "Write-Output 'Publisher checkout"],
  ])('rejects weakened source-check wrapper text: %s', (before, after) => {
    expect(() => verifyReleasePolicy(mutatePublisher(sourceCheckedPublisherRun.replace(before, after))))
      .toThrow('unreviewed publication entry point')
  })

  it('accepts release inspection, packaging commands and arbitrary display titles', () => {
    expect(() => verifyReleasePolicy(mutate('release.yml', (workflow) => {
      workflow.name = 'Publish Core/Web'
      workflow.jobs.pack!.steps!.push({ run: 'gh release view some-tag\npnpm pack' })
    }))).not.toThrow()
  })

  it.each(['secret', 'inherited secrets', 'reusable', 'artifact', 'dispatch'])('rejects CI pack escalation or loss of artifact-only output: %s', (fault) => {
    expect(() => verifyReleasePolicy(mutate('release.yml', (workflow) => {
      if (fault === 'secret') workflow.jobs.pack!.steps!.push({ run: 'echo "${{ secrets.RELEASE_TOKEN }}"' })
      if (fault === 'inherited secrets') workflow.jobs.pack!.secrets = 'inherit'
      if (fault === 'reusable') workflow.jobs.pack!.uses = './.github/workflows/another.yml'
      if (fault === 'artifact') workflow.jobs.pack!.steps = []
      if (fault === 'dispatch') workflow.on = { workflow_dispatch: { inputs: { publish: { type: 'boolean' } } } }
    }))).toThrow(/CI pack|CI artifacts/u)
  })

  it.each(upstreamJobs)('keeps %s/%s unavailable on the fork for every dispatch publish value', (file, id) => {
    const workflow = load(readReleaseWorkflows(root).get(file)!) as Workflow
    const expression = workflow.jobs[id]!.if!
    // These fixed equality/AND expressions use canonical strings and booleans, not general Actions evaluation.
    for (const repository of ['cloga/deepseek-harness', 'deepseek-harness/deepseek-harness', 'private/python-publisher']) {
      for (const publish of [false, true]) {
        for (const event_name of ['workflow_dispatch', 'push']) {
          const context = { github: { repository, event_name }, inputs: { publish } }
          const enabled = runInNewContext(expression, context, { timeout: 1000 }) as boolean
          const original = file.startsWith('release-') || (publish && (file !== 'python-release.yml' || event_name === 'workflow_dispatch'))
          expect(enabled).toBe(repository !== 'cloga/deepseek-harness' && original)
        }
      }
    }
  })

  it.each(upstreamJobs)('rejects removal and input/variable overrides of %s/%s exclusion', (file, id) => {
    for (const condition of [undefined, 'inputs.publish', "github.repository != 'cloga/deepseek-harness' || inputs.publish", "github.repository != 'cloga/deepseek-harness' || vars.ALLOW_PUBLICATION == 'true'"]) {
      expect(() => verifyReleasePolicy(mutate(file, (workflow) => {
        if (condition === undefined) delete workflow.jobs[id]!.if
        else workflow.jobs[id]!.if = condition
      }))).toThrow('fixed fork exclusion')
    }
  })

  it.each(['permission', 'environment', 'needs', 'rehearsal', 'publisher', 'job'])('retains the existing Desktop publication path: %s', (fault) => {
    expect(() => verifyReleasePolicy(mutate('desktop-fork-release.yml', (workflow) => {
      const job = workflow.jobs.release!
      if (fault === 'permission') job.permissions = { contents: 'read' }
      if (fault === 'environment') job.environment = 'unprotected'
      if (fault === 'needs') job.needs = []
      if (fault === 'rehearsal') job.if = 'inputs.rehearsal'
      if (fault === 'publisher') job.steps = []
      if (fault === 'job') delete workflow.jobs.release
    }))).toThrow(/Desktop|protected environment|verified build|rehearsal/u)
  })

  it('rejects empty and narrowed release workflow inventories', () => {
    expect(() => verifyReleasePolicy(new Map())).toThrow('Missing release policy workflow')
    const sources = readReleaseWorkflows(root)
    sources.delete('python-release.yml')
    expect(() => verifyReleasePolicy(sources)).toThrow('Missing release policy workflow')
    expect(() => verifyReleasePolicy(mutate('python-release.yml', (workflow) => { delete workflow.jobs['publish-sdk'] }))).toThrow('explicitly guarded')
  })

  it('rejects malformed YAML and empty job maps', () => {
    const sources = readReleaseWorkflows(root)
    sources.set('new.yml', 'jobs: [')
    expect(() => verifyReleasePolicy(sources)).toThrow()
    expect(() => verifyReleasePolicy(mutate('ci.yml', (workflow) => { workflow.jobs = {} }))).toThrow('empty jobs')
  })
})
