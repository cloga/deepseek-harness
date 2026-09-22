/** Shell-only promotion of prepared profile graphs; Host package RPC never calls this module. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseProfileTransactionId, withProfilePackageLease } from '@deepseek-ai/dsh-app-boot'
import type { DesktopPreparedPackageActivation, DesktopProfilePackageTransactions } from './profile-package-staging.ts'
import {
  desktopPackageReceiptPosition, prepareDesktopPackageReceipt, validateDesktopReceiptTransition,
  type DesktopReceiptTransition,
} from './profile-package-receipt.ts'

/** Shell-owned lifecycle callbacks; none may be supplied by a renderer or package request. */
export interface DesktopProfilePackageActivationOptions {
  readonly profile: string
  readonly backend: Pick<DesktopProfilePackageTransactions,
    'readPreparedForActivation' | 'readPreparedForRecovery' | 'verifyActivationTree'>
  /** Command-origin preconsent stages require a matching live, persisted command capability; ordinary review cannot supply it. */
  readonly authorizeCommand?: (input: DesktopPreparedPackageActivation) => void | Promise<void>
  /** Native confirmation, including permission to interrupt the listed live Sessions. */
  readonly confirm: (input: DesktopPreparedPackageActivation) => Promise<boolean>
  /**
   * Block browser/API admission across Host generations until release; direct plugin work is not sandboxed or paused.
   * Reacquisition by the same transaction must be idempotent, and verification must inspect unexpected work.
   */
  readonly acquireAdmission: (input: DesktopPreparedPackageActivation) => Promise<() => Promise<void>>
  /** Reject unless runtime, retained graph, user ownership, ordered selection and complete config inputs are qualified. */
  readonly qualify: (input: DesktopPreparedPackageActivation, location: 'candidate' | 'active') => Promise<void>
  /** Resolve only after the shell's current or partially started Host has exited; safe when already stopped. */
  readonly stopHost: () => Promise<void>
  /**
   * Start the fixed Host with the launcher's admission barrier installed before Sessions become available;
   * retain its handle even if startup rejects.
   */
  readonly startHost: () => Promise<void>
  /** Require actual Host readiness and expected inventory, including restored inventory after rollback. */
  readonly verifyHost: (input: DesktopPreparedPackageActivation, role: 'candidate' | 'previous') => Promise<void>
  /** Build the exact receipt transition after health verification; absence uses the existing-schema implementation. */
  readonly prepareReceipt?: (input: DesktopPreparedPackageActivation) => DesktopReceiptTransition | undefined
  /** Write only the supplied existing-schema transition after verification; idempotent by transaction id. */
  readonly commitReceipt: (input: DesktopPreparedPackageActivation, transition?: DesktopReceiptTransition) => Promise<void>
  readonly leaseWaitMs?: number
}

/** A completed shell operation; committed is historical evidence, not a claim about later runtime health. */
export type DesktopProfilePackageActivationResult =
  | { readonly status: 'committed' | 'cancelled'; readonly transactionId: string }
  | { readonly status: 'rolled-back'; readonly transactionId: string; readonly diagnostic?: string }

/** Activation and explicit crash recovery share one stable profile lease. */
export interface DesktopProfilePackageActivation {
  /** @param transactionId - Launcher-owned prepared UUID. @returns Commit, refusal, or verified rollback. */
  activate(transactionId: string): Promise<DesktopProfilePackageActivationResult>
  /** @param transactionId - UUID with an owned activation journal. @returns Reconciled terminal outcome. */
  recover(transactionId: string): Promise<DesktopProfilePackageActivationResult>
}

type Phase = 'stopping' | 'swapping' | 'starting' | 'commit-intent' | 'committed' | 'rolling-back' | 'rolled-back'
interface Journal {
  schemaVersion: 1
  transactionId: string
  ownerFingerprint: string
  baseFingerprint: string
  baseGraphFingerprint: string
  candidateFingerprint: string
  intentFingerprint: string
  phase: Phase
  receiptSha256?: string
}
const phases: readonly Phase[] = ['stopping', 'swapping', 'starting', 'commit-intent', 'committed', 'rolling-back', 'rolled-back']
const journalName = 'ACTIVATION.json'
const receiptProofName = 'RECEIPT-COMMIT.json'
function fail(message: string): never { throw new Error(`desktop package activation: ${message}`) }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function directory(path: string, absent = false): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined && !absent) fail('required directory is missing')
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory())) fail('directory is redirected or has an unexpected type')
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = lstatSync(parent)
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('directory ancestor is redirected')
    if (dirname(parent) === parent) break
  }
  return stat !== undefined
}
function flushDirectory(path: string): void {
  // Node cannot open directory handles for fsync on Windows; renamed file data is flushed on both platforms.
  if (process.platform === 'win32') return
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
function durableJournal(path: string, value: Journal | DesktopReceiptTransition): void {
  directory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  renameSync(temporary, path)
  flushDirectory(dirname(path))
}
function move(source: string, target: string): void {
  directory(source)
  if (directory(target, true)) fail('rename target already exists')
  renameSync(source, target)
  flushDirectory(dirname(source))
  if (dirname(target) !== dirname(source)) flushDirectory(dirname(target))
}
function readJournal(path: string): Journal | undefined {
  directory(dirname(path))
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) fail('invalid activation journal file')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid activation journal')
  const input = value as Record<string, unknown>
  if (Object.keys(input).filter(key => key !== 'receiptSha256').sort().join(',') !== 'baseFingerprint,baseGraphFingerprint,candidateFingerprint,intentFingerprint,ownerFingerprint,phase,schemaVersion,transactionId'
    || (input.receiptSha256 !== undefined && (typeof input.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.receiptSha256)
      || (input.phase !== 'commit-intent' && input.phase !== 'committed')))
    || input.schemaVersion !== 1 || !phases.includes(input.phase as Phase)
    || ['ownerFingerprint', 'baseFingerprint', 'baseGraphFingerprint', 'candidateFingerprint', 'intentFingerprint']
      .some(key => typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(input[key]))) fail('invalid activation journal fields')
  parseProfileTransactionId(input.transactionId)
  return input as unknown as Journal
}
/**
 * Discover unfinished owned-layout journals before initialization can replace a missing active profile.
 * Each selected UUID still requires backend ownership, runtime, and graph verification before recovery.
 * @param profile - Fixed shell profile path.
 * @returns Nonterminal transaction ids; malformed records refuse startup instead of being ignored.
 */
export function pendingDesktopActivationTransactions(profile: string): readonly string[] {
  const root = dirname(resolve(profile))
  if (lstatSync(root, { throwIfNoEntry: false }) === undefined) return []
  directory(root)
  const prefix = `.${basename(profile)}.package-stage-`
  const pending: string[] = []
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith(prefix)) continue
    const id = parseProfileTransactionId(name.slice(prefix.length))
    const transaction = join(root, name)
    directory(transaction)
    const journal = readJournal(join(transaction, journalName))
    if (journal === undefined) continue
    if (journal.transactionId !== id) fail('activation journal disagrees with its directory identity')
    if (journal.phase !== 'committed' && journal.phase !== 'rolled-back') pending.push(id)
    if (pending.length > 100) fail('too many unfinished activation transactions')
  }
  return pending
}

function binding(input: DesktopPreparedPackageActivation): Omit<Journal, 'phase'> {
  if (typeof input.intentFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.intentFingerprint)) fail('prepared intent fingerprint is missing')
  return { schemaVersion: 1, transactionId: input.prepared.transactionId, ownerFingerprint: hash(JSON.stringify(input.owner)),
    baseFingerprint: input.prepared.baseFingerprint, baseGraphFingerprint: input.baseGraphFingerprint,
    candidateFingerprint: input.candidateFingerprint, intentFingerprint: input.intentFingerprint }
}
function sameInput(journal: Journal, input: DesktopPreparedPackageActivation): void {
  const { phase: _phase, receiptSha256: _receiptSha256, ...identity } = journal
  if (JSON.stringify(identity) !== JSON.stringify(binding(input))) fail('activation journal no longer matches its prepared owner or graph')
}

/**
 * Read a shell journal only when its complete identity matches backend-validated prepared evidence.
 * @param input - Backend-owned immutable transaction identity.
 * @returns Recorded lifecycle phase, or undefined before activation begins.
 */
export function readDesktopPackageActivationPhase(input: DesktopPreparedPackageActivation): Phase | undefined {
  const journal = readJournal(join(input.transactionDir, journalName))
  if (journal === undefined) return undefined
  sameInput(journal, input)
  return journal.phase
}

/**
 * Create an inert orchestrator; construction neither acquires a lease nor changes a Host or profile.
 * Every nonterminal attempt requires native confirmation and admission control. Failed stop, failed
 * rollback, and uncertain receipt commit retain all directories, the journal, and admission blocking.
 * No directory is deleted. Receipt changes require a journal-bound exact before/after proof; recovery
 * requalifies the active graph and Host before completing the same receipt write, never blindly rolling it back.
 * @param options - Fixed shell resources, backend verification, and explicit lifecycle capabilities.
 * @returns Explicit activation/recovery operations, never exposed through package-manager RPC.
 */
export function createDesktopProfilePackageActivation(options: DesktopProfilePackageActivationOptions): DesktopProfilePackageActivation {
  if (!isAbsolute(options.profile)) fail('profile must be absolute')
  const present = directory(resolve(options.profile), true)
  const profile = present ? realpathSync(options.profile) : join(realpathSync(dirname(options.profile)), basename(options.profile))
  const wait = options.leaseWaitMs ?? 120_000
  if (!Number.isSafeInteger(wait) || wait < 0) fail('invalid lease wait')
  const paths = (id: string) => {
    const transactionDir = join(dirname(profile), `.${basename(profile)}.package-stage-${id}`)
    return { transactionDir, candidateDir: join(transactionDir, 'profile'), rollbackDir: join(transactionDir, 'rollback'), journal: join(transactionDir, journalName) }
  }
  const owned = (id: string, input: DesktopPreparedPackageActivation | undefined): DesktopPreparedPackageActivation => {
    if (input === undefined) fail('prepared transaction is unavailable')
    const expected = paths(id)
    if (input.prepared.transactionId !== id || input.owner.profile !== profile || input.transactionDir !== expected.transactionDir
      || input.candidateDir !== expected.candidateDir || input.rollbackDir !== expected.rollbackDir) fail('foreign activation locations')
    directory(expected.transactionDir)
    return input
  }
  const verify = async (id: string, role: 'candidate' | 'active' | 'rollback', journal: Journal, proof?: DesktopReceiptTransition) => {
    const input = owned(id, await (proof === undefined ? options.backend.verifyActivationTree(id, role)
      : options.backend.verifyActivationTree(id, role, proof)))
    sameInput(journal, input)
    return input
  }
  const save = (id: string, journal: Journal, phase: Phase): Journal => {
    const next = { ...journal, phase }
    durableJournal(paths(id).journal, next)
    return next
  }
  const rollback = async (id: string, journal: Journal, input: DesktopPreparedPackageActivation): Promise<void> => {
    // Never rename a tree underneath a failed or partially started Host.
    await options.stopHost()
    journal = save(id, journal, 'rolling-back')
    const location = paths(id)
    const active = directory(profile, true)
    const candidate = directory(location.candidateDir, true)
    const previous = directory(location.rollbackDir, true)
    if (previous) {
      await verify(id, 'rollback', journal)
      if (active) {
        if (candidate) fail('both active and candidate trees exist during rollback')
        await verify(id, 'active', journal)
        move(profile, location.candidateDir)
      } else {
        if (!candidate) fail('candidate tree is missing during rollback')
        await verify(id, 'candidate', journal)
      }
      move(location.rollbackDir, profile)
    } else if (!active || !candidate) fail('no verified previous profile is available')
    const restored = owned(id, await options.backend.readPreparedForActivation(id))
    sameInput(journal, restored)
    await options.startHost()
    await options.verifyHost(input, 'previous')
    save(id, journal, 'rolled-back')
  }
  const readReceiptProof = (
    id: string, journal: Journal, input: DesktopPreparedPackageActivation,
  ): DesktopReceiptTransition | undefined => {
    if (journal.receiptSha256 === undefined) return undefined
    const path = join(paths(id).transactionDir, receiptProofName)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail('invalid receipt proof file')
    const text = readFileSync(path, 'utf8')
    if (hash(text) !== journal.receiptSha256) fail('receipt proof differs from the activation journal')
    return validateDesktopReceiptTransition(input, JSON.parse(text) as unknown)
  }
  const commit = async (
    id: string, journal: Journal, input: DesktopPreparedPackageActivation, proof?: DesktopReceiptTransition,
  ): Promise<void> => {
    await options.commitReceipt(input, proof)
    await verify(id, 'active', journal, proof)
    if (proof !== undefined && desktopPackageReceiptPosition(input, proof) !== 'after') fail('receipt commit did not write the journaled result')
    save(id, journal, 'committed')
  }
  const finish = async (id: string, journal: Journal, input: DesktopPreparedPackageActivation): Promise<void> => {
    await options.startHost()
    await options.verifyHost(input, 'candidate')
    await verify(id, 'active', journal)
    const selected = (options.prepareReceipt ?? prepareDesktopPackageReceipt)(input)
    const proof = selected === undefined ? undefined : validateDesktopReceiptTransition(input, selected)
    if (proof !== undefined) {
      const path = join(paths(id).transactionDir, receiptProofName)
      if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) fail('unidentified receipt proof already exists')
      durableJournal(path, proof)
      journal = { ...journal, receiptSha256: hash(readFileSync(path, 'utf8')) }
      await verify(id, 'active', journal, proof)
    }
    journal = save(id, journal, 'commit-intent')
    await commit(id, journal, input, proof)
  }
  const recoverLocked = async (id: string): Promise<DesktopProfilePackageActivationResult> => {
    const location = paths(id)
    const journal = readJournal(location.journal)
    if (journal === undefined) fail('activation journal is unavailable')
    const input = owned(id, await options.backend.readPreparedForRecovery(id))
    sameInput(journal, input)
    if (journal.phase === 'committed' || journal.phase === 'rolled-back') return { status: journal.phase, transactionId: id }
    if (journal.phase === 'commit-intent') {
      const proof = readReceiptProof(id, journal, input)
      await verify(id, 'active', journal, proof)
      if (!await options.confirm(input)) return { status: 'cancelled', transactionId: id }
      const release = await options.acquireAdmission(input)
      await options.stopHost()
      await verify(id, 'active', journal, proof)
      await options.qualify(input, 'active')
      await options.startHost()
      await options.verifyHost(input, 'candidate')
      await verify(id, 'active', journal, proof)
      await commit(id, journal, input, proof)
      await release()
      return { status: 'committed', transactionId: id }
    }
    if (!await options.confirm(input)) return { status: 'cancelled', transactionId: id }
    const release = await options.acquireAdmission(input)
    // Admission is deliberately retained on errors: the shell must not resume unverified Sessions.
    await rollback(id, journal, input)
    await release()
    return { status: 'rolled-back', transactionId: id }
  }
  return {
    activate(transactionId) {
      const id = parseProfileTransactionId(transactionId)
      return withProfilePackageLease(profile, async () => {
        const input = owned(id, await options.backend.readPreparedForActivation(id))
        const location = paths(id)
        if (readJournal(location.journal) !== undefined) fail('an activation journal already exists; use explicit recovery')
        if (directory(location.rollbackDir, true)) fail('unidentified rollback directory already exists')
        const authorize = async (): Promise<void> => {
          if (input.commandOrigin === undefined) return
          if (options.authorizeCommand === undefined) fail('command-origin preparation requires its live settlement authority')
          await options.authorizeCommand(input)
        }
        await authorize()
        if (!await options.confirm(input)) return { status: 'cancelled', transactionId: id }
        await authorize()
        const release = await options.acquireAdmission(input)
        let journal: Journal | undefined
        let stopped = false
        try {
          await options.qualify(input, 'candidate')
          const fresh = owned(id, await options.backend.readPreparedForActivation(id))
          journal = { ...binding(input), phase: 'stopping' }
          sameInput(journal, fresh)
          durableJournal(location.journal, journal)
          await options.stopHost()
          stopped = true
          const afterStop = owned(id, await options.backend.readPreparedForActivation(id))
          sameInput(journal, afterStop)
          journal = save(id, journal, 'swapping')
          move(profile, location.rollbackDir)
          move(location.candidateDir, profile)
          journal = save(id, journal, 'starting')
          await finish(id, journal, input)
          await release()
          return { status: 'committed', transactionId: id }
        } catch (error) {
          if (journal === undefined) { await release(); throw error }
          // A journal rename can succeed even when its following directory flush fails.
          const durable = readJournal(location.journal)
          if (durable?.phase === 'commit-intent' || durable?.phase === 'committed') throw error
          if (!stopped) throw error
          await rollback(id, durable ?? journal, input)
          await release()
          return { status: 'rolled-back', transactionId: id, diagnostic: message(error) }
        }
      }, wait)
    },
    recover(transactionId) {
      const id = parseProfileTransactionId(transactionId)
      return withProfilePackageLease(profile, () => recoverLocked(id), wait)
    },
  }
}
