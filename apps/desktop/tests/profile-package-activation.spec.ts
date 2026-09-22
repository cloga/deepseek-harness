/** Shell activation ordering and crash recovery over disposable directories; no Host or package process is launched. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { profilePackageLeaseTarget } from '@deepseek-ai/dsh-app-boot'
import { createDesktopProfilePackageActivation, type DesktopProfilePackageActivationOptions } from '../src/profile-package-activation.ts'
import type { DesktopPreparedPackageActivation } from '../src/profile-package-staging.ts'
import { commitDesktopPackageReceipt, desktopPackageReceiptPosition } from '../src/profile-package-receipt.ts'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const files = ['package.json', 'cordis.patch.yml', 'node_modules/addon/index.js']
function fingerprint(path: string, receipt?: string | null): string {
  const actualReceipt = receipt === undefined
    ? existsSync(join(path, 'desktop-plugin-receipts.json')) ? readFileSync(join(path, 'desktop-plugin-receipts.json'), 'utf8') : null
    : receipt
  const inventory = files.map(file => [file, readFileSync(join(path, file), 'utf8')])
  if (actualReceipt !== null) inventory.push(['desktop-plugin-receipts.json', actualReceipt])
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
}
function json(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value)}\n`) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-activation-'))
  roots.push(root)
  const profile = join(root, 'desktop')
  const transactionId = randomUUID()
  const transactionDir = join(dirname(profile), `.${basename(profile)}.package-stage-${transactionId}`)
  const candidateDir = join(transactionDir, 'profile')
  const rollbackDir = join(transactionDir, 'rollback')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  writeJson(join(runtimeDir, 'package.json'), { name: 'fixture-runtime', version: '1.0.0' })
  const bundles = ['user-first', 'addon', 'user-last']
  for (const [path, version] of [[profile, 'old'], [candidateDir, 'new']] as const) {
    mkdirSync(join(path, 'node_modules', 'addon'), { recursive: true })
    writeJson(join(path, 'package.json'), { private: true, userField: 'preserved', dependencies: { addon: version }, dsh: { profile: { bundles } } })
    writeFileSync(join(path, 'cordis.patch.yml'), '- id: user-disabled\n  disabled: true\n')
    writeFileSync(join(path, 'node_modules', 'addon', 'index.js'), version)
  }
  const baseGraphFingerprint = fingerprint(profile)
  const candidateFingerprint = fingerprint(candidateDir)
  const input: DesktopPreparedPackageActivation = {
    transactionDir, candidateDir, rollbackDir,
    owner: { profile, runtimeDir, installAnchor: join(runtimeDir, 'package.json'), runtimeFingerprint: 'a'.repeat(64), dependencyRegistry: 'https://registry.example.test/', configPaths: [] },
    mutation: { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'fixture-addon.tgz' } },
    prepared: { transactionId, state: 'prepared', packageName: 'addon', baseFingerprint: 'b'.repeat(64), health: 'pending' },
    candidateFingerprint, baseGraphFingerprint, intentFingerprint: 'e'.repeat(64),
  }
  const events: string[] = []
  let admissionHeld = false
  const admissionBlocked = () => admissionHeld
  const release = vi.fn(async () => { events.push('release'); admissionHeld = false })
  const assertTree = (path: string, expected: string): void => {
    if (fingerprint(path) !== expected) throw new Error('fixture tree fingerprint mismatch')
  }
  const backend: DesktopProfilePackageActivationOptions['backend'] = {
    readPreparedForActivation: vi.fn<DesktopProfilePackageActivationOptions['backend']['readPreparedForActivation']>(async (id) => {
      expect(existsSync(`${profilePackageLeaseTarget(profile)}.lock`)).toBe(true)
      expect(id).toBe(transactionId)
      assertTree(profile, baseGraphFingerprint)
      assertTree(candidateDir, candidateFingerprint)
      return input
    }),
    readPreparedForRecovery: vi.fn<DesktopProfilePackageActivationOptions['backend']['readPreparedForRecovery']>(async (id) => {
      expect(existsSync(`${profilePackageLeaseTarget(profile)}.lock`)).toBe(true)
      expect(id).toBe(transactionId)
      return input
    }),
    verifyActivationTree: vi.fn<DesktopProfilePackageActivationOptions['backend']['verifyActivationTree']>(async (id, role, proof) => {
      expect(existsSync(`${profilePackageLeaseTarget(profile)}.lock`)).toBe(true)
      expect(id).toBe(transactionId)
      if (proof !== undefined) {
        expect(role).toBe('active')
        desktopPackageReceiptPosition(input, proof)
        if (fingerprint(profile, proof.before) !== candidateFingerprint) throw new Error('fixture tree fingerprint mismatch')
      } else {
        assertTree(role === 'active' ? profile : role === 'candidate' ? candidateDir : rollbackDir,
          role === 'rollback' ? baseGraphFingerprint : candidateFingerprint)
      }
      return input
    }),
  }
  const confirm = vi.fn(async () => { events.push('confirm'); return true })
  const acquireAdmission = vi.fn(async () => { events.push('admit'); admissionHeld = true; return release })
  const qualify = vi.fn(async () => { events.push('qualify') })
  const stopHost = vi.fn(async () => { events.push('stop') })
  const startHost = vi.fn(async () => {
    expect(admissionHeld).toBe(true)
    events.push(`start:${readFileSync(join(profile, 'node_modules', 'addon', 'index.js'), 'utf8')}`)
  })
  const verifyHost = vi.fn<DesktopProfilePackageActivationOptions['verifyHost']>(async (_input, role) => {
    expect(admissionHeld).toBe(true)
    events.push(`verify:${role}`)
  })
  const commitReceipt = vi.fn(async () => { expect(admissionHeld).toBe(true); events.push('receipt') })
  const options: DesktopProfilePackageActivationOptions = {
    profile, backend, confirm, acquireAdmission, qualify, stopHost, startHost, verifyHost, commitReceipt, leaseWaitMs: 100,
  }
  const controller = createDesktopProfilePackageActivation(options)
  const journalPath = join(transactionDir, 'ACTIVATION.json')
  return { root, profile, transactionId, transactionDir, candidateDir, rollbackDir, input, events, release, backend,
    confirm, acquireAdmission, admissionBlocked, qualify, stopHost, startHost, verifyHost, commitReceipt, options, controller, journalPath }
}
async function interruptedBeforeRename(f: ReturnType<typeof fixture>): Promise<void> {
  f.stopHost.mockRejectedValueOnce(new Error('interrupted shell stop'))
  await expect(f.controller.activate(f.transactionId)).rejects.toThrow('interrupted shell stop')
  expect(json(f.journalPath).phase).toBe('stopping')
  f.events.length = 0
  f.release.mockClear()
}

describe('command-origin activation authority', () => {
  const commandOrigin = () => ({ kind: 'desktop-command' as const, generation: randomUUID(), requestId: 1, commandId: 'command-1' })

  it('refuses ordinary review and orphan preconsent records before any prompt or profile effect', async () => {
    const f = fixture()
    Object.assign(f.input, { commandOrigin: commandOrigin() })
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('live settlement authority')
    expect(f.events).toEqual([])
    expect(existsSync(f.journalPath)).toBe(false)
    expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
    expect(fingerprint(f.candidateDir)).toBe(f.input.candidateFingerprint)
    await expect(f.controller.recover(f.transactionId)).rejects.toThrow('journal is unavailable')
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('requires the invocation-bound origin before consent and again before admission', async () => {
    const f = fixture()
    const origin = commandOrigin()
    Object.assign(f.input, { commandOrigin: origin })
    const authorizeCommand = vi.fn((input: DesktopPreparedPackageActivation) => {
      expect(input.commandOrigin).toEqual(origin)
      expect(input.prepared.transactionId).toBe(f.transactionId)
      f.events.push('authorize')
    })
    const controller = createDesktopProfilePackageActivation({ ...f.options, authorizeCommand })
    expect(await controller.activate(f.transactionId)).toMatchObject({ status: 'committed' })
    expect(f.events.slice(0, 4)).toEqual(['authorize', 'confirm', 'authorize', 'admit'])
    expect(authorizeCommand).toHaveBeenCalledTimes(2)
  })

  it('does not admit a command whose authority expires during deferred native consent', async () => {
    const f = fixture()
    Object.assign(f.input, { commandOrigin: commandOrigin() })
    const revoked = new Error('exact command authority revoked')
    let live = true
    const authorizeCommand = vi.fn(() => { if (!live) throw revoked })
    f.confirm.mockImplementation(async () => { live = false; return true })
    const controller = createDesktopProfilePackageActivation({ ...f.options, authorizeCommand })
    await expect(controller.activate(f.transactionId)).rejects.toBe(revoked)
    expect(f.acquireAdmission).not.toHaveBeenCalled()
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.stopHost).not.toHaveBeenCalled()
    expect(existsSync(f.journalPath)).toBe(false)
  })

  it('preserves failed or undefined command authorization without prompting', async () => {
    const f = fixture()
    Object.assign(f.input, { commandOrigin: commandOrigin() })
    const controller = createDesktopProfilePackageActivation({ ...f.options, authorizeCommand: () => { throw undefined } })
    await expect(controller.activate(f.transactionId)).rejects.toBeUndefined()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.acquireAdmission).not.toHaveBeenCalled()
  })

  it('keeps already-admitted journal recovery behind fresh consent without requiring the lost original command', async () => {
    const f = fixture()
    Object.assign(f.input, { commandOrigin: commandOrigin() })
    const authorized = createDesktopProfilePackageActivation({ ...f.options, authorizeCommand: () => {} })
    f.stopHost.mockRejectedValueOnce(new Error('interrupted admitted stop'))
    await expect(authorized.activate(f.transactionId)).rejects.toThrow('interrupted admitted stop')
    expect(json(f.journalPath).phase).toBe('stopping')
    f.events.length = 0
    expect(await f.controller.recover(f.transactionId)).toMatchObject({ status: 'rolled-back' })
    expect(f.events[0]).toBe('confirm')
    expect(f.verifyHost).toHaveBeenCalledWith(f.input, 'previous')
  })
})

describe('shell-only prepared package activation', () => {
  it('constructs inertly and leaves prepared state untouched when native confirmation is refused', async () => {
    const f = fixture()
    expect(f.events).toEqual([])
    expect(existsSync(f.journalPath)).toBe(false)
    f.confirm.mockResolvedValue(false)
    expect(await f.controller.activate(f.transactionId)).toEqual({ status: 'cancelled', transactionId: f.transactionId })
    expect(f.acquireAdmission).not.toHaveBeenCalled()
    expect(f.stopHost).not.toHaveBeenCalled()
    expect(existsSync(f.journalPath)).toBe(false)
    expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
    expect(fingerprint(f.candidateDir)).toBe(f.input.candidateFingerprint)
  })

  it('refuses unqualified runtime or retained graph combinations before stopping or renaming', async () => {
    const f = fixture()
    f.qualify.mockRejectedValue(new Error('retained graph is not qualified'))
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('not qualified')
    expect(f.stopHost).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
    expect(existsSync(f.journalPath)).toBe(false)
    expect(existsSync(f.rollbackDir)).toBe(false)
  })

  it('rechecks the current base after confirmation and admission before stopping', async () => {
    const f = fixture()
    f.qualify.mockImplementation(async () => { writeFileSync(join(f.profile, 'cordis.patch.yml'), 'changed while awaiting confirmation\n') })
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('fingerprint mismatch')
    expect(f.stopHost).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
    expect(existsSync(f.rollbackDir)).toBe(false)
  })

  it('stops, swaps, starts, verifies inventory and readiness, and only then commits the existing-schema receipt', async () => {
    const f = fixture()
    f.stopHost.mockImplementation(async () => {
      f.events.push('stop')
      expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
      expect(existsSync(f.rollbackDir)).toBe(false)
    })
    f.startHost.mockImplementation(async () => {
      expect(f.admissionBlocked()).toBe(true)
      f.events.push('start:new')
      expect(fingerprint(f.profile)).toBe(f.input.candidateFingerprint)
      expect(fingerprint(f.rollbackDir)).toBe(f.input.baseGraphFingerprint)
      expect(existsSync(f.candidateDir)).toBe(false)
      expect(f.commitReceipt).not.toHaveBeenCalled()
    })
    f.commitReceipt.mockImplementation(async () => {
      expect(f.admissionBlocked()).toBe(true)
      f.events.push('receipt')
      expect(json(f.journalPath).phase).toBe('commit-intent')
      expect(f.verifyHost).toHaveBeenCalledExactlyOnceWith(f.input, 'candidate')
    })
    expect(await f.controller.activate(f.transactionId)).toEqual({ status: 'committed', transactionId: f.transactionId })
    expect(f.events).toEqual(['confirm', 'admit', 'qualify', 'stop', 'start:new', 'verify:candidate', 'receipt', 'release'])
    expect(json(f.journalPath).phase).toBe('committed')
    expect(f.admissionBlocked()).toBe(false)
    expect(json(join(f.profile, 'package.json'))).toMatchObject({ userField: 'preserved', dsh: { profile: { bundles: ['user-first', 'addon', 'user-last'] } } })
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('- id: user-disabled\n  disabled: true\n')
    const calls = f.events.length
    expect(await f.controller.recover(f.transactionId)).toEqual({ status: 'committed', transactionId: f.transactionId })
    expect(f.events).toHaveLength(calls)
  })

  it('stops a failed new Host before restoring the previous graph and verifying its restart', async () => {
    const f = fixture()
    f.verifyHost.mockImplementation(async (_input, role) => {
      f.events.push(`verify:${role}`)
      if (role === 'candidate') throw new Error('new inventory is wrong')
    })
    f.stopHost.mockImplementation(async () => {
      f.events.push('stop')
      if (f.stopHost.mock.calls.length === 2) {
        expect(fingerprint(f.profile)).toBe(f.input.candidateFingerprint)
        expect(fingerprint(f.rollbackDir)).toBe(f.input.baseGraphFingerprint)
      }
    })
    expect(await f.controller.activate(f.transactionId)).toEqual({ status: 'rolled-back', transactionId: f.transactionId, diagnostic: 'new inventory is wrong' })
    expect(f.events).toEqual(['confirm', 'admit', 'qualify', 'stop', 'start:new', 'verify:candidate', 'stop', 'start:old', 'verify:previous', 'release'])
    expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
    expect(fingerprint(f.candidateDir)).toBe(f.input.candidateFingerprint)
    expect(json(f.journalPath).phase).toBe('rolled-back')
    expect(f.commitReceipt).not.toHaveBeenCalled()
  })

  it('retains admission, journal and both graphs when the failed new Host cannot be stopped', async () => {
    const f = fixture()
    f.startHost.mockRejectedValueOnce(new Error('partially started new Host'))
    f.stopHost.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new Host has not exited'))
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('not exited')
    expect(fingerprint(f.profile)).toBe(f.input.candidateFingerprint)
    expect(fingerprint(f.rollbackDir)).toBe(f.input.baseGraphFingerprint)
    expect(existsSync(f.candidateDir)).toBe(false)
    expect(json(f.journalPath).phase).toBe('starting')
    expect(f.release).not.toHaveBeenCalled()
    expect(f.commitReceipt).not.toHaveBeenCalled()
    expect(await createDesktopProfilePackageActivation(f.options).recover(f.transactionId)).toEqual({ status: 'rolled-back', transactionId: f.transactionId })
    expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each(['before-rename', 'old-moved', 'candidate-promoted'] as const)('recovers an interrupted %s layout idempotently without deleting either graph', async (layout) => {
    const f = fixture()
    await interruptedBeforeRename(f)
    if (layout !== 'before-rename') renameSync(f.profile, f.rollbackDir)
    if (layout === 'candidate-promoted') renameSync(f.candidateDir, f.profile)
    writeJson(f.journalPath, { ...json(f.journalPath), phase: 'swapping' })
    const recovered = createDesktopProfilePackageActivation(f.options)
    expect(await recovered.recover(f.transactionId)).toEqual({ status: 'rolled-back', transactionId: f.transactionId })
    expect(fingerprint(f.profile)).toBe(f.input.baseGraphFingerprint)
    expect(fingerprint(f.candidateDir)).toBe(f.input.candidateFingerprint)
    expect(f.commitReceipt).not.toHaveBeenCalled()
    expect(f.events).toEqual(['confirm', 'admit', 'stop', 'start:old', 'verify:previous', 'release'])
    const calls = f.events.length
    expect(await recovered.recover(f.transactionId)).toEqual({ status: 'rolled-back', transactionId: f.transactionId })
    expect(f.events).toHaveLength(calls)
  })

  it('refuses a changed rollback graph and preserves unknown bytes instead of deleting or restoring them', async () => {
    const f = fixture()
    await interruptedBeforeRename(f)
    renameSync(f.profile, f.rollbackDir)
    renameSync(f.candidateDir, f.profile)
    writeFileSync(join(f.rollbackDir, 'node_modules', 'addon', 'index.js'), 'foreign old graph')
    await expect(f.controller.recover(f.transactionId)).rejects.toThrow('fingerprint mismatch')
    expect(readFileSync(join(f.rollbackDir, 'node_modules', 'addon', 'index.js'), 'utf8')).toBe('foreign old graph')
    expect(fingerprint(f.profile)).toBe(f.input.candidateFingerprint)
    expect(f.release).not.toHaveBeenCalled()
    expect(f.startHost).not.toHaveBeenCalled()
  })

  it('fails closed on post-stop profile changes without moving the changed tree', async () => {
    const f = fixture()
    f.stopHost.mockImplementationOnce(async () => { writeFileSync(join(f.profile, 'cordis.patch.yml'), 'changed during shutdown\n') })
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('fingerprint mismatch')
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('changed during shutdown\n')
    expect(existsSync(f.rollbackDir)).toBe(false)
    expect(f.startHost).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  })

  it('never rolls back an uncertain receipt commit or treats its journal as completed', async () => {
    const f = fixture()
    f.commitReceipt.mockImplementation(async () => {
      writeJson(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: {} })
      throw new Error('receipt write outcome is uncertain')
    })
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('uncertain')
    expect(json(f.journalPath).phase).toBe('commit-intent')
    expect(f.stopHost).toHaveBeenCalledOnce()
    expect(existsSync(join(f.profile, 'desktop-plugin-receipts.json'))).toBe(true)
    expect(fingerprint(f.rollbackDir)).toBe(f.input.baseGraphFingerprint)
    expect(f.release).not.toHaveBeenCalled()
    await expect(createDesktopProfilePackageActivation(f.options).recover(f.transactionId)).rejects.toThrow('fingerprint mismatch')
    expect(f.stopHost).toHaveBeenCalledOnce()
    expect(f.commitReceipt).toHaveBeenCalledOnce()
  })

  it.each(['before-write', 'after-write'] as const)('reconciles a journal-bound %s receipt interruption only after fresh Host verification', async (interruption) => {
    const f = fixture()
    const source: DesktopGithubReleasePluginSource = { schemaVersion: 1, type: 'githubRelease', owner: 'example', repo: 'addon',
      tag: 'v1.0.0', asset: 'addon.tgz', assetId: 2, packageName: 'addon', version: '1.0.0', size: 1,
      sha256: 'a'.repeat(64), targetCommit: 'b'.repeat(40) }
    Object.assign(f.input, { mutation: { kind: 'install', source }, verifiedRelease: {
      source, releaseId: 1, assetId: 2, packageName: 'addon', version: '1.0.0',
    } })
    let first = true
    const commitReceipt: DesktopProfilePackageActivationOptions['commitReceipt'] = async (input, proof) => {
      expect(json(f.journalPath).phase).toBe('commit-intent')
      expect(f.verifyHost).toHaveBeenCalledWith(input, 'candidate')
      if (!first || interruption === 'after-write') await commitDesktopPackageReceipt(input, proof)
      if (first) { first = false; throw new Error('simulated receipt interruption') }
    }
    const options = { ...f.options, commitReceipt }
    await expect(createDesktopProfilePackageActivation(options).activate(f.transactionId)).rejects.toThrow('receipt interruption')
    expect(json(f.journalPath).receiptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(f.release).not.toHaveBeenCalled()
    expect(f.admissionBlocked()).toBe(true)
    expect(await createDesktopProfilePackageActivation(options).recover(f.transactionId))
      .toEqual({ status: 'committed', transactionId: f.transactionId })
    expect(f.verifyHost).toHaveBeenCalledTimes(2)
    expect(f.stopHost).toHaveBeenCalledTimes(2)
    expect(f.release).toHaveBeenCalledOnce()
    expect(json(join(f.profile, 'desktop-plugin-receipts.json'))).toMatchObject({ owners: { addon: 'user' } })
    expect(fingerprint(f.rollbackDir)).toBe(f.input.baseGraphFingerprint)
  })

  it('refuses a foreign journal and redirected or pre-existing rollback locations', async () => {
    const f = fixture()
    mkdirSync(f.rollbackDir)
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('unidentified rollback')
    expect(f.stopHost).not.toHaveBeenCalled()
    rmdirSync(f.rollbackDir)
    const foreign = join(f.root, 'foreign')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'sentinel'), 'keep')
    symlinkSync(foreign, f.rollbackDir, 'junction')
    await expect(f.controller.activate(f.transactionId)).rejects.toThrow('redirected')
    expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('keep')
    // Unlink only the link; recursive removal is reserved for test-owned real roots in teardown.
    unlinkSync(f.rollbackDir)
    await interruptedBeforeRename(f)
    writeJson(f.journalPath, { ...json(f.journalPath), transactionId: randomUUID() })
    await expect(f.controller.recover(f.transactionId)).rejects.toThrow('no longer matches')
    expect(f.release).not.toHaveBeenCalled()
  })
})
