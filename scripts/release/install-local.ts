/**
 * Install packed release artifacts into a self-contained npm prefix for local
 * product integration testing.
 *
 * The command consumes tarballs rather than workspace packages, rejects an
 * incomplete DeepSeek runtime closure before npm can consult the registry for
 * fork packages, and records the exact checkout and tarball hashes installed.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { capture, commandInvocation, isEntry } from './process.ts'
import { PUBLISH_ORDER_FILE, tarballFiles } from './tarball.ts'

const RUNTIME_SECTIONS = ['dependencies', 'peerDependencies'] as const
const RECEIPT_FILE = 'dsh-local-install.json'
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000
const DEFAULT_BOOT_TIMEOUT_MS = 30_000

/** Parsed information needed to validate and install one packed package. */
export interface LocalPackedPackage {
  /** Absolute tarball path. */
  readonly tarball: string
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
  /** Packed manifest. */
  readonly manifest: Readonly<Record<string, unknown>>
  /** Tarball members, when the command has inspected the payload. */
  readonly files?: readonly string[]
  /** Tarball SHA-256, when the command has inspected the payload. */
  readonly sha256?: string
}

/** One installed executable file sealed by the local-install receipt. */
export interface InstalledFileAttestation {
  readonly role: 'root-shim' | 'npm-shim' | 'entrypoint'
  readonly path: string
  readonly sha256: string
}

export interface InstallReceipt {
  readonly schemaVersion: 1
  readonly repositoryUrl: string
  readonly commitSha: string
  readonly packageName: '@deepseek-ai/dsh'
  readonly packageVersion: string
  readonly releaseManifestSha256: string
  readonly cliPath: string
  readonly packages: readonly {
    readonly name: string
    readonly version: string
    readonly filename: string
    readonly sha256: string
    readonly files: number
  }[]
  readonly installedFiles: readonly InstalledFileAttestation[]
}

/**
 * Read a JSON object from a packed npm tarball.
 * @param tarball - Absolute tarball path.
 * @returns The packed package manifest.
 */
function packedManifest(tarball: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${tarball} has no object package manifest`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Resolve the tarballs in one pack directory and enforce its recorded order.
 * Directories without an order file, such as a platform compatibility pack,
 * use deterministic filename order.
 * @param directory - Absolute packed-artifact directory.
 * @returns Absolute tarball paths.
 */
export function tarballsFromDirectory(directory: string): string[] {
  const filenames = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
  if (filenames.length === 0) throw new Error(`${directory} holds no packed tarball`)
  const orderPath = join(directory, PUBLISH_ORDER_FILE)
  if (!existsSync(orderPath)) return filenames.map(filename => join(directory, filename))

  const order = readFileSync(orderPath, 'utf8').split('\n').filter(line => line !== '')
  const available = new Set(filenames)
  for (const filename of order) {
    if (!available.has(filename)) throw new Error(`${directory} is missing ordered tarball ${filename}`)
  }
  const unrecorded = filenames.filter(filename => !order.includes(filename))
  if (unrecorded.length > 0) {
    throw new Error(`${directory} has tarballs absent from ${PUBLISH_ORDER_FILE}: ${unrecorded.join(', ')}`)
  }
  return order.map(filename => join(directory, filename))
}

/**
 * Order packed packages after their packed runtime dependencies.
 * @param packages - Packed packages from all supplied release directories.
 * @returns A deterministic dependency-first order.
 */
export function dependencyOrder(packages: readonly LocalPackedPackage[]): LocalPackedPackage[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  if (byName.size !== packages.length) throw new Error('packed directories contain duplicate package names')
  const visiting = new Set<string>()
  const placed = new Set<string>()
  const ordered: LocalPackedPackage[] = []

  const visit = (pkg: LocalPackedPackage, path: readonly string[]): void => {
    if (placed.has(pkg.name)) return
    if (visiting.has(pkg.name)) {
      throw new Error(`packed runtime dependency cycle: ${[...path, pkg.name].join(' -> ')}`)
    }
    visiting.add(pkg.name)
    const dependencies = pkg.manifest.dependencies
    if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies).sort()) {
        const dependency = byName.get(name)
        if (dependency !== undefined) visit(dependency, [...path, pkg.name])
      }
    }
    visiting.delete(pkg.name)
    placed.add(pkg.name)
    ordered.push(pkg)
  }

  for (const pkg of [...packages].sort((left, right) => left.name.localeCompare(right.name))) visit(pkg, [])
  return ordered
}

/**
 * Require every fork-owned runtime dependency and peer to be supplied locally.
 * Optional dependencies remain optional, including platform-specific native
 * packages.
 * @param packages - Packed packages from all supplied release directories.
 */
export function verifyRuntimeClosure(packages: readonly LocalPackedPackage[]): void {
  const names = new Set(packages.map(pkg => pkg.name))
  const missing = new Set<string>()
  for (const pkg of packages) {
    for (const section of RUNTIME_SECTIONS) {
      const dependencies = pkg.manifest[section]
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      for (const name of Object.keys(dependencies)) {
        if (name.startsWith('@deepseek-ai/') && !names.has(name)) missing.add(`${pkg.name} -> ${name}`)
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(`packed runtime closure is incomplete:\n${[...missing].sort().join('\n')}`)
  }
}

/**
 * Select the packed runtime closure reachable from one entry package.
 * @param packages - Every supplied packed package.
 * @param entryName - Runtime entry package name.
 * @returns Reachable packages in dependency-first order.
 */
export function runtimeClosure(
  packages: readonly LocalPackedPackage[],
  entryName: string,
): LocalPackedPackage[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const entry = byName.get(entryName)
  if (entry === undefined) throw new Error(`${entryName} is absent from the packed artifacts`)
  const selected = new Map<string, LocalPackedPackage>()
  const visit = (pkg: LocalPackedPackage): void => {
    if (selected.has(pkg.name)) return
    selected.set(pkg.name, pkg)
    for (const section of RUNTIME_SECTIONS) {
      const dependencies = pkg.manifest[section]
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      for (const name of Object.keys(dependencies)) {
        const dependency = byName.get(name)
        if (dependency !== undefined) visit(dependency)
      }
    }
  }
  visit(entry)
  return dependencyOrder([...selected.values()])
}

/**
 * Resolve the npm-created `dsh` shim for a prefix and platform.
 * @param prefix - npm installation prefix.
 * @param platform - Node platform identifier.
 * @returns Absolute executable shim path.
 */
export function npmCliShimPath(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? win32.join(prefix, 'node_modules', '.bin', 'dsh.cmd')
    : posix.join(prefix, 'node_modules', '.bin', 'dsh')
}

/**
 * Resolve the stable Desktop-facing `dsh` shim for a prefix and platform.
 * @param prefix - npm installation prefix.
 * @param platform - Node platform identifier.
 * @returns Absolute executable shim path.
 */
export function cliShimPath(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? win32.join(prefix, 'dsh.cmd') : posix.join(prefix, 'dsh')
}

/**
 * Build a root shim that delegates to npm's platform shim through a relative path.
 * @param platform - Node platform identifier.
 * @returns Platform-native shim content.
 */
export function cliShimContent(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? '@ECHO off\r\n@CALL "%~dp0node_modules\\.bin\\dsh.cmd" %*\r\n'
    : '#!/bin/sh\nexec "$(dirname "$0")/node_modules/.bin/dsh" "$@"\n'
}

/**
 * Atomically create or replace the stable root shim inside an installation prefix.
 * Repeating the write with identical content leaves the existing shim untouched.
 * @param prefix - npm installation prefix.
 * @param platform - Node platform identifier.
 * @returns Absolute stable shim path.
 */
export function writeCliShim(prefix: string, platform: NodeJS.Platform = process.platform): string {
  const destination = cliShimPath(prefix, platform)
  const content = cliShimContent(platform)
  if (existsSync(destination) && readFileSync(destination, 'utf8') === content) return destination

  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content)
    if (platform !== 'win32') chmodSync(temporary, 0o755)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return destination
}

/**
 * Publish a verified staging prefix while retaining the selected installation
 * until the replacement directory is in place.
 * @param staging - Verified staging prefix.
 * @param prefix - Selected installation prefix.
 * @param move - Directory move operation, injectable for rollback tests.
 */
export function replaceInstallPrefix(
  staging: string,
  prefix: string,
  move: (source: string, destination: string) => void = renameSync,
): void {
  const backup = join(dirname(prefix), `.${basename(prefix)}-rollback-${randomUUID()}`)
  const hadPrevious = existsSync(prefix)
  if (hadPrevious) move(prefix, backup)
  try {
    move(staging, prefix)
  } catch (error) {
    if (hadPrevious) move(backup, prefix)
    throw error
  }
  if (hadPrevious) rmSync(backup, { recursive: true, force: true })
}

/**
 * Hash the staged executable files that determine the installed CLI.
 * @param prefix - Verified staging installation prefix.
 * @param platform - Node platform identifier.
 * @returns Deterministically ordered, prefix-relative file attestations.
 */
function installedFileAttestations(
  prefix: string,
  platform: NodeJS.Platform,
): InstalledFileAttestation[] {
  const shimName = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const separator = platform === 'win32' ? '\\' : '/'
  const files = [
    { role: 'root-shim', segments: [shimName] },
    { role: 'npm-shim', segments: ['node_modules', '.bin', shimName] },
    { role: 'entrypoint', segments: ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'] },
  ] as const

  for (const file of files) {
    const path = join(prefix, ...file.segments)
    if (!existsSync(path)) throw new Error(`installed ${file.role} is absent at ${path}`)
  }
  return files.map(file => ({
    role: file.role,
    path: file.segments.join(separator),
    sha256: createHash('sha256').update(readFileSync(join(prefix, ...file.segments))).digest('hex'),
  }))
}

/**
 * Build a stable receipt for an installation.
 * @param packages - Installed packages in dependency order.
 * @param repositoryUrl - Source repository URL.
 * @param commit - Selected checkout commit.
 * @param version - Selected dsh version.
 * @param cliPath - Final executable shim path.
 * @param installedPrefix - Verified staging installation prefix.
 * @param platform - Node platform identifier.
 * @returns Receipt content.
 */
export function installReceipt(
  packages: readonly LocalPackedPackage[],
  repositoryUrl: string,
  commit: string,
  version: string,
  cliPath: string,
  installedPrefix: string,
  platform: NodeJS.Platform = process.platform,
): InstallReceipt {
  const entries = packages.map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    filename: basename(pkg.tarball),
    sha256: pkg.sha256 ?? createHash('sha256').update(readFileSync(pkg.tarball)).digest('hex'),
    files: pkg.files?.length ?? tarballFiles(pkg.tarball).length,
  }))
  return {
    schemaVersion: 1,
    repositoryUrl,
    commitSha: commit,
    packageName: '@deepseek-ai/dsh',
    packageVersion: version,
    releaseManifestSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    cliPath,
    packages: entries,
    installedFiles: installedFileAttestations(installedPrefix, platform),
  }
}

/**
 * Run a command with a hard timeout while retaining a bounded diagnostic tail.
 * @param command - Portable command name.
 * @param args - Command arguments.
 * @param cwd - Working directory.
 * @param timeoutMs - Hard timeout.
 */
async function runTimed(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<void> {
  const invocation = commandInvocation(command, args)
  const child = spawn(invocation.command, [...invocation.args], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let tail = ''
  const append = (chunk: Buffer): void => {
    const text = chunk.toString()
    process.stdout.write(text)
    tail = `${tail}${text}`.slice(-16_384)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      terminateProcessTree(child)
      reject(new Error(`${command} exceeded ${String(timeoutMs)}ms; output tail:\n${tail}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${String(code)}; output tail:\n${tail}`))
    })
  })
}

/**
 * Terminate one child and its descendants.
 * @param child - Root child process.
 */
function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill()
}

/**
 * Run the installed Web profile until it reports its bound URL.
 * @param bin - Installed JavaScript entry.
 * @param cwd - Isolated installation prefix.
 * @returns The reported local URL.
 */
async function verifyWebBoot(cli: string, cwd: string, timeoutMs: number): Promise<string> {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-local-install-home-'))
  environment.DSH_AGENTS_HOME = join(environment.DSH_HOME, '.agents')
  environment.DSH_TELEMETRY_DISABLED = '1'

  const invocation = commandInvocation(cli, ['--profile', 'web', '--port', '0', '--no-open'])
  const child = spawn(invocation.command, [...invocation.args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    return await new Promise<string>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`installed dsh web did not become ready:\n${output}`))
      }, timeoutMs)
      const inspect = (chunk: Buffer): void => {
        output += chunk.toString()
        const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
        if (url !== undefined) {
          clearTimeout(timeout)
          resolvePromise(url)
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`installed dsh web exited with ${String(code)} before readiness:\n${output}`))
      })
    })
  } finally {
    terminateProcessTree(child)
    rmSync(environment.DSH_HOME, { recursive: true, force: true })
  }
}

/** Install packed release artifacts into an isolated npm prefix. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string', multiple: true },
      prefix: { type: 'string' },
      'expect-commit': { type: 'string' },
      'expect-version': { type: 'string' },
      'install-timeout-ms': { type: 'string' },
      'boot-timeout-ms': { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.from === undefined || values.from.length === 0) {
    throw new Error('usage: install-local.ts --from <packed directory> [--from ...] [--prefix <directory>]')
  }

  const root = process.cwd()
  const commit = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  const repositoryUrl = capture('git', ['remote', 'get-url', 'origin'], { cwd: root })
  if (values['expect-commit'] !== undefined && values['expect-commit'] !== commit) {
    throw new Error(`checkout commit is ${commit}, expected ${values['expect-commit']}`)
  }

  const installTimeoutMs = Number(values['install-timeout-ms'] ?? DEFAULT_INSTALL_TIMEOUT_MS)
  const bootTimeoutMs = Number(values['boot-timeout-ms'] ?? DEFAULT_BOOT_TIMEOUT_MS)
  if (!Number.isSafeInteger(installTimeoutMs) || installTimeoutMs <= 0) {
    throw new Error('--install-timeout-ms must be a positive integer')
  }
  if (!Number.isSafeInteger(bootTimeoutMs) || bootTimeoutMs <= 0) {
    throw new Error('--boot-timeout-ms must be a positive integer')
  }

  console.log('release install-local: inspecting packed manifests and payloads')
  const tarballs = values.from.flatMap(directory => tarballsFromDirectory(resolve(root, directory)))
  const packages = tarballs.map((tarball): LocalPackedPackage => {
    const manifest = packedManifest(tarball)
    const { name, version } = manifest
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`${tarball} manifest lacks name/version`)
    }
    return {
      tarball,
      name,
      version,
      manifest,
      files: tarballFiles(tarball),
      sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    }
  })
  verifyRuntimeClosure(packages)
  const dsh = releaseFamily('dsh')
  const dshNames = new Set(dsh.members(root).map(member => member.name))
  const packedDsh = packages.filter(pkg => dshNames.has(pkg.name))
  const missingDsh = [...dshNames].filter(name => !packedDsh.some(pkg => pkg.name === name))
  if (missingDsh.length > 0) throw new Error(`packed dsh family is incomplete:\n${missingDsh.sort().join('\n')}`)
  dsh.verifyVersions(packedDsh.map(pkg => ({
    directory: pkg.tarball,
    name: pkg.name,
    version: pkg.version,
    manifest: pkg.manifest,
  })))
  for (const pkg of packedDsh) {
    dsh.validatePayload({
      directory: pkg.tarball,
      name: pkg.name,
      version: pkg.version,
      manifest: pkg.manifest,
    }, pkg.files ?? tarballFiles(pkg.tarball))
  }

  const cli = packages.find(pkg => pkg.name === '@deepseek-ai/dsh')
  if (cli === undefined) throw new Error('@deepseek-ai/dsh is absent from the packed artifacts')
  if (values['expect-version'] !== undefined && values['expect-version'] !== cli.version) {
    throw new Error(`packed dsh version is ${cli.version}, expected ${values['expect-version']}`)
  }
  const ordered = runtimeClosure(packages, cli.name)

  const prefix = resolve(values.prefix ?? join(homedir(), '.dsh', 'local-cli', commit))
  mkdirSync(dirname(prefix), { recursive: true })
  const staging = mkdtempSync(join(dirname(prefix), `.${basename(prefix)}-install-`))
  try {
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
      name: 'dsh-local-release-install',
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(ordered.map(pkg => [pkg.name, pathToFileURL(pkg.tarball).href])),
    }, null, 2)}\n`)
    console.log(
      `release install-local: installing ${String(ordered.length)} runtime package(s)`
      + ` from ${String(packages.length)} verified tarball(s) into staging prefix`,
    )
    await runTimed('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--legacy-peer-deps',
      '--prefer-offline',
      '--fetch-timeout=30000',
      '--fetch-retries=2',
    ], staging, installTimeoutMs)

    const internalCliPath = npmCliShimPath(staging)
    if (!existsSync(internalCliPath)) throw new Error(`npm created no dsh shim at ${internalCliPath}`)
    const stagedCliPath = writeCliShim(staging)
    const version = capture(stagedCliPath, ['--version'], { cwd: staging, env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
    } })
    if (version !== cli.version) throw new Error(`installed dsh reports ${version}, expected ${cli.version}`)
    console.log('release install-local: verifying isolated Web boot')
    const readyUrl = await verifyWebBoot(stagedCliPath, staging, bootTimeoutMs)

    const finalCliPath = cliShimPath(prefix)
    writeFileSync(join(staging, RECEIPT_FILE), `${JSON.stringify(
      installReceipt(ordered, repositoryUrl, commit, cli.version, finalCliPath, staging),
      null,
      2,
    )}\n`)
    replaceInstallPrefix(staging, prefix)
    if (!existsSync(finalCliPath)) throw new Error(`installed dsh root shim is absent at ${finalCliPath}`)

    console.log(`release install-local: ${cli.version} from ${commit}`)
    console.log(
      `release install-local: verified ${String(packages.length)} package payload(s),`
      + ` installed ${String(ordered.length)} runtime package(s), Web ready at ${readyUrl}`,
    )
    console.log(`release install-local: set DSH_CLI_PATH=${finalCliPath}`)
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (error) {
      console.warn(`release install-local: could not remove staging prefix ${staging}: ${String(error)}`)
    }
  }
}

if (isEntry(import.meta.url)) await main()
