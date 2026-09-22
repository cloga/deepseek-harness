/** Keyless guards and owned off-screen Win32 controls only: never launches Desktop or an installer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { installedUpgradeApplication } from './fixtures/windows-installed-upgrade-contract.mjs'
import { assertKeylessPackageProvider, initialCopilotUiDiagnostic, initialPackageAcceptance, observePackagePageErrors, packageBaselineDiagnostic, packageBaselinePresentation, packageCleanupVerified, packageGraphSnapshot, preparePackageAcceptanceHome, preparedTransactionId, retainPrimaryFailure, sameProcess, selectPackageAcceptanceModel, validatePackageFixture, withInitialKeylessOnboarding } from './fixtures/windows-packaged-package-acceptance.mjs'

const source = readFileSync(new URL('./fixtures/windows-packaged-package-acceptance.mjs', import.meta.url), 'utf8')
const native = readFileSync(new URL('./windows-desktop-ui.ps1', import.meta.url), 'utf8')
const id = '11111111-1111-4111-8111-111111111111'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function caught(action) {
  let error
  try { action() } catch (value) { error = value }
  assert(error instanceof Error)
  return error
}
function directory(t, base = tmpdir()) {
  let root = mkdtempSync(join(base, 'package-acceptance-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Establish the physical identity of a newly owned fixture, not an untrusted application input.
  root = realpathSync.native(root)
  return root
}

test('fixture allocation resolves an aliased temporary base before ownership checks', t => {
  const parent = directory(t)
  const physical = join(parent, 'physical')
  const alias = join(parent, 'temporary-alias')
  mkdirSync(physical)
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const root = directory(t, alias)
  assert.equal(dirname(root), realpathSync.native(physical))
  assert.equal(root, realpathSync.native(root))
  assert.equal(installedUpgradeApplication(root), join(root, 'Installed App', 'cloga-deepseek-harness-desktop', 'cloga-deepseek-harness.exe'))
})

test('fresh private package home includes the empty physical Desktop required by the native picker', t => {
  const root = directory(t)
  const expectedHome = join(root, 'package-home')
  const desktop = join(expectedHome, 'Desktop')
  assert.equal(existsSync(desktop), false)
  const home = preparePackageAcceptanceHome(root)
  assert.equal(home, expectedHome)
  assert.deepEqual(readdirSync(root), ['package-home'])
  assert.deepEqual(readdirSync(home), ['Desktop'])
  assert.deepEqual(readdirSync(desktop), [])
  for (const path of [home, desktop]) {
    assert.ok(lstatSync(path).isDirectory())
    assert.equal(lstatSync(path).isSymbolicLink(), false)
    assert.equal(realpathSync.native(path), path)
  }
})

for (const collision of ['file', 'empty-home', 'home-without-Desktop', 'Desktop-file']) {
  test(`private home preparation rejects an existing ${collision} without adopting or altering it`, t => {
    const root = directory(t)
    const home = join(root, 'package-home')
    if (collision === 'file') writeFileSync(home, 'owned collision sentinel')
    else {
      mkdirSync(home)
      if (collision === 'home-without-Desktop') writeFileSync(join(home, 'retained.txt'), 'retained home sentinel')
      if (collision === 'Desktop-file') writeFileSync(join(home, 'Desktop'), 'not a Desktop directory')
    }
    const before = packageGraphSnapshot(root)
    assert.throws(() => preparePackageAcceptanceHome(root), /new isolated home/u)
    assert.deepEqual(packageGraphSnapshot(root), before)
  })
}

for (const alias of ['home', 'root']) {
  test(`private home preparation refuses a linked ${alias} without creating an external Desktop`, t => {
    const parent = directory(t)
    const root = join(parent, 'owned')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'retained.txt'), 'outside sentinel')
    const link = alias === 'home' ? join(root, 'package-home') : join(parent, 'root-alias')
    symlinkSync(alias === 'home' ? outside : root, link, process.platform === 'win32' ? 'junction' : 'dir')
    const before = packageGraphSnapshot(parent)
    assert.throws(() => preparePackageAcceptanceHome(alias === 'home' ? root : link), /strict owned descendant|traverse a link|filesystem alias/u)
    assert.deepEqual(packageGraphSnapshot(parent), before)
    assert.equal(existsSync(join(outside, 'Desktop')), false)
    assert.equal(readFileSync(join(outside, 'retained.txt'), 'utf8'), 'outside sentinel')
  })
}

test('private Desktop remains owned by home cleanup and preparation never adopts a prior run', t => {
  const root = directory(t)
  const home = preparePackageAcceptanceHome(root)
  writeFileSync(join(home, 'Desktop', 'owned.txt'), 'owned file')
  writeFileSync(join(root, 'retained.txt'), 'root sentinel')
  const before = packageGraphSnapshot(root)
  assert.throws(() => preparePackageAcceptanceHome(root), /new isolated home/u)
  assert.deepEqual(packageGraphSnapshot(root), before)
  rmSync(home, { recursive: true })
  assert.equal(existsSync(join(home, 'Desktop')), false)
  assert.equal(readFileSync(join(root, 'retained.txt'), 'utf8'), 'root sentinel')
})

test('fresh baseline presentation is checked before Models and pending status withholds Copilot observation', async () => {
  const previous = globalThis.dshDesktop
  const page = { evaluate: callback => callback() }
  try {
    globalThis.dshDesktop = { protocolVersion: 1, updates: { status: async () => ({ phase: 'idle' }) } }
    assert.deepEqual(await packageBaselinePresentation(page), { phase: 'idle', baseline: null })
    globalThis.dshDesktop.updates.status = async () => ({ phase: 'idle', baseline: { status: 'pending', packageName: 'dsh-github-copilot' } })
    const pending = await packageBaselinePresentation(page)
    assert.deepEqual(pending, { phase: 'idle', baseline: { status: 'pending', packageName: 'dsh-github-copilot' } })
    let modelsObserved = false
    assert.throws(() => {
      assert.equal(pending.baseline, null, `Required packaged baseline is not ready: ${pending.baseline?.status ?? 'unknown'}`)
      modelsObserved = true
    }, /baseline is not ready: pending/u)
    assert.equal(modelsObserved, false)
  } finally {
    if (previous === undefined) delete globalThis.dshDesktop
    else globalThis.dshDesktop = previous
  }
})

test('baseline presentation rejects malformed identities and bounds an unresolved diagnostic call', async () => {
  const previous = globalThis.dshDesktop
  try {
    const page = { evaluate: callback => callback() }
    globalThis.dshDesktop = { protocolVersion: 1, updates: { status: async () => ({ phase: 'idle',
      baseline: { status: 'pending', packageName: 'secret\nname' },
    }) } }
    await assert.rejects(packageBaselinePresentation(page), /Invalid Desktop baseline presentation/u)
    for (const malformed of [undefined, null, 'idle', [], { phase: 'foreign' }]) {
      globalThis.dshDesktop.updates.status = async () => malformed
      await assert.rejects(packageBaselinePresentation(page), /Invalid Desktop update status/u)
    }
    const waiting = { evaluate: () => new Promise(() => {}) }
    await assert.rejects(packageBaselinePresentation(waiting, 1), /baseline diagnostic deadline/u)
  } finally {
    if (previous === undefined) delete globalThis.dshDesktop
    else globalThis.dshDesktop = previous
  }
})

test('public Models diagnostic records only bounded counts', async () => {
  const button = { count: async () => 1 }
  const root = { count: async () => 1, getByRole: () => button }
  const settings = { count: async () => 1, locator: () => root }
  assert.deepEqual(await initialCopilotUiDiagnostic(settings), {
    schemaVersion: 1, baselineRequired: true, settingsDialogs: 1, copilotAccountRoots: 1, copilotSignInButtons: 1,
  })
})

test('physical baseline diagnostic projects safe leaves and never credential-shaped values', t => {
  const root = directory(t), home = preparePackageAcceptanceHome(root), profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true,
    dependencies: { 'dsh-github-copilot': 'https://user:secret@example.invalid/plugin.tgz' },
    dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profile, 'desktop-plugin-provisioning-state.json'), JSON.stringify({ schemaVersion: 1, plugins: [{
    name: 'dsh-github-copilot', version: 'https://user:secret@example.invalid/version', required: true, status: 'optional-failed', phase: 'download',
  }] }))
  writeFileSync(join(profile, 'desktop-plugin-receipts.json'), JSON.stringify({ schemaVersion: 1,
    receipts: { 'dsh-github-copilot': { artifactSha256: 'a'.repeat(64), source: {
      packageName: 'dsh-github-copilot', version: 'https://user:secret@example.invalid/receipt', tag: 'secret-tag',
    } } }, owners: { 'dsh-github-copilot': 'release' } }))
  writeFileSync(join(profile, 'desktop-plugin-package-locks.json'), JSON.stringify({ schemaVersion: 1,
    packages: { 'dsh-github-copilot': { version: 'https://user:secret@example.invalid/lock', sha256: 'b'.repeat(64) } } }))
  writeFileSync(join(profile, 'desktop-plugin-user-intents.json'), JSON.stringify({ schemaVersion: 1, removed: {} }))
  const diagnostic = packageBaselineDiagnostic(home, profile)
  assert.deepEqual(diagnostic.manifest, { dependencyPresent: true, dependencyKind: 'other', selected: false })
  assert.deepEqual(diagnostic.pendingTransactions, [])
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false)
  for (const file of Object.values(diagnostic.files)) {
    if (file.exists) { assert.match(file.sha256, /^[a-f0-9]{64}$/u); assert.ok(file.bytes > 0) }
  }
})

test('baseline diagnostic refuses malformed, oversized and ambiguous physical evidence', t => {
  const capture = (action, pattern) => {
    let failure
    try { action() } catch (error) { failure = error }
    assert.ok(failure instanceof Error)
    assert.match(failure.message, pattern)
    return failure
  }
  const root = directory(t), home = preparePackageAcceptanceHome(root), profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{"secret":"credential-fragment"')
  const invalid = capture(() => packageBaselineDiagnostic(home, profile), /Invalid baseline diagnostic JSON: package\.json/u)
  assert.equal(invalid.message.includes('credential-fragment'), false)
  writeFileSync(join(profile, 'package.json'), '{}')
  assert.throws(() => packageBaselineDiagnostic(home, profile), /Malformed package baseline manifest/u)
  writeFileSync(join(profile, 'package.json'), 'x'.repeat(8 * 1024 * 1024 + 1))
  assert.throws(() => packageBaselineDiagnostic(home, profile), /Unsafe baseline diagnostic file/u)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profile, 'desktop-plugin-receipts.json'), JSON.stringify({ schemaVersion: 1,
    receipts: { 'dsh-github-copilot': { artifactSha256: 'a'.repeat(64), source: { packageName: 'dsh-github-copilot', version: '1.0.0' } } },
    owners: { 'dsh-github-copilot': 'credential-fragment' } }))
  const owner = capture(() => packageBaselineDiagnostic(home, profile), /Malformed planned receipt owner/u)
  assert.equal(owner.message.includes('credential-fragment'), false)
  rmSync(join(profile, 'desktop-plugin-receipts.json'))
  mkdirSync(join(home, 'profiles', '.desktop.package-stage-not-a-uuid'))
  assert.throws(() => packageBaselineDiagnostic(home, profile), /Malformed pending transaction name/u)
})

test('initial launch binds public baseline and physical diagnostic before opening Settings', () => {
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  const launch = run.indexOf("await launch('initial')")
  const baseline = run.indexOf('await packageBaselinePresentation(page)', launch)
  const physical = run.indexOf("packageBaselineDiagnostic(home, profile)", baseline)
  const refusal = run.indexOf('assert.equal(baselinePresentation.baseline, null', physical)
  const settings = run.indexOf("getByRole('button', { name: 'Settings'", refusal)
  assert.ok(launch >= 0 && launch < baseline && baseline < physical && physical < refusal && refusal < settings)
  assert.ok(run.includes("save(join(evidence, 'package-baseline-failure-diagnostic.json')"))
  assert.ok(run.includes("hostStderr: { status: 'unavailable-through-current-launch-transport' }"))
})

test('private picker home preparation follows ownership validation and precedes every launch', () => {
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  const prepare = run.indexOf('const home = preparePackageAcceptanceHome(root)')
  assert.ok(prepare >= 0)
  for (const earlier of ['assertUpgradeRunner(process.env)', 'ownedUpgradePath(process.env.RUNNER_TEMP, runRoot)',
    'assert.equal(validated.ownerToken, owner.token)', 'assert.equal(expected.source.commit, process.env.GITHUB_SHA)',
    'validated.candidate.manifestFileSha256']) {
    const index = run.indexOf(earlier)
    assert.ok(index >= 0 && index < prepare, earlier)
  }
  for (const later of ["await import('../../scripts/smoke-environment.ts')", "._electron.launch(", "await import('../../../../packages/llm/llm-pi-ai/tests/mock-server.ts')", "native('ChooseWorkspace')"]) {
    assert.ok(run.indexOf(later) > prepare, later)
  }
  assert.ok(run.includes('for (const directory of [userData, workspace, data])'))
  assert.ok(run.includes('const environment = { ...desktopSmokeEnvironment(home),'))
  assert.ok(run.includes("const profile = join(home, 'profiles', 'desktop')"))
})

function onboardingPage({ registrationFailure, removalFailure, choiceFailure, choiceStage,
  hasRegistrationFailure = false, hasRemovalFailure = false } = {}) {
  const trace = []
  let handler
  let visible = false
  const dialog = {
    getByRole(role, options) {
      assert.equal(role, 'button')
      assert.deepEqual(options, { name: 'Configure later', exact: true })
      return { async click(...args) {
        assert.deepEqual(args, [])
        trace.push('public-configure-later')
        if (choiceStage === 'click') throw choiceFailure
        visible = false
      } }
    },
    async waitFor(options) {
      assert.deepEqual(options, { state: 'detached' })
      assert.equal(visible, false)
      if (choiceStage === 'detached') throw choiceFailure
      trace.push('detached')
    },
  }
  const page = {
    getByRole(role, options) {
      assert.equal(role, 'dialog')
      assert.deepEqual(options, { name: 'Add an API key to get started', exact: true })
      return dialog
    },
    async addLocatorHandler(locator, callback, options) {
      assert.equal(locator, dialog)
      assert.deepEqual(options, { times: 1 })
      trace.push('register')
      handler = callback
      if (hasRegistrationFailure) throw registrationFailure
    },
    async removeLocatorHandler(locator) {
      assert.equal(locator, dialog)
      trace.push('remove')
      if (hasRemovalFailure) throw removalFailure
      handler = undefined
    },
  }
  return { page, trace, active: () => handler !== undefined, async attempt(title) {
    trace.push('normal-action')
    if (title !== undefined && title !== 'Add an API key to get started') throw new Error('unknown overlay still blocks')
    if (title !== undefined) {
      visible = true
      assert.equal(typeof handler, 'function')
      await handler()
      assert.equal(visible, false)
    }
  } }
}

for (const prompt of ['absent', 'late']) {
  test(`initial keyless bootstrap handles only the actual ${prompt} credential prompt and removes its handler`, async () => {
    const fixture = onboardingPage()
    const result = { owned: true }
    const secondary = []
    const observed = await withInitialKeylessOnboarding(fixture.page, async () => {
      assert.equal(fixture.active(), true)
      await Promise.resolve()
      await fixture.attempt(prompt === 'late' ? 'Add an API key to get started' : undefined)
      fixture.trace.push('provider-ready')
      return result
    }, secondary)
    assert.equal(observed, result)
    assert.equal(fixture.active(), false)
    assert.deepEqual(fixture.trace, prompt === 'late'
      ? ['register', 'normal-action', 'public-configure-later', 'detached', 'provider-ready', 'remove']
      : ['register', 'normal-action', 'provider-ready', 'remove'])
    assert.deepEqual(secondary, [])
  })
}

test('initial keyless bootstrap never dismisses an unknown overlay or performs a later-phase choice', async () => {
  const fixture = onboardingPage()
  await assert.rejects(withInitialKeylessOnboarding(fixture.page, () => fixture.attempt('Unexpected confirmation'), []), /unknown overlay still blocks/u)
  assert.equal(fixture.active(), false)
  assert.equal(fixture.trace.includes('public-configure-later'), false)
  await assert.rejects(fixture.attempt('Add an API key to get started'))
})

const failureLabel = value => value === undefined ? 'undefined' : value === null ? 'null' : 'Error'
for (const stage of ['register', 'action', 'remove']) {
  for (const primary of [new Error(`primary ${stage}`), undefined, null]) {
    test(`initial onboarding ${stage} failure preserves ${failureLabel(primary)} and withholds return`, async () => {
      const fixture = onboardingPage({ registrationFailure: primary, removalFailure: primary,
        hasRegistrationFailure: stage === 'register', hasRemovalFailure: stage === 'remove' })
      let actionCalled = false
      let rejected = false
      let caught
      await withInitialKeylessOnboarding(fixture.page, async () => {
        actionCalled = true
        if (stage === 'action') throw primary
        return 'must not escape failed cleanup'
      }, []).then(() => assert.fail('A failed bootstrap returned'), error => { rejected = true; caught = error })
      assert.equal(rejected, true)
      assert.equal(caught, primary)
      assert.equal(actionCalled, stage !== 'register')
      assert.equal(fixture.trace.at(-1), 'remove')
    })
  }
}

for (const choiceStage of ['click', 'detached']) {
  for (const choiceFailure of [new Error(`public choice ${choiceStage} failed`), undefined, null]) {
    test(`public onboarding ${choiceStage} failure is not hidden (${failureLabel(choiceFailure)})`, async () => {
      const fixture = onboardingPage({ choiceStage, choiceFailure })
      let rejected = false
      await withInitialKeylessOnboarding(fixture.page, () => fixture.attempt('Add an API key to get started'), [])
        .then(() => assert.fail('Failed public choice returned'), error => { rejected = true; assert.equal(error, choiceFailure) })
      assert.equal(rejected, true)
      assert.equal(fixture.active(), false)
      assert.equal(fixture.trace.at(-1), 'remove')
    })
  }
}

test('partial registration and removal failure preserve the original undefined rejection', async () => {
  const secondary = []
  const cleanup = new Error('remove after registration failure')
  const fixture = onboardingPage({ hasRegistrationFailure: true, registrationFailure: undefined,
    hasRemovalFailure: true, removalFailure: cleanup })
  let rejected = false
  await withInitialKeylessOnboarding(fixture.page, () => assert.fail('Action ran after registration failure'), secondary)
    .then(() => assert.fail('Failed registration returned'), error => { rejected = true; assert.equal(error, undefined) })
  assert.equal(rejected, true)
  assert.deepEqual(fixture.trace, ['register', 'remove'])
  assert.deepEqual(secondary, [{ stage: 'initial-onboarding-handler-removal', error: String(cleanup) }])
})

for (const primary of [new Error('original bootstrap failure'), undefined, null]) {
  test(`onboarding removal failure cannot replace ${failureLabel(primary)} action failure`, async () => {
    const removal = new Error('removal failure')
    const secondary = []
    const fixture = onboardingPage({ removalFailure: removal, hasRemovalFailure: true })
    let rejected = false
    await withInitialKeylessOnboarding(fixture.page, async () => { throw primary }, secondary)
      .then(() => assert.fail('A failed bootstrap returned'), error => { rejected = true; assert.equal(error, primary) })
    assert.equal(rejected, true)
    assert.deepEqual(secondary, [{ stage: 'initial-onboarding-handler-removal', error: String(removal) }])
    assert.equal(fixture.active(), true, 'A failed transport removal leaves final page disposal to the existing outer owner')
  })
}

for (const primary of [undefined, null]) {
test(`actual package failure retainer and success decision preserve a ${failureLabel(primary)} primary through later failures`, async () => {
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  const retainer = run.match(/  const retainError = \(error, stage\) => \{[^]*?\n  \}/u)?.[0]
  const success = run.match(/    report\.succeeded = !failed && report\.cleanupVerified/u)?.[0]
  const rethrow = run.match(/  if \(failed\) throw failure/u)?.[0]
  assert.ok(retainer && success && rethrow)
  const secondary = []
  const removal = new Error('handler removal')
  const cleanup = new Error('owned cleanup')
  const receipt = new Error('receipt write')
  const fixture = onboardingPage({ removalFailure: removal, hasRemovalFailure: true })
  const observed = await runInNewContext(`(async () => {
    let failure; let failed = false; const secondaryErrors = secondary;
    ${retainer}
    try { await withInitialKeylessOnboarding(page, async () => { throw primary }, secondaryErrors) }
    catch (error) { retainError(error, 'package-scenario') }
    retainError(cleanup, 'cleanup'); retainError(receipt, 'package-acceptance-write');
    const report = { cleanupVerified: true };
    ${success}
    let rejected = false; let caught;
    try { ${rethrow} } catch (error) { rejected = true; caught = error }
    return { failed, succeeded: report.succeeded, rejected, caught }
  })()`, { retainPrimaryFailure, withInitialKeylessOnboarding, page: fixture.page, secondary, cleanup, receipt, primary })
  assert.equal(observed.failed, true)
  assert.equal(observed.succeeded, false)
  assert.equal(observed.rejected, true)
  assert.equal(observed.caught, primary)
  assert.deepEqual(secondary.map(entry => entry.stage), ['initial-onboarding-handler-removal', 'cleanup', 'package-acceptance-write'])
  assert.ok(source.includes("retainError(error, 'package-scenario')"))
  assert.ok(source.includes("retainError(error, 'package-acceptance-write')"))
  assert.equal(source.includes('failure === undefined && report.cleanupVerified'), false)
})
}

test('initial onboarding rejects an unexpected second invocation of its one-shot choice', async () => {
  const fixture = onboardingPage()
  await assert.rejects(withInitialKeylessOnboarding(fixture.page, async () => {
    await fixture.attempt('Add an API key to get started')
    await fixture.attempt('Add an API key to get started')
  }, []), /Initial provider choice must occur at most once/u)
  assert.equal(fixture.trace.filter(value => value === 'public-configure-later').length, 1)
  assert.equal(fixture.active(), false)
  assert.equal(fixture.trace.at(-1), 'remove')
})

for (const primary of [new Error('only owned cleanup failed'), undefined, null]) {
  test(`actual root cleanup-only ${failureLabel(primary)} failure is promoted and cannot report success`, () => {
    const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
    const retainer = run.match(/  const retainError = \(error, stage\) => \{[^]*?\n  \}/u)?.[0]
    const cleanup = run.match(/    const cleanupFailure = \(stage, error\) => \{[^]*?\n    \}/u)?.[0]
    const success = run.match(/    report\.succeeded = !failed && report\.cleanupVerified/u)?.[0]
    const rethrow = run.match(/  if \(failed\) throw failure/u)?.[0]
    const safe = source.match(/^const safeError = .+$/mu)?.[0]
    assert.ok(retainer && cleanup && success && rethrow && safe)
    const secondary = []
    const observed = runInNewContext(`let failure; let failed = false; const secondaryErrors = secondary; const cleanupErrors = [];
      ${safe}
      ${retainer}
      ${cleanup}
      cleanupFailure('owned-close', primary);
      const report = { cleanupVerified: true };
      ${success}
      let rejected = false; let caught;
      try { ${rethrow} } catch (error) { rejected = true; caught = error }
      ({ failed, succeeded: report.succeeded, rejected, caught, cleanupCount: cleanupErrors.length })`,
    { retainPrimaryFailure, secondary, primary })
    assert.equal(observed.failed, true)
    assert.equal(observed.succeeded, false)
    assert.equal(observed.rejected, true)
    assert.equal(observed.caught, primary)
    assert.equal(observed.cleanupCount, 1)
    assert.deepEqual(secondary, [])
  })
}

test('keyless bootstrap requires the canonical UI-written local provider without a credential reference', () => {
  const baseURL = 'http://127.0.0.1:12345'
  const profile = { displayName: 'Desktop acceptance (local test)', api: 'openai-completions', baseURL, models: [{ id: 'acceptance-local' }] }
  const document = value => ({ 'llm-pi-ai': { providers: { 'desktop-acceptance': value } } })
  assert.doesNotThrow(() => assertKeylessPackageProvider(document(profile), baseURL))
  for (const value of [undefined, {}, { ...profile, api: 'wrong' }, { ...profile, baseURL: 'https://example.invalid' },
    { ...profile, models: [{ id: 'other-model' }] }, { ...profile, apiKeyEnv: 'FAKE_KEY' }, { ...profile, apiKey: 'must not store' }]) {
    assert.throws(() => assertKeylessPackageProvider(document(value), baseURL))
  }
  const bootstrap = source.slice(source.indexOf('const settings = await withInitialKeylessOnboarding(page'), source.indexOf("await page.keyboard.press('Escape')", source.indexOf('const settings = await withInitialKeylessOnboarding(page')))
  assert.ok(bootstrap.includes("name: 'Sign in with GitHub', exact: true"))
  assert.ok(bootstrap.indexOf("name: 'Sign in with GitHub'") < bootstrap.indexOf("name: 'Add a custom provider'"))
  assert.ok(bootstrap.includes('assertKeylessPackageProvider(load('))
  assert.ok(bootstrap.includes("name: 'Edit Desktop acceptance (local test) (desktop-acceptance)', exact: true"))
  assert.ok(bootstrap.includes("name: 'Edit DeepSeek (deepseek-official)', exact: true"))
  assert.ok(bootstrap.includes('return root !== null && !root.inert'))
  assert.ok(bootstrap.includes('assert.equal(mock.requests.length, 0)'))
  assert.ok(bootstrap.includes('assert.equal(mock.paths.length, 0)'))
  assert.ok(bootstrap.endsWith('}, secondaryErrors)\n    '))
  assert.equal(source.match(/await withInitialKeylessOnboarding\(page/gu).length, 1, 'No later document or restart auto-dismissal')
  assert.ok(source.indexOf("native('ChooseWorkspace')", source.indexOf(bootstrap)) > source.indexOf(bootstrap) + bootstrap.length)
})

function modelSelectionPage({ checked = 'true', selectionFailure } = {}) {
  const committed = Promise.withResolvers()
  const clicked = Promise.withResolvers()
  const trace = []
  let open = false
  let selected = false
  const trigger = { async click() { trace.push('trigger'); open = !open } }
  const selectedTrigger = {
    async waitFor(options) { assert.deepEqual(options, { state: 'visible' }); assert.equal(selected, true); trace.push('selected-visible') },
    async click() { assert.equal(selected, true); trace.push('selected-trigger'); open = !open },
  }
  const option = {
    async click() {
      assert.equal(open, true)
      trace.push('choose')
      clicked.resolve()
      void committed.promise.then(() => { if (selectionFailure === undefined) { selected = true; open = false } })
    },
    async getAttribute(name) { assert.equal(name, 'aria-checked'); trace.push('checked'); return checked },
  }
  const group = { getByRole(role, options) {
    assert.equal(role, 'menuitemradio'); assert.deepEqual(options, { name: 'acceptance-local', exact: true }); return option
  } }
  const menu = {
    getByRole(role, options) {
      assert.equal(open, true)
      if (role === 'group') { assert.deepEqual(options, { name: 'Desktop acceptance (local test)', exact: true }); return group }
      assert.equal(role, 'menuitem'); assert.equal(options.name.source, '^Model\\b')
      return { async click() { trace.push('model-pane') } }
    },
    async waitFor(options) {
      assert.deepEqual(options, { state: 'hidden' })
      trace.push('await-menu-hidden')
      await committed.promise
      if (selectionFailure !== undefined) throw selectionFailure
      assert.equal(open, false)
    },
  }
  const page = { getByRole(role, options) {
    if (role === 'menu') { assert.deepEqual(options, { name: 'Model and reasoning effort', exact: true }); return menu }
    assert.equal(role, 'button')
    if (typeof options.name !== 'string') { assert.equal(options.name.source, '^Select model, current'); return trigger }
    assert.deepEqual(options, { name: 'Select model, current acceptance-local', exact: true }); return selectedTrigger
  } }
  return { page, trace, clicked: clicked.promise, commit: committed.resolve }
}

test('model setup waits for real selection settlement then observes the checked route before proceeding', async () => {
  const fixture = modelSelectionPage()
  let resolved = false
  const action = selectPackageAcceptanceModel(fixture.page).then(() => { resolved = true })
  await fixture.clicked
  await Promise.resolve()
  assert.equal(resolved, false, 'Existing composer visibility cannot complete selection')
  fixture.commit()
  await action
  assert.deepEqual(fixture.trace, ['trigger', 'model-pane', 'choose', 'await-menu-hidden', 'selected-visible',
    'selected-trigger', 'model-pane', 'checked', 'selected-trigger', 'await-menu-hidden'])
})

for (const mode of ['selection-failed', 'not-checked']) {
  test(`model setup refuses ${mode} instead of writing a successful local-model checkpoint`, async () => {
    const failure = new Error('selection did not settle')
    const fixture = modelSelectionPage({ checked: mode === 'not-checked' ? 'false' : 'true',
      selectionFailure: mode === 'selection-failed' ? failure : undefined })
    const action = selectPackageAcceptanceModel(fixture.page)
    const rejection = assert.rejects(action, mode === 'selection-failed' ? error => error === failure : /selection did not settle/u)
    await fixture.clicked
    fixture.commit()
    await rejection
  })
}

test('package checkpoints require model selection and the new-session default witness before drafts', () => {
  const selection = source.indexOf('await selectPackageAcceptanceModel(page)')
  const keyless = source.indexOf("await checkpoint('keyless-composer'")
  assert.ok(selection > source.indexOf("native('ChooseWorkspace')") && keyless > selection)
  const newSession = source.indexOf("name: 'New session', exact: true")
  const restoredModel = source.indexOf("name: 'Select model, current acceptance-local', exact: true }).waitFor()", newSession)
  assert.ok(newSession > keyless && restoredModel > newSession)
  assert.ok(restoredModel < source.indexOf('const input = await writeDraft(text)'))
})

test('page error observation spans same-page Host navigation and seals only after the final business interaction', async () => {
  const page = new EventEmitter()
  const foreign = () => {}
  page.on('pageerror', foreign)
  const observer = observePackagePageErrors(page)
  try {
    const firstCheckpoint = observer.snapshot()
    assert.deepEqual(firstCheckpoint, [])
    assert.equal(Object.isFrozen(firstCheckpoint), true)
    page.emit('framenavigated', { owned: true })
    await Promise.resolve()
    page.emit('pageerror', new Error('after activation navigation'))
    const observed = observer.snapshot()
    assert.deepEqual(observed, ['Error: after activation navigation'])
    assert.throws(() => assert.deepEqual(observed, []))
    const sealed = observer.seal()
    assert.equal(Object.isFrozen(sealed), true)
    assert.equal(page.listenerCount('pageerror'), 1, 'Only the owned error listener is removed')
    assert.equal(page.listeners('pageerror')[0], foreign)
    page.emit('pageerror', new Error('deliberate teardown'))
    assert.equal(observer.snapshot(), sealed)
    assert.deepEqual(sealed, ['Error: after activation navigation'])
    assert.deepEqual(firstCheckpoint, [])
  } finally { observer.seal(); page.off('pageerror', foreign) }
})

test('new Electron pages retain all earlier observations without mutable array rebinding', () => {
  const firstPage = new EventEmitter()
  const nextPage = new EventEmitter()
  const first = observePackagePageErrors(firstPage)
  const next = observePackagePageErrors(nextPage)
  try {
    firstPage.emit('pageerror', new Error('first generation'))
    const sealed = first.seal()
    nextPage.emit('pageerror', new Error('second generation'))
    firstPage.emit('pageerror', new Error('late old page'))
    assert.deepEqual([first, next].flatMap(observer => observer.snapshot()), ['Error: first generation', 'Error: second generation'])
    assert.equal(first.snapshot(), sealed)
  } finally { first.seal(); next.seal() }
})

test('page-error removal failure disables collection before removal and preserves a frozen snapshot', () => {
  const page = new EventEmitter()
  const observer = observePackagePageErrors(page)
  page.emit('pageerror', new Error('business error'))
  const remove = page.off.bind(page)
  page.off = () => { throw new Error('transport removal failed') }
  try {
    assert.throws(() => observer.seal(), /transport removal failed/u)
    const sealed = observer.snapshot()
    page.emit('pageerror', new Error('after failed removal'))
    assert.equal(observer.seal(), sealed)
    assert.deepEqual(sealed, ['Error: business error'])
    assert.equal(Object.isFrozen(sealed), true)
  } finally {
    for (const listener of page.listeners('pageerror')) remove('pageerror', listener)
  }
})

for (const primary of [new Error('original action failed'), undefined, null]) {
  test(`page observer cleanup failure cannot replace ${failureLabel(primary)} primary or stop later cleanup`, () => {
    const page = new EventEmitter()
    const observer = observePackagePageErrors(page)
    const remove = page.off.bind(page)
    const removal = new Error('observer removal failed')
    page.off = () => { throw removal }
    const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
    const retainer = run.match(/  const retainError = \(error, stage\) => \{[^]*?\n  \}/u)?.[0]
    const cleanup = run.match(/    const cleanupFailure = \(stage, error\) => \{[^]*?\n    \}/u)?.[0]
    const sealLoop = run.match(/    for \(const observer of pageErrorObservers\) \{[^]*?\n    \}/u)?.[0]
    assert.ok(retainer && cleanup && sealLoop)
    const secondary = []
    try {
      const result = runInNewContext(`let failure; let failed=false; const secondaryErrors=secondary; const cleanupErrors=[];
        ${retainer}
        ${cleanup}
        retainError(primary, 'package-scenario');
        ${sealLoop}
        const ownedCloseReached=true;
        ({ failure, failed, cleanupCount:cleanupErrors.length, ownedCloseReached })`,
      { retainPrimaryFailure, safeError: String, primary, secondary, pageErrorObservers: [observer] })
      assert.equal(result.failure, primary)
      assert.equal(result.failed, true)
      assert.equal(result.cleanupCount, 1)
      assert.equal(result.ownedCloseReached, true)
      assert.deepEqual(secondary, [{ stage: 'page-error-observer-remove', error: String(removal) }])
      page.emit('pageerror', new Error('late after rejected removal'))
      assert.deepEqual(observer.snapshot(), [])
    } finally {
      for (const listener of page.listeners('pageerror')) remove('pageerror', listener)
    }
  })
}

test('observer-only removal failure becomes the actual root failure and cannot qualify success', () => {
  const page = new EventEmitter()
  const observer = observePackagePageErrors(page)
  const remove = page.off.bind(page)
  const removal = new Error('only observer removal failed')
  page.off = () => { throw removal }
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  const retainer = run.match(/  const retainError = \(error, stage\) => \{[^]*?\n  \}/u)?.[0]
  const cleanup = run.match(/    const cleanupFailure = \(stage, error\) => \{[^]*?\n    \}/u)?.[0]
  const sealLoop = run.match(/    for \(const observer of pageErrorObservers\) \{[^]*?\n    \}/u)?.[0]
  const success = run.match(/    report\.succeeded = !failed && report\.cleanupVerified/u)?.[0]
  assert.ok(retainer && cleanup && sealLoop && success)
  try {
    const result = runInNewContext(`let failure; let failed=false; const secondaryErrors=[]; const cleanupErrors=[];
      ${retainer}
      ${cleanup}
      ${sealLoop}
      const report={cleanupVerified:true};
      ${success};
      ({failure,failed,succeeded:report.succeeded,cleanupCount:cleanupErrors.length})`,
    { retainPrimaryFailure, safeError: String, pageErrorObservers: [observer] })
    assert.equal(result.failure, removal)
    assert.equal(result.failed, true)
    assert.equal(result.succeeded, false)
    assert.equal(result.cleanupCount, 1)
  } finally { for (const listener of page.listeners('pageerror')) remove('pageerror', listener) }
})

test('partially registered error observers stop collecting after registration rejects', () => {
  const page = new EventEmitter()
  const add = page.on.bind(page)
  const failure = new Error('partial registration')
  let attemptedConversion = 0
  page.on = (event, callback) => { add(event, callback); throw failure }
  assert.throws(() => observePackagePageErrors(page), error => error === failure)
  page.emit('pageerror', { toString() { attemptedConversion++; return 'must remain unobserved' } })
  assert.equal(attemptedConversion, 0)
  for (const listener of page.listeners('pageerror')) page.off('pageerror', listener)
})

test('actual package owner seals and checks every page before deliberate Exit and before failure cleanup close', () => {
  const close = source.slice(source.indexOf('  const closeNormally = async'), source.indexOf('  const openPlugins'))
  assert.ok(close.indexOf("await native('Observe')") < close.indexOf('activePageErrors.seal()'))
  assert.ok(close.indexOf('activePageErrors.seal()') < close.indexOf('assert.deepEqual(observedPageErrors(), []'))
  assert.ok(close.indexOf('assert.deepEqual(observedPageErrors(), []') < close.indexOf("await openNativeMenu('Exit')"))
  assert.ok(source.includes('pageErrorObservers.push(activePageErrors)'))
  assert.equal(source.includes('    errors = []'), false)
  const activation = source.slice(source.indexOf('  const accept = async'), source.indexOf('  const writeDraft'))
  assert.equal(activation.includes('.seal('), false, 'Host replacement within this Page stays in scope')
  const outer = source.slice(source.indexOf("retainError(error, 'package-scenario')"))
  assert.ok(outer.indexOf('for (const observer of pageErrorObservers)') < outer.indexOf('await app.close()'))
  assert.ok(outer.includes('const errors = Object.freeze(observedPageErrors())'))
  assert.ok(outer.includes("retainError(new Error('Product page errors were observed'), 'product-page-errors')"))
})

test('installed observers agree on the driver-owned nested application path', t => {
  const root = directory(t)
  assert.equal(installedUpgradeApplication(root), join(root, 'Installed App', 'cloga-deepseek-harness-desktop', 'cloga-deepseek-harness.exe'))
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.ok(driver.includes("$baselineAppFilename = 'cloga-deepseek-harness-desktop'"))
  assert.ok(driver.includes("$installPath = Join-Path $root ('Installed App\\' + $baselineAppFilename)"))
  for (const name of ['windows-installed-upgrade-smoke.mjs', 'windows-packaged-package-acceptance.mjs']) {
    const consumer = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    assert.ok(consumer.includes('const application = installedUpgradeApplication(root)'), name)
    assert.equal(consumer.includes("join(root, 'Installed App', 'cloga-deepseek-harness.exe')"), false)
  }
  assert.ok(native.includes("$application = Join-Path $root 'Installed App\\cloga-deepseek-harness-desktop\\cloga-deepseek-harness.exe'"))
  const helperLoad = native.indexOf(". (Join-Path $PSScriptRoot 'fixtures/windows-installer-registration.ps1')")
  const ancestry = native.indexOf('Assert-InstallerOwnedPath $root $application')
  assert.ok(helperLoad > native.indexOf("throw 'Foreign runner owner'"))
  assert.ok(ancestry > helperLoad && ancestry < native.indexOf('$fixture = Read-Process $FixturePid'))
})

for (const location of ['container', 'application-parent']) {
  test(`installed application path rejects a linked ${location}`, t => {
    const root = directory(t)
    const target = join(root, 'elsewhere')
    mkdirSync(target)
    const container = join(root, 'Installed App')
    if (location === 'application-parent') mkdirSync(container)
    const link = location === 'container' ? container : join(container, 'cloga-deepseek-harness-desktop')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => installedUpgradeApplication(root), /must not traverse a link/)
  })
}

test('fresh evidence cannot claim any real acceptance path passed', () => {
  const report = initialPackageAcceptance('a'.repeat(40))
  assert.equal(report.scope, 'candidate-installed-desktop-same-version-isolated-home')
  const claims = Object.entries(report).filter(([, value]) => typeof value === 'boolean')
  assert.ok(claims.length >= 20)
  assert.ok(claims.every(([, value]) => value === false))
  for (const field of ['choicesAcrossInstallerUpgradeVerified', 'draftPersistedAcrossQuitVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified', 'verifiedGithubReleaseReceiptForFixture', 'newlyInstalledTargetHealthyAtFirstConsent']) {
    assert.equal(report[field], false)
    assert.equal(source.includes(`report.${field} = true`), false)
  }
})

test('rejected or unbound launch attempts cannot vacuously qualify cleanup', () => {
  const unclaimed = { launchReturned: false, pid: null, bound: false, exited: false }
  const qualified = { launchReturned: true, launcherPid: 40, launcherExited: true, pid: 41, bound: true, exited: true }
  assert.equal(packageCleanupVerified([], 0, []), false)
  assert.equal(packageCleanupVerified([unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([qualified, unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, bound: false }], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, exited: false }], 0, []), false, 'CMD exit cannot certify Electron/Host exit')
  assert.equal(packageCleanupVerified([{ ...qualified, launcherExited: false }], 0, []), false, 'Native family exit cannot certify launch transport exit')
  assert.equal(packageCleanupVerified([{ ...qualified, launcherPid: null }], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, pid: 0 }], 0, []), false)
  assert.equal(packageCleanupVerified([qualified], 1, []), false)
  assert.equal(packageCleanupVerified([qualified], 0, ['exit unconfirmed']), false)
  assert.equal(packageCleanupVerified([qualified], 0, []), true)
  assert.ok(source.indexOf('shells.push(shellRecord)') < source.indexOf('._electron.launch('))
  assert.ok(source.includes('packageCleanupVerified(shells, children.size, cleanupErrors)'))
})

test('close and real evidence-write failures retain the original failure object', async t => {
  const root = directory(t)
  const primary = new Error('first application failure')
  const closeFailure = new Error('subsequent close failure')
  const secondary = []
  let current = primary
  try { await Promise.reject(closeFailure) }
  catch (error) { current = retainPrimaryFailure(current, error, 'owned-close', secondary) }
  try { writeFileSync(root, 'cannot replace a directory with receipt bytes') }
  catch (error) { current = retainPrimaryFailure(current, error, 'evidence-write', secondary) }
  assert.equal(current, primary)
  assert.deepEqual(secondary.map(item => item.stage), ['owned-close', 'evidence-write'])
  assert.equal(retainPrimaryFailure(undefined, closeFailure, 'only-failure', []), closeFailure)
  assert.ok(source.includes("retainError(error, 'package-acceptance-write')"))
  assert.ok(source.includes('retainPrimaryFailure(failure, error, stage, secondaryErrors, true)'))
  const installed = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(installed.includes("retainPrimaryFailure(roundFailure, error, 'round-owned-close'"))
  assert.ok(installed.includes("retainPrimaryFailure(roundFailure, error, 'round-failure-evidence-write'"))
  assert.ok(installed.includes('if (roundFailure !== undefined) throw roundFailure'))
})

function unitChildEvidence(result, elapsedMs, budgetMs) {
  const stderr = result.stderr ?? ''
  return {
    elapsedMs: Math.round(elapsedMs), budgetMs, pid: result.pid ?? null,
    errorCode: result.error?.code ?? null, errorMessage: result.error?.message?.slice(0, 512) ?? null,
    signal: result.signal, status: result.status,
    lastPhase: [...stderr.matchAll(/^\[fixture-phase:([a-z-]+)\]\r?$/gmu)].at(-1)?.[1] ?? 'no-script-marker-observed',
    stdoutTail: (result.stdout ?? '').slice(-2048), stderrTail: stderr.slice(-2048),
  }
}

function assertUnitChild(result, evidence) {
  const diagnostic = JSON.stringify(evidence)
  assert.equal(result.error, undefined, diagnostic)
  assert.equal(result.signal, null, diagnostic)
  assert.equal(result.status, 0, diagnostic)
}

test('unit child diagnostics cannot accept a timeout with zero status or hide assertion-phase failures', () => {
  const result = { error: { code: 'ETIMEDOUT', message: 'deadline' }, signal: null, status: 0, stderr: '[fixture-phase:mock-setup-complete]\n' + 'x'.repeat(10_000) }
  const evidence = unitChildEvidence(result, 30_001, 30_000)
  assert.equal(evidence.lastPhase, 'mock-setup-complete')
  assert.equal(evidence.errorCode, 'ETIMEDOUT')
  assert.equal(evidence.status, 0)
  assert.equal(evidence.stderrTail.length, 2048)
  assert.throws(() => assertUnitChild(result, evidence), /ETIMEDOUT/u)
  const failed = { signal: null, status: 1, stderr: '[fixture-phase:assertions-start]\nassertion failed' }
  assert.throws(() => assertUnitChild(failed, unitChildEvidence(failed, 1, 10)), /assertions-start/u)
  const signalled = { signal: 'SIGTERM', status: null }
  assert.throws(() => assertUnitChild(signalled, unitChildEvidence(signalled, 1, 10)), /SIGTERM/u)
  assert.equal(unitChildEvidence(signalled, 1, 10).lastPhase, 'no-script-marker-observed')
  assert.equal(unitChildEvidence({ stderr: 'parser echo: [fixture-phase:assertions-start]' }, 1, 10).lastPhase, 'no-script-marker-observed')
})

/** Run extracted helper code against owned test inputs; never load the driver entrypoint or application. */
function powershellUnit(t, body, shell = 'pwsh', { timeout = 15_000, phases = false } = {}) {
  const root = directory(t)
  const script = join(root, 'pure-unit.ps1')
  writeFileSync(script, "$ErrorActionPreference = 'Stop'\n"
    + (phases ? "[Console]::Error.WriteLine('[fixture-phase:script-start]')\n" : '') + body
    + (phases ? "\n[Console]::Error.WriteLine('[fixture-phase:script-complete]')\n" : ''))
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase()))), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }
  const started = performance.now()
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', env, timeout })
  const evidence = unitChildEvidence(result, performance.now() - started, timeout)
  assertUnitChild(result, evidence)
  if (phases) {
    assert.equal(evidence.lastPhase, 'script-complete', JSON.stringify(evidence))
    t.diagnostic(`Pure unit subprocess: ${JSON.stringify(evidence)}`)
  }
  return JSON.parse(result.stdout.trim())
}

test('package observer binds the observed Electron PID before native actions and retains transport ownership separately', () => {
  const launch = source.slice(source.indexOf('  const launch = async label => {'), source.indexOf('  const openNativeMenu'))
  assert.ok(launch.indexOf('app.evaluate(inspectInstalledDesktopIdentity)') < launch.indexOf("await native('Bind')"))
  assert.ok(launch.indexOf('assert.equal(identity.version, expected.version)') < launch.indexOf("await native('Bind')"))
  assert.ok(launch.includes('const processIds = installedDesktopProcessIds(launcher, identity, process.pid)'))
  assert.ok(launch.includes('boundPid = processIds.pid'))
  assert.doesNotMatch(source, /boundPid = app\.process\(\)\.pid/u)
  assert.ok(source.includes("'-LauncherPid', String(launcherPid)"))
  assert.ok(source.includes('const records = shells.filter(shell => shell.pid === pid)'))
  assert.ok(source.includes('launchers.set(shellRecord.launchId, launcher)'))
  assert.ok(source.includes('assert.equal(recorded.launcher.pid, shellRecord.launcherPid)'))
  assert.ok(source.includes("await native('StopOwned', shell.pid)"))
  assert.ok(source.includes("await native('VerifyExited', shell.pid)"))
  assert.ok(source.includes('const launcher = launchers.get(shell.launchId)'))
  assert.ok(source.includes('shell.launcherExited = installedLauncherExited(launcher)'))
  assert.ok(native.includes('Assert-DesktopLaunchLineage $fixture $launcher $shell $application'))
  assert.ok(native.includes("(Join-Path ([Environment]::SystemDirectory) 'cmd.exe')"))
  assert.ok(native.includes('launcher = (Identity $launcher)'))
  assert.ok(native.includes('$binding.launcher.pid -ne $LauncherPid'))
  assert.ok(native.includes('Same-Identity $launcher $binding.launcher'))
  assert.ok(native.includes('Same-Identity (Read-Process $LauncherPid) $binding.launcher'))
  assert.ok(native.includes("throw 'Owned launch transport remains live; exit is not verified'"))
})

test('owned standard-provider phase diagnostics cover each operation without qualifying timeout or truncated output', () => {
  const file = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = file.indexOf("\ntest('native helper initializes standard providers for owned classic Win32 controls',")
  const end = file.indexOf("test(", start + 5)
  const ownerTest = file.slice(start, end)
  const owner = nativeProviderUnitScript()
  assert(start > 0 && end > start)
  const groups = ['assembly-load', 'interop-declare', 'owned-windows-create', 'negative-observation',
    'native-initialize', 'positive-observation', 'foreign-owner-refusal', 'owned-windows-cleanup']
  const phases = groups.flatMap(group => [`${group}-start`, `${group}-done`])
  assert.deepEqual([...owner.matchAll(/\[fixture-phase:([a-z-]+)\]/gu)].map(match => match[1]), phases)
  const operations = ['Add-Type -AssemblyName UIAutomationClient', '$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly',
    '$window = New-OwnedControl', '$before = @(Observe-Control', '\n    Initialize-Native\n',
    '$after = @(Observe-Control', 'try { Invoke-Control', 'for ($i=$handles.Count-1;']
  groups.forEach((group, index) => {
    const before = owner.indexOf(`[fixture-phase:${group}-start]`), operation = owner.indexOf(operations[index])
    const after = owner.indexOf(`[fixture-phase:${group}-done]`)
    assert(before >= 0 && before < operation && operation < after, group)
  })
  assert.match(ownerTest, /powershell\.exe'\), \{ phases: true \}\)/u)
  assert(!ownerTest.includes('timeout:')) // Keep the helper's existing 15-second budget.
  const wrapper = file.slice(file.indexOf('function powershellUnit('), file.indexOf("test('package observer binds"))
  assert.match(wrapper, /timeout = 15_000, phases = false/u)
  assert(wrapper.indexOf('fixture-phase:script-start') < wrapper.indexOf("+ body"))
  assert(wrapper.indexOf('fixture-phase:script-complete') > wrapper.indexOf("+ body"))
  const stderr = phases.map(phase => `[fixture-phase:${phase}]\r\n`).join('') + 'x'.repeat(4096)
  const evidence = unitChildEvidence({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: 0,
    stdout: 'y'.repeat(4096), stderr }, 15_111, 15_000)
  assert.equal(evidence.lastPhase, 'owned-windows-cleanup-done')
  assert.equal(evidence.stderrTail.length, 2048)
  assert.equal(evidence.stdoutTail.length, 2048)
  assert(!evidence.stderrTail.includes('[fixture-phase:'))
  assert.throws(() => assertUnitChild({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: 0 }, evidence), /ETIMEDOUT/u)
  for (const phase of phases) assert.equal(unitChildEvidence({ stderr: `[fixture-phase:${phase}]\r\n`, signal: null, status: 1 }, 1, 15_000).lastPhase, phase)
  assert.match(owner, /try \{ \[Console\]::Error\.WriteLine\('\[fixture-phase:owned-windows-cleanup-start\]'\) \} catch/u)
  assert.match(owner, /try \{ \[Console\]::Error\.WriteLine\('\[fixture-phase:owned-windows-cleanup-done\]'\) \} catch/u)
})

test('owned provider fixture declares only fixed in-process Win32 interop and preserves cold production initialization', () => {
  const body = nativeProviderUnitScript()
  const initialize = native.match(/function Initialize-Native \{[^]*?\$script:nativeReady = \$true\r?\n\}/u)?.[0]
  const invoke = native.match(/function Invoke-Control\(\$Node\) \{[^]*?\r?\n\}/u)?.[0]
  assert.ok(initialize && invoke)
  assert.equal(body.match(/function Initialize-Native \{[^]*?\$script:nativeReady = \$true\r?\n\}/u)?.[0], initialize)
  assert.equal(body.match(/function Invoke-Control\(\$Node\) \{[^]*?\r?\n\}/u)?.[0], invoke)
  assert.equal(body.split(initialize).length, 2)
  const fixture = body.replace(initialize, '').replace(invoke, '')
  assert.doesNotMatch(fixture, /Add-Type\s+-(?:TypeDefinition|MemberDefinition|Path)|CSharpCodeProvider|csc\.exe|Start-Process|System\.Windows\.Forms|RegisterClientSideProviderAssembly|\.Invoke\(/iu)
  assert.equal((fixture.match(/DefinePInvokeMethod\(/gu) ?? []).length, 1)
  const declarations = fixture.slice(fixture.indexOf('$declarations = @('), fixture.indexOf('foreach ($entry in $declarations)'))
  assert.deepEqual([...declarations.matchAll(/name='([^']+)'/gu)].map(match => match[1]),
    ['CreateWindowExW', 'DestroyWindow', 'IsWindow', 'GetWindowThreadProcessId'])
  for (const literal of [
    "name='CreateWindowExW'; result=[IntPtr]; parameters=[type[]]@([uint32],[string],[string],[uint32],[int],[int],[int],[int],[IntPtr],[IntPtr],[IntPtr],[IntPtr])",
    "name='DestroyWindow'; result=[bool]; parameters=[type[]]@([IntPtr])",
    "name='IsWindow'; result=[bool]; parameters=[type[]]@([IntPtr])",
    "name='GetWindowThreadProcessId'; result=[uint32]; parameters=[type[]]@([IntPtr],[uint32].MakeByRefType())",
    "$entry.name, 'user32.dll', $entry.name", '[Reflection.Emit.AssemblyBuilderAccess]::Run',
    '[Runtime.InteropServices.CallingConvention]::Winapi', '[Runtime.InteropServices.CharSet]::Unicode',
    '[Reflection.MethodImplAttributes]::PreserveSig', '[Runtime.InteropServices.UnmanagedType]::Bool',
    "$method.DefineParameter(2, [Reflection.ParameterAttributes]::Out, 'process')",
    '[uint32]2415919104', '[uint32]1342177280', 'CreateWindowExW([uint32]134217728',
    'GetWindowThreadProcessId($Handle, [ref]$owner)', 'IsWindow($Handle) -and $owner -eq [uint32]$OwnerPid',
    "New-OwnedControl '#32770' 'Owned synthetic folder picker' ([IntPtr]::Zero) 0",
    "New-OwnedControl 'Edit' 'owned-path' $window 1152", "New-OwnedControl 'Button' 'Select Folder' $window 1",
  ]) assert(fixture.includes(literal), literal)
  const call = fixture.indexOf('\n    Initialize-Native\n')
  assert.equal((fixture.match(/^    Initialize-Native$/gmu) ?? []).length, 1)
  assert(fixture.indexOf("throw 'The isolated provider-omission negative control no longer reproduces'") < call)
  assert(call < fixture.indexOf('$after = @(Observe-Control'))
  assert(fixture.indexOf('for ($i=$handles.Count-1;') < fixture.indexOf('DestroyWindow($handles[$i])'))
})

function nativeProviderUnitScript() {
  const initialize = native.match(/function Initialize-Native \{[^]*?\$script:nativeReady = \$true\r?\n\}/u)?.[0]
  const invoke = native.match(/function Invoke-Control\(\$Node\) \{[^]*?\r?\n\}/u)?.[0]
  assert.ok(initialize && invoke)
  assert.ok(initialize.includes('RegisterClientSideProviderAssembly'))
  return `
[Console]::Error.WriteLine('[fixture-phase:assembly-load-start]')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
[Console]::Error.WriteLine('[fixture-phase:assembly-load-done]')
${initialize}
${invoke}
[Console]::Error.WriteLine('[fixture-phase:interop-declare-start]')
# Declare only the fixed fixture Win32 entrypoints in memory; no C# compiler or helper process.
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OwnedNativeControls'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('OwnedNativeControls')
$type = $module.DefineType('OwnedNativeControls', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
$declarations = @(
    @{ name='CreateWindowExW'; result=[IntPtr]; parameters=[type[]]@([uint32],[string],[string],[uint32],[int],[int],[int],[int],[IntPtr],[IntPtr],[IntPtr],[IntPtr]) },
    @{ name='DestroyWindow'; result=[bool]; parameters=[type[]]@([IntPtr]) },
    @{ name='IsWindow'; result=[bool]; parameters=[type[]]@([IntPtr]) },
    @{ name='GetWindowThreadProcessId'; result=[uint32]; parameters=[type[]]@([IntPtr],[uint32].MakeByRefType()) }
)
foreach ($entry in $declarations) {
    $method = $type.DefinePInvokeMethod($entry.name, 'user32.dll', $entry.name,
        [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
        $entry.result, $entry.parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    if ($entry.result -eq [bool]) {
        $return = $method.DefineParameter(0, [Reflection.ParameterAttributes]::Retval, $null)
        $marshal = [Reflection.Emit.CustomAttributeBuilder]::new(
            [Runtime.InteropServices.MarshalAsAttribute].GetConstructor([type[]]@([Runtime.InteropServices.UnmanagedType])),
            [object[]]@([Runtime.InteropServices.UnmanagedType]::Bool))
        $return.SetCustomAttribute($marshal)
    }
    if ($entry.name -eq 'GetWindowThreadProcessId') { $null = $method.DefineParameter(2, [Reflection.ParameterAttributes]::Out, 'process') }
}
$script:ownedNative = $type.CreateType()
function New-OwnedControl([string]$Kind, [string]$Text, [IntPtr]$Parent, [int]$Id) {
    $style = if ($Parent -eq [IntPtr]::Zero) { [uint32]2415919104 } else { [uint32]1342177280 } # 0x90000000 / 0x50000000
    $position = if ($Parent -eq [IntPtr]::Zero) { -30000 } else { 10 }
    $handle = $script:ownedNative::CreateWindowExW([uint32]134217728, $Kind, $Text, $style,
        $position, $position, 320, 120, $Parent, [IntPtr]$Id, [IntPtr]::Zero, [IntPtr]::Zero) # 0x08000000
    if ($handle -eq [IntPtr]::Zero) { throw 'Owned native test window creation failed' }
    return $handle
}
function Test-OwnedControl([IntPtr]$Handle, [int]$OwnerPid) {
    [uint32]$owner = 0
    $null = $script:ownedNative::GetWindowThreadProcessId($Handle, [ref]$owner)
    return $script:ownedNative::IsWindow($Handle) -and $owner -eq [uint32]$OwnerPid
}
[Console]::Error.WriteLine('[fixture-phase:interop-declare-done]')
$handles = [Collections.Generic.List[IntPtr]]::new()
$primary = $null
$cleanupErrors = [Collections.Generic.List[Exception]]::new()
function Observe-Control([IntPtr]$Handle) {
    if (-not (Test-OwnedControl $Handle $PID)) { throw 'Foreign native test handle' }
    $node = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
    if ($node.Current.ProcessId -ne $PID) { throw 'Foreign UIA test owner' }
    $value = $null; $invokePattern = $null
    [pscustomobject]@{ type=$node.Current.ControlType.ProgrammaticName; id=$node.Current.AutomationId;
        value=$node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value);
        invoke=$node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invokePattern) }
}
try {
    [Console]::Error.WriteLine('[fixture-phase:owned-windows-create-start]')
    $window = New-OwnedControl '#32770' 'Owned synthetic folder picker' ([IntPtr]::Zero) 0; $handles.Add($window)
    $edit = New-OwnedControl 'Edit' 'owned-path' $window 1152; $handles.Add($edit)
    $button = New-OwnedControl 'Button' 'Select Folder' $window 1; $handles.Add($button)
    [Console]::Error.WriteLine('[fixture-phase:owned-windows-create-done]')
    # Negative control: the exact former assembly-only setup cannot supply classic providers.
    [Console]::Error.WriteLine('[fixture-phase:negative-observation-start]')
    $before = @(Observe-Control $edit; Observe-Control $button)
    if ($before[0].type -ne 'ControlType.Pane' -or $before[0].value -or $before[1].type -ne 'ControlType.Pane' -or $before[1].invoke) {
        throw 'The isolated provider-omission negative control no longer reproduces'
    }
    [Console]::Error.WriteLine('[fixture-phase:negative-observation-done]')
    [Console]::Error.WriteLine('[fixture-phase:native-initialize-start]')
    Initialize-Native
    if (-not $nativeReady) { throw 'Actual native initialization did not finish' }
    [Console]::Error.WriteLine('[fixture-phase:native-initialize-done]')
    [Console]::Error.WriteLine('[fixture-phase:positive-observation-start]')
    $after = @(Observe-Control $edit; Observe-Control $button)
    if ($after[0].type -ne 'ControlType.Edit' -or -not $after[0].value -or $after[1].type -ne 'ControlType.Button' -or -not $after[1].invoke) {
        throw 'Actual helper did not initialize actionable standard control providers'
    }
    [Console]::Error.WriteLine('[fixture-phase:positive-observation-done]')
    # Execute the actual owner rejection before its InvokePattern call. Never invoke any control.
    [Console]::Error.WriteLine('[fixture-phase:foreign-owner-refusal-start]')
    $ShellPid = $PID + 1
    $foreign = $null
    try { Invoke-Control ([System.Windows.Automation.AutomationElement]::FromHandle($button)) } catch { $foreign = $_ }
    if ($null -eq $foreign -or $foreign.Exception.Message -notmatch 'enabled and owned') { throw 'Foreign control owner was not refused' }
    [Console]::Error.WriteLine('[fixture-phase:foreign-owner-refusal-done]')
} catch { $primary = $_ } finally {
    try { [Console]::Error.WriteLine('[fixture-phase:owned-windows-cleanup-start]') } catch { # Diagnostics cannot bypass owned cleanup or replace its primary error.
    }
    for ($i=$handles.Count-1;$i -ge 0;$i--) {
        if ($script:ownedNative::IsWindow($handles[$i]) -and -not $script:ownedNative::DestroyWindow($handles[$i])) {
            $cleanupErrors.Add([InvalidOperationException]::new('Owned native test window destruction failed'))
        }
    }
    foreach ($handle in $handles) {
        if ($script:ownedNative::IsWindow($handle)) { $cleanupErrors.Add([InvalidOperationException]::new('Owned native test handle survived cleanup')) }
    }
    try { [Console]::Error.WriteLine('[fixture-phase:owned-windows-cleanup-done]') } catch { # Existing primary and cleanup failures remain authoritative.
    }
}
if ($null -ne $primary) {
    if ($cleanupErrors.Count -eq 0) { throw $primary }
    $failures = [Collections.Generic.List[Exception]]::new(); $failures.Add($primary.Exception)
    foreach ($error in $cleanupErrors) { $failures.Add($error) }
    throw [AggregateException]::new('Native test and cleanup failed', $failures.ToArray())
}
if ($cleanupErrors.Count -gt 0) { throw [AggregateException]::new('Native test cleanup failed', $cleanupErrors.ToArray()) }
[pscustomobject]@{ before=$before; after=$after; foreignRejected=$true; cleanupVerified=$true; appLaunched=$false; invoked=$false } | ConvertTo-Json -Depth 4 -Compress
`
}

test('native helper initializes standard providers for owned classic Win32 controls', { skip: process.platform !== 'win32' }, t => {
  const observed = powershellUnit(t, nativeProviderUnitScript(),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), { phases: true })
  assert.deepEqual(observed.before, [
    { type: 'ControlType.Pane', id: '1152', value: false, invoke: false },
    { type: 'ControlType.Pane', id: '1', value: false, invoke: false },
  ])
  assert.deepEqual(observed.after, [
    { type: 'ControlType.Edit', id: '1152', value: true, invoke: false },
    { type: 'ControlType.Button', id: '1', value: false, invoke: true },
  ])
  assert.equal(observed.foreignRejected, true)
  assert.equal(observed.cleanupVerified, true)
  assert.equal(observed.appLaunched, false)
  assert.equal(observed.invoked, false)
})

test('native launch lineage admits only the retained CMD chain or exact direct-child launch', { skip: process.platform !== 'win32' }, t => {
  const helper = native.match(/function Assert-DesktopLaunchLineage[^]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `
${helper}
function Changed($Record, $Field, $Value) { $copy = $Record.PSObject.Copy(); $copy.$Field = $Value; return $copy }
$application = 'C:/owned/cloga-deepseek-harness.exe'
$command = 'C:/Windows/System32/cmd.exe'
$time = [datetime]'2026-01-01T00:00:00Z'
$fixture = [pscustomobject]@{ ProcessId = 101; ParentProcessId = 1; CreationDate = $time; SessionId = 7; ExecutablePath = 'C:/node.exe' }
$launcher = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; CreationDate = $time.AddSeconds(1); SessionId = 7; ExecutablePath = $command }
$shell = [pscustomobject]@{ ProcessId = 303; ParentProcessId = 202; CreationDate = $time.AddSeconds(2); SessionId = 7; ExecutablePath = $application }
$direct = Changed $shell 'ParentProcessId' 101
Assert-DesktopLaunchLineage $fixture $launcher $shell $application $command
Assert-DesktopLaunchLineage $fixture $direct $direct $application $command
$cases = @(
    @{ label = 'missing-launcher'; launcher = $null; shell = $shell },
    @{ label = 'fixture-as-launcher'; launcher = $fixture; shell = $shell },
    @{ label = 'wrong-launcher-parent'; launcher = (Changed $launcher 'ParentProcessId' 999); shell = $shell },
    @{ label = 'wrong-main-parent'; launcher = $launcher; shell = (Changed $shell 'ParentProcessId' 999) },
    @{ label = 'foreign-command-interpreter'; launcher = (Changed $launcher 'ExecutablePath' 'C:/foreign/cmd.exe'); shell = $shell },
    @{ label = 'foreign-main-executable'; launcher = $launcher; shell = (Changed $shell 'ExecutablePath' ($application + '.other')) },
    @{ label = 'launcher-predates-fixture'; launcher = (Changed $launcher 'CreationDate' $time.AddSeconds(-1)); shell = $shell },
    @{ label = 'main-predates-launcher'; launcher = $launcher; shell = (Changed $shell 'CreationDate' $time) },
    @{ label = 'launcher-foreign-session'; launcher = (Changed $launcher 'SessionId' 9); shell = $shell },
    @{ label = 'main-foreign-session'; launcher = $launcher; shell = (Changed $shell 'SessionId' 9) },
    @{ label = 'direct-incarnation-mismatch'; launcher = $direct; shell = (Changed $direct 'CreationDate' $time.AddSeconds(3)) },
    @{ label = 'direct-parent-mismatch'; launcher = $direct; shell = $shell }
)
$rejected = @()
foreach ($case in $cases) {
    $failure = $null
    try { Assert-DesktopLaunchLineage $fixture $case.launcher $case.shell $application $command } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted foreign lineage: ' + $case.label) }
    $rejected += $case.label
}
[pscustomobject]@{ accepted = @('cmd-chain', 'direct-child'); rejected = $rejected } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed.accepted, ['cmd-chain', 'direct-child'])
  assert.deepEqual(observed.rejected, [
    'missing-launcher', 'fixture-as-launcher', 'wrong-launcher-parent', 'wrong-main-parent', 'foreign-command-interpreter',
    'foreign-main-executable', 'launcher-predates-fixture', 'main-predates-launcher', 'launcher-foreign-session',
    'main-foreign-session', 'direct-incarnation-mismatch', 'direct-parent-mismatch',
  ])
})

test('native incarnation comparison rejects a reused launcher PID without touching any real process', { skip: process.platform !== 'win32' }, t => {
  const helper = native.match(/function Same-Identity[^]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `
${helper}
$started = [datetime]'2026-01-01T00:00:01Z'
$image = 'C:/Windows/System32/cmd.exe'
$disposed = 0
function Get-Process {
    $handle = [pscustomobject]@{ Handle = 1; StartTime = $script:started; Path = $script:image }
    $handle | Add-Member ScriptMethod Dispose { $script:disposed++ }
    return $handle
}
$actual = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $image }
$expected = [pscustomobject]@{ pid = 202; parentPid = 101; executable = $image; created = $started.ToUniversalTime().ToString('o') }
$matched = Same-Identity $actual $expected
$started = $started.AddSeconds(2)
$reused = Same-Identity $actual $expected
$started = [datetime]$expected.created
$image = 'C:/foreign/cmd.exe'
$foreign = Same-Identity $actual $expected
[pscustomobject]@{ matched = $matched; reused = $reused; foreign = $foreign; disposed = $disposed } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, { matched: true, reused: false, foreign: false, disposed: 3 })
})

test('native exit verification requires both transport and actual main exit without adopting reused PIDs', { skip: process.platform !== 'win32' }, t => {
  const same = native.match(/function Same-Identity[^]*?\r?\n\}/u)?.[0]
  const body = native.split("if ($Action -eq 'VerifyExited') {")[1].split("    } elseif ($Action -eq 'StopOwned')")[0]
  assert.ok(same && body)
  // Match the native driver's Windows PowerShell edition: Core auto-converts ISO JSON strings to DateTime.
  // This one hosted 15s total-process guard expired before phase evidence existed. Allow 30s for
  // fresh PowerShell/mock setup; this is not an installed-process exit or UI performance deadline.
  const observed = powershellUnit(t, `
${same}
function Verify-Exit {
${body}
    return $result
}
function Read-Process($ProcessId) { return $script:processes[[int]$ProcessId] }
function Get-CimInstance { return @($script:processes.Values) }
function Get-Process($Id) {
    $value = Read-Process $Id
    if ($null -eq $value) { return $null }
    $handle = [pscustomobject]@{ Handle = 1; StartTime = $value.Started; Path = $value.ExecutablePath }
    $handle | Add-Member ScriptMethod Dispose {}
    return $handle
}
$OwnerToken = 'unit-owner'
$LauncherPid = 202
$application = Join-Path $PSScriptRoot 'app.exe'
$time = [datetime]'2026-01-01T00:00:01Z'
$command = 'C:/Windows/System32/cmd.exe'
$binding = [pscustomobject]@{ launcher = [pscustomobject]@{ pid = 202; parentPid = 101; executable = $command; created = $time.ToUniversalTime().ToString('o') } }
$familyPath = Join-Path $PSScriptRoot 'family.json'
@{ ownerToken = $OwnerToken; completeObservation = $true; processes = @(@{ pid = 303; parentPid = 202; executable = $application; created = $time.AddSeconds(1).ToUniversalTime().ToString('o') }) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $familyPath
[Console]::Error.WriteLine('[fixture-phase:mock-setup-complete]')
[Console]::Error.WriteLine('[fixture-phase:assertions-start]')
$rejected = @()
foreach ($case in @('transport-live', 'main-live')) {
    $processes = if ($case -eq 'transport-live') { @{ 202 = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $command; Started = $time } } }
        else { @{ 303 = [pscustomobject]@{ ProcessId = 303; ParentProcessId = 202; ExecutablePath = $application; Started = $time.AddSeconds(1) } } }
    $failure = $null
    try { [void](Verify-Exit) } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.Message -notmatch 'remains live') { throw ('Exit incorrectly admitted: ' + $case + ': ' + $failure) }
    $rejected += $case
}
$processes = @{}
$gone = Verify-Exit
$processes = @{ 202 = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $command; Started = $time.AddSeconds(10); CreationDate = $time.AddSeconds(10) } }
$reused = Verify-Exit
[pscustomobject]@{ rejected = $rejected; gone = $gone.ownedFamilyExited; reused = $reused.ownedFamilyExited } | ConvertTo-Json -Compress
`, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), { timeout: 30_000, phases: true })
  assert.deepEqual(observed, { rejected: ['transport-live', 'main-live'], gone: true, reused: true })
})

test('Windows pure reaper covers late cleanup handles and rejects WaitForExit false', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const helper = driver.match(/function Stop-OwnedProcesses \{[\s\S]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `${helper}\n
$handles = [Collections.Generic.List[object]]::new()
$messages = [Collections.Generic.List[string]]::new()
if (-not (Stop-OwnedProcesses $handles $messages)) { throw 'Empty first pass failed' }
$late = [pscustomobject]@{ HasExited = $false; KillCalls = 0; WaitCalls = 0 }
$late | Add-Member ScriptMethod Kill { param($Tree); $this.KillCalls++ }
$late | Add-Member ScriptMethod WaitForExit { param($Milliseconds); $this.WaitCalls++; return $false }
$handles.Add($late)
$stopped = Stop-OwnedProcesses $handles $messages
@{ stopped = $stopped; kills = $late.KillCalls; waits = $late.WaitCalls; errors = @($messages) } | ConvertTo-Json -Compress
`)
  assert.equal(observed.stopped, false)
  assert.equal(observed.kills, 1)
  assert.equal(observed.waits, 1)
  assert.match(observed.errors[0], /did not exit/)
  assert.ok(driver.lastIndexOf('Stop-OwnedProcesses $processes $cleanupErrors') > driver.indexOf('Wait-Exit (Start-Fixture cleanup)'))
  assert.ok(driver.lastIndexOf('Stop-OwnedProcesses $processes $cleanupErrors') < driver.indexOf('try { $process.Dispose() }'))
})

test('Windows native failure evidence write cannot replace its primary error', { skip: process.platform !== 'win32' }, t => {
  const normalized = native.replaceAll('\r\n', '\n')
  const marker = '} catch {\n    $primaryFailure = $_'
  const start = normalized.lastIndexOf(marker)
  assert.ok(start >= 0)
  const body = normalized.slice(start + '} catch {\n'.length, normalized.lastIndexOf('\n}'))
  const observed = powershellUnit(t, `
$nativeReady = $false
$resultPath = $PSScriptRoot
$OwnerToken = 'unit-owner'
$RequestId = 'unit-request'
$Action = 'unit-only'
try {
    try { throw 'primary native action failure' } catch {
${body}
    }
} catch {
    @{ primary = $_.Exception.Message; secondary = @($secondaryErrors) } | ConvertTo-Json -Compress
}
`)
  assert.equal(observed.primary, 'primary native action failure')
  assert.equal(observed.secondary.length, 1)
  assert.match(observed.secondary[0], /Native failure evidence write failed/)
})

test('Windows outer receipt failure preserves an existing error and promotes only when none exists', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const start = driver.lastIndexOf('    try {\n        [ordered]@{')
  assert.ok(start >= 0)
  const receipt = driver.slice(start, driver.lastIndexOf('\n}'))
  const observed = powershellUnit(t, `
$root = $PSScriptRoot
$ExpectedSourceCommit = 'unit-source'
$installPath = 'unit-only'
$success = $false
$packageAcceptanceSuccess = $false
$cleanupErrors = [Collections.Generic.List[string]]::new()
$secondaryErrors = [Collections.Generic.List[string]]::new()
try { throw 'original installer failure' } catch { $original = $_ }
$failure = $original
${receipt}
$preserved = [object]::ReferenceEquals($failure, $original)
$firstSecondary = @($secondaryErrors)
$failure = $null
$secondaryErrors.Clear()
${receipt}
@{ preserved = $preserved; firstSecondary = $firstSecondary; promoted = ($null -ne $failure); secondSecondary = @($secondaryErrors) } | ConvertTo-Json -Compress
`)
  assert.equal(observed.preserved, true)
  assert.equal(observed.promoted, true)
  assert.equal(observed.firstSecondary.length, 1)
  assert.equal(observed.secondSecondary.length, 1)
  assert.match(observed.firstSecondary[0], /Installer acceptance evidence write failed/)
})

test('removed package absence waits for a retained running inventory witness', () => {
  const removal = source.slice(source.indexOf("await launch('removed-copilot')"))
  const absence = removal.indexOf('assert.equal(await copilot().count(), 0)')
  assert.ok(absence > 0)
  for (const witness of ["retainedFixture.waitFor({ state: 'visible' })", "getByText('Running'", "removedPanel.getByRole('alert')", "name: 'Back to plugins'"]) {
    assert.ok(removal.indexOf(witness) >= 0 && removal.indexOf(witness) < absence, witness)
  }
})

test('prepared notice requires one exact transaction identity', () => {
  const notice = `@fixture/bundle: Transaction ${id} is staged privately. Active plugins are unchanged.`
  assert.equal(preparedTransactionId(notice), id)
  for (const text of ['', id, `Transaction ../${id} is staged privately.`, notice + notice, notice.replace(id, id.toUpperCase().replace('1', 'A'))]) {
    assert.throws(() => preparedTransactionId(text))
  }
})

test('graph reader hashes exact metadata, payload bytes and link spellings without following links', t => {
  const root = directory(t)
  const profile = join(root, 'profile')
  const external = join(root, 'runtime')
  mkdirSync(profile)
  mkdirSync(external)
  writeFileSync(join(profile, 'package.json'), '{"private":true}\n')
  writeFileSync(join(external, 'external.js'), 'outside\n')
  symlinkSync(external, join(profile, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  const first = packageGraphSnapshot(profile)
  assert.equal(first.fingerprint, digest(JSON.stringify(first.entries)))
  assert.equal(first.entries.length, 2)
  assert.equal(first.entries[1].kind, 'link')
  writeFileSync(join(external, 'external.js'), 'external changes do not mutate the link spelling\n')
  assert.deepEqual(packageGraphSnapshot(profile), first)
  writeFileSync(join(profile, 'package.json'), '{"private":false}\n')
  assert.notEqual(packageGraphSnapshot(profile).fingerprint, first.fingerprint)
  assert.throws(() => packageGraphSnapshot(join(profile, 'shared')))
})

test('a process generation needs creation time and executable as well as PID', () => {
  const observed = { pid: 41, parentPid: 20, created: '2026-01-01T00:00:00.0000000Z', executable: 'C:\\owned\\desktop.exe' }
  assert.equal(sameProcess(observed, { ...observed, executable: observed.executable.toUpperCase() }), true)
  for (const change of [{ pid: 42 }, { created: '2026-01-01T00:00:01.0000000Z' }, { executable: 'C:\\other.exe' }]) {
    assert.equal(sameProcess(observed, { ...observed, ...change }), false)
  }
  assert.equal(sameProcess(undefined, observed), false)
})

test('only the unchanged private fixture package with no lifecycle or dependency fields is admitted', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../web/tests/fixtures/plugins/fixture-bundle/package.json', import.meta.url), 'utf8'))
  assert.doesNotThrow(() => validatePackageFixture(manifest))
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => validatePackageFixture({ ...manifest, [field]: {} }))
  }
  assert.throws(() => validatePackageFixture({ ...manifest, private: false }))
  assert.throws(() => validatePackageFixture({ ...manifest, name: 'dsh-github-copilot' }))
  assert.throws(() => validatePackageFixture({ ...manifest, version: '0.0.2' }))
})

test('standalone fixture refuses workstation execution before filesystem setup or browser imports', () => {
  const entry = fileURLToPath(new URL('./fixtures/windows-packaged-package-acceptance.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' }, timeout: 10_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Installer qualification (?:requires Windows|is GitHub-only)/)
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  assert.ok(run.indexOf('assertUpgradeRunner(process.env)') < run.indexOf('mkdirSync(directory)'))
  assert.ok(run.indexOf('assertUpgradeRunner(process.env)') < run.indexOf("import('playwright')"))
})

test('native helper checks hosted ownership before accessibility loading and uses owned controls only', () => {
  assert.ok(native.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'") < native.indexOf('Get-Content -LiteralPath'))
  assert.ok(native.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'") < native.indexOf('Add-Type'))
  for (const required of ['Same-Identity', '$handle.StartTime', '$handle.Handle', 'GetWindowThreadProcessId', '$node.Current.ProcessId -eq $ShellPid', 'InvokePattern', 'ValuePattern', "Wait-Control 'Select Folder'", 'skippedReusedPids', 'package-native-$RequestId', 'accessibility = $tree', '$fresh.CreationDate -ne $Process.CreationDate', 'Identity $item -AllowExited', 'completeObservation = $false', 'postExitProcessScanPassed = $true']) assert.ok(native.includes(required), required)
  assert.doesNotMatch(native, /SendKeys|SendInput|SetForegroundWindow|Stop-Process\s+-Name|taskkill|ExecutionPolicy|dialog\.showOpenDialog\s*=/iu)
  const actions = native.match(/ValidateSet\(([^)]+)\)/u)?.[1]
  assert.equal(actions, "'Bind','Observe','ReviewPackages','ChooseWorkspace','Exit','VerifyExited','StopOwned'")
})

test('scenario keeps real native actions, real shell consent, provider-zero-call and two-step health observations', () => {
  for (const required of ["native('ChooseWorkspace')", "openNativeMenu('ReviewPackages')", "openNativeMenu('Exit')", "name: 'Activate and restart Host'", "name: 'Update later'", "name: 'Create provider'", "mockServer([])", 'assert.equal(mock.requests.length, 0', 'firstPrepared.value.mutation.enabled, false', "getByText('Running'", 'candidateFingerprint', 'DISCARDED.json']) assert.ok(source.includes(required), required)
  assert.doesNotMatch(source, /remote\.pluginManager|ipcRenderer\.(?:send|invoke)|\.reportImpact\(|showMessageBox\s*=|showOpenDialog\s*=|MenuItem|addInitScript|\.route\(/u)
  assert.ok(source.indexOf('report.installedDisabledAfterConsentVerified = true') < source.indexOf('report.enabledFixtureRunningAfterSeparateRestartVerified = true'))
  assert.ok(source.includes("assert.equal(children.size, 0, 'A previous native helper has not acknowledged exit')"))
  assert.ok(source.includes('timed out and its exit was acknowledged'))
  const cleanup = source.slice(source.indexOf('    const cleanupErrors = []'))
  assert.ok(cleanup.indexOf("native('Observe')") < cleanup.indexOf('await app.close()'))
  assert.ok(cleanup.includes('if (children.size === 0)'))
})

test('installed driver runs the separately scoped case before uninstall and retains unverified installer flags', () => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const fixture = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(driver.indexOf('Start-Fixture candidate') < driver.indexOf('Start-Fixture package'))
  assert.ok(driver.indexOf('Start-Fixture package') < driver.indexOf('Start-Owned $uninstallerCopy.Path'))
  assert.ok(driver.includes('separateSameVersionPackagedPluginAcceptanceVerified = $packageAcceptanceSuccess'))
  assert.ok(driver.includes('Package process cleanup is unconfirmed; retain installation and profiles for VM teardown'))
  assert.ok(driver.indexOf('$packageCleanup.cleanupVerified') < driver.indexOf('Start-Owned $uninstallerCopy.Path'))
  for (const field of ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'managedHandoffVerified']) assert.ok(driver.includes(`${field} = $false`))
  for (const name of ['package-home', 'package-electron-user-data', 'package-workspace', 'package-fixture-data']) assert.ok(fixture.includes(`'${name}'`))
})
