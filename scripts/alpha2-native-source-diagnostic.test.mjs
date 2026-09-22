/** Inert workflow contract checks: read source text only; no subprocess, dependencies, native controls or applications. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflowUrl = new URL('../.github/workflows/alpha2-native-source-diagnostic.yml', import.meta.url)
const source = readFileSync(workflowUrl, 'utf8')
const command = 'node --test apps/desktop/tests/windows-installed-upgrade.test.mjs apps/desktop/tests/windows-packaged-package-acceptance.test.mjs'

/** Audit this deliberately closed workflow layout; this is not a GitHub schema validator. */
function validateWorkflow(text) {
  assert.match(text, /^on:\n  push:\n    branches: \[cloga-official-first-016a2\]\n  workflow_dispatch:\n    inputs:\n      expected_source:\n        description: [^\n]+\n        required: true\n        type: string\n/mu)
  assert.match(text, /^permissions:\n  contents: read\n/mu)
  assert.equal((text.match(/^  [a-z][a-z_-]*:\n/gmu) ?? []).length, 3, 'Only push, workflow_dispatch and one diagnostic job')
  assert.match(text, /if: github\.repository == 'cloga\/deepseek-harness' && github\.ref == 'refs\/heads\/cloga-official-first-016a2'/u)
  assert.match(text, /runs-on: windows-2025\n    timeout-minutes: 15/u)
  assert.match(text, /EXPECTED_SOURCE: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.expected_source \}\}/u)
  assert.doesNotMatch(text, /inputs\.expected_source\s*\|\||secrets\.|continue-on-error:|concurrency:|--force|test-timeout|test-name-pattern|--test-only|DSH_.*(?:TIMEOUT|PHASE)/u)
  assert.doesNotMatch(text, /^    env:[\s\S]*?\$\{\{ runner\.temp \}\}[\s\S]*?^    steps:/mu,
    'runner.temp must not appear in job-level env')
  assert.match(text, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false\n          fetch-depth: 1\n          clean: true/u)
  const steps = [...text.matchAll(/^      - (?:name: (.+)|uses: (.+))$/gmu)].map(match => match[1] ?? match[2])
  assert.deepEqual(steps, [
    'actions/checkout@v6', 'Guard exact reviewed source before dependency setup', 'pnpm/action-setup@v4',
    'actions/setup-node@v6', 'Verify inert diagnostic workflow guards', 'Bind original source and tool identities',
    'Install normal frozen dependencies', 'Diagnose existing early native source guards', 'actions/upload-artifact@v4',
  ])
  for (const check of [
    "$env:GITHUB_EVENT_NAME -cnotin @('push', 'workflow_dispatch')",
    "$env:EXPECTED_SOURCE -cnotmatch '\\A[a-f0-9]{40}\\z'",
    '$env:GITHUB_SHA -cne $env:EXPECTED_SOURCE',
    "$env:GITHUB_REF -cne 'refs/heads/cloga-official-first-016a2'",
    "$env:GITHUB_REPOSITORY -cne 'cloga/deepseek-harness'",
    "$env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows'",
    "$id -cnotmatch '\\A[1-9][0-9]{0,19}\\z'",
    '$LASTEXITCODE -ne 0 -or $head -cne $env:EXPECTED_SOURCE',
    'git status --porcelain=v1 --untracked-files=all', '$LASTEXITCODE -ne 0 -or $dirty',
  ]) assert.ok(text.includes(check), check)
  assert.match(text, /version: '11\.7\.0'\n          dest: \$\{\{ runner\.temp \}\}\/alpha2-native-source-pnpm\n          run_install: false/u)
  assert.match(text, /node-version: '24\.13\.0'\n          package-manager-cache: false/u)
  assert.match(text, /node --test scripts\/alpha2-native-source-diagnostic\.test\.mjs\n          if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u)
  assert.match(text, /pnpm install --frozen-lockfile\n          if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u)
  assert.doesNotMatch(text, /(?:pnpm|npm) (?:run|exec)|electron\/install|playwright install|prepare:|build:|package:|Start-Process|Start-Sleep|workflow_call:|git (?:push|fetch)|gh (?:release|workflow)/u)
  assert.match(text, /\$nodeVersion -cne 'v24\.13\.0'/u)
  assert.match(text, /\$pnpmVersion -cne '11\.7\.0'/u)
  for (const field of ['sourceCommit', 'sourceTree', 'repository', 'sourceRef', 'event', 'runId', 'runAttempt',
    'nodeVersion', 'pnpmVersion', 'powerShellVersion', 'runnerOS', 'runnerEnvironment', 'identitySha256']) {
    assert.match(text, new RegExp(`\\b${field} =`, 'u'))
  }
  for (const path of ['pnpm-lock.yaml', '.github/workflows/alpha2-native-source-diagnostic.yml',
    'scripts/alpha2-native-source-diagnostic.test.mjs', 'apps/desktop/tests/windows-installed-upgrade.test.mjs',
    'apps/desktop/tests/windows-packaged-package-acceptance.test.mjs', 'apps/desktop/tests/windows-desktop-ui.ps1']) {
    assert.ok(text.includes(`'${path}'`), `Source hash binding: ${path}`)
  }
  assert.match(text, /Get-FileHash -LiteralPath \$file\.path -Algorithm SHA256/u)
  const driftRefusal = text.indexOf("throw 'Source bytes changed during frozen installation'")
  assert.ok(driftRefusal >= 0 && driftRefusal < text.indexOf(command))
  assert.match(text, /\$PSNativeCommandUseErrorActionPreference = \$false/u)
  assert.equal(text.split(command).length - 1, 1, 'Run unchanged owning command exactly once')
  assert.ok(text.includes(`${command} *> $rawLog\n            $testExitCode = $LASTEXITCODE`), 'Capture native exit immediately')
  assert.match(text, /\$phase = if \(\$testExitCode -eq 0\) \{ 'tests-passed' \} else \{ 'tests-failed' \}/u)
  assert.match(text, /\} finally \{\n            try \{/u)
  assert.match(text, /if \(\$logBytes -le 4194304\)/u)
  assert.match(text, /Copy-Item -LiteralPath \$rawLog -Destination \(Join-Path \$artifact 'node-output\.log'\) -ErrorAction Stop/u)
  assert.match(text, /'over-limit-retained-runner-only'; \$captureFailed = \$true/u)
  assert.match(text, /phase = \$phase; testExitCode = \$testExitCode; startedAt = \$started/u)
  assert.match(text, /maximumBytes = 4194304/u)
  assert.equal((text.match(/productQualification = \$false/gu) ?? []).length, 2)
  assert.match(text, /if \(\$testExitCode -ne 0\) \{ exit \$testExitCode \}\n          if \(\$captureFailed\) \{ exit 1 \}/u)
  const upload = text.slice(text.indexOf('      - uses: actions/upload-artifact@v4'))
  assert.match(upload, /if: \$\{\{ !cancelled\(\) && steps\.probe\.outputs\.evidence_ready == 'true' \}\}/u)
  assert.match(upload, /name: alpha2-native-source-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u)
  const paths = [...upload.matchAll(/^            (\$\{\{ runner\.temp \}\}\/\$\{\{ env\.DIAGNOSTIC_NAME \}\}\/artifact\/[^\n]+)$/gmu)].map(match => match[1])
  assert.deepEqual(paths, ['identity.json', 'outcome.json', 'node-output.log'].map(name => '${{ runner.temp }}/${{ env.DIAGNOSTIC_NAME }}/artifact/' + name))
  assert.match(upload, /if-no-files-found: error\n          retention-days: 7/u)
  assert.doesNotMatch(upload, /\*|github\.workspace|node_modules|home|always\(\)/u)
}

test('actual diagnostic workflow binds exact source and keeps the unchanged early owner checks', () => {
  validateWorkflow(source)
  const release = readFileSync(new URL('../.github/workflows/desktop-fork-release.yml', import.meta.url), 'utf8')
  assert.ok(release.includes(command), 'Diagnostic must run the maintained release guard command')
})

for (const [name, before, after] of [
  ['manual blank fallback', '|| inputs.expected_source }}', '|| inputs.expected_source || github.sha }}'],
  ['optional source', 'required: true', 'required: false'],
  ['wrong branch', 'branches: [cloga-official-first-016a2]', 'branches: [master]'],
  ['write permissions', 'contents: read', 'contents: write'],
  ['credentials persisted', 'persist-credentials: false', 'persist-credentials: true'],
  ['nonhosted runner', 'runs-on: windows-2025', 'runs-on: self-hosted'],
  ['larger job budget', 'timeout-minutes: 15', 'timeout-minutes: 45'],
  ['node drift', "node-version: '24.13.0'", "node-version: '24'"],
  ['nonfrozen install', 'pnpm install --frozen-lockfile', 'pnpm install'],
  ['wrong source assertion', '$env:GITHUB_SHA -cne $env:EXPECTED_SOURCE', '$env:GITHUB_SHA -eq $env:EXPECTED_SOURCE'],
  ['changed source ignored', "throw 'Source bytes changed during frozen installation'", "Write-Warning 'drift ignored'"],
  ['test budget override', command, command + ' --test-timeout=60000'],
  ['test subset', command, command + ' --test-name-pattern=synthetic'],
  ['lost test exit', '$testExitCode = $LASTEXITCODE', '$testExitCode = 0'],
  ['masked exit', 'exit $testExitCode', 'exit 0'],
  ['unbounded artifact log', '$logBytes -le 4194304', '$logBytes -le 999999999'],
  ['postfailure app build', '      - uses: actions/upload-artifact@v4', '      - name: Build\n        run: pnpm run build\n      - uses: actions/upload-artifact@v4'],
  ['broad artifact', '/artifact/node-output.log', '/artifact/**'],
  ['upload before test completion', "!cancelled() && steps.probe.outputs.evidence_ready == 'true'", 'always()'],
  ['job env unsupported context', "      DSH_TELEMETRY_DISABLED: '1'", "      OUTPUT: ${{ runner.temp }}/unsafe\n      DSH_TELEMETRY_DISABLED: '1'"],
]) {
  test(`rejects workflow weakening: ${name}`, () => {
    assert.ok(source.includes(before), `Mutation anchor: ${name}`)
    assert.throws(() => validateWorkflow(source.replace(before, after)))
  })
}
