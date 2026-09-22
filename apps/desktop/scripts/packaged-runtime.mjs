/** Build-time access to the same ASAR-backed runtime used by the packaged Electron Host. */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const verifier = new URL('../lib/types/runtime-tree.js', import.meta.url).href
const requireElectron = 'if (!process.versions.electron) throw new Error("desktop runtime: packaged inspection requires Electron Node mode");'

/**
 * Resolve the immutable runtime inside the application archive.
 * @param {string} resourcesDir - Packaged Electron resources directory.
 * @returns {string} ASAR-backed runtime directory.
 */
export function packagedDesktopRuntimeRoot(resourcesDir) {
  return join(resourcesDir, 'app.asar', 'dsh')
}

/**
 * Select Electron Node mode without credential-shaped variables or inherited loader/ASAR overrides.
 * @param {NodeJS.ProcessEnv} environment - Parent environment.
 * @returns {NodeJS.ProcessEnv} Isolated inspection environment.
 */
export function packagedDesktopRuntimeEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => (
      !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_NO_ASAR|ELECTRON_RUN_AS_NODE)$/iu.test(name)
      && !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)
      && !/^DSH_DESKTOP_/iu.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    ))),
    ELECTRON_RUN_AS_NODE: '1',
  }
}

/**
 * Read the original descriptor bytes through Electron's ASAR filesystem.
 * @param {string} executable - Packaged Electron executable, never bundled upstream Node.
 * @param {string} runtimeRoot - ASAR-backed runtime directory.
 * @param {NodeJS.ProcessEnv} [environment] - Optional caller-owned inspection environment; no ambient variables are merged into it.
 * @returns {Buffer} Exact packaged bytes used by release receipts and installed evidence.
 */
export function readPackagedDesktopRuntimeDescriptor(executable, runtimeRoot, environment) {
  return execFileSync(executable, ['--input-type=module', '--eval', [
    requireElectron,
    'import { readFileSync } from "node:fs";',
    `process.stdout.write(readFileSync(${JSON.stringify(join(runtimeRoot, 'desktop-runtime.json'))}));`,
  ].join('\n')], {
    env: packagedDesktopRuntimeEnvironment(environment), cwd: environment?.DSH_HOME, windowsHide: true,
    timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  })
}

/** @param {import('app-builder-lib/out/asar/asar.js').Node} header - Parsed archive header. */
function runtimeEntries(header) {
  const entries = []
  /** @param {import('app-builder-lib/out/asar/asar.js').Node} node - Archive entry.
   * @param {string} path - Relative runtime path. */
  const visit = (node, path) => {
    if (node.link !== undefined) throw new Error(`desktop runtime: unsupported ASAR link ${path}`)
    if (node.files === undefined) {
      entries.push({ path, node })
      return
    }
    for (const [name, child] of Object.entries(node.files)) {
      if (name === '' || name === '.' || name === '..' || /[\\/:]/u.test(name)) {
        throw new Error(`desktop runtime: invalid ASAR path segment ${JSON.stringify(name)}`)
      }
      visit(child, path === '' ? name : `${path}/${name}`)
    }
  }
  const dsh = header.files?.dsh
  if (dsh?.files === undefined) throw new Error('desktop runtime: ASAR runtime directory is missing')
  visit(dsh, '')
  return entries
}

/** @param {string} unpacked - Physical sidecar runtime directory.
 * @param {string[]} expected - Archive entries marked unpacked. */
function verifyUnpackedFileNames(unpacked, expected) {
  const parent = lstatSync(dirname(unpacked), { throwIfNoEntry: false })
  if (parent !== undefined && (!parent.isDirectory() || parent.isSymbolicLink())) {
    throw new Error('desktop runtime: unpacked sidecar is not a real directory')
  }
  const actual = []
  /** @param {string} directory - Physical unpacked directory.
   * @param {string} prefix - Relative runtime directory. */
  const visitFiles = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) visitFiles(join(directory, entry.name), path)
      else if (entry.isFile()) actual.push(path)
      else throw new Error(`desktop runtime: unsupported unpacked filesystem entry ${path}`)
    }
  }
  const stat = lstatSync(unpacked, { throwIfNoEntry: false })
  if (stat !== undefined) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('desktop runtime: unpacked root is not a real directory')
    visitFiles(unpacked, '')
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())) {
    throw new Error('desktop runtime: unpacked file inventory verification failed')
  }
}

/**
 * Materialize actual archive bytes and permissions for the unchanged built inventory verifier.
 * Packed executable flags come from ASAR; unpacked modes come from physical files, not virtual stats.
 * Desktop must be built first; this does not boot the Host, open a window, or access a profile.
 * @param {string} executable - Packaged Electron executable.
 * @param {string} runtimeRoot - ASAR-backed runtime directory.
 * @param {string} version - Expected upstream shell/runtime version.
 * @param {{ platform: NodeJS.Platform, arch: string }} target - Required runtime target.
 * @param {NodeJS.ProcessEnv} [environment] - Optional caller-owned environment with an absolute TMPDIR, TEMP or TMP for materialization.
 * @returns {Promise<void>} Resolves after successful verification and child exit.
 */
export async function verifyPackagedDesktopRuntime(executable, runtimeRoot, version, target, environment) {
  const temporaryRoot = environment === undefined ? tmpdir() : environment.TMPDIR ?? environment.TEMP ?? environment.TMP
  if (typeof temporaryRoot !== 'string' || !isAbsolute(temporaryRoot)) {
    throw new Error('desktop runtime: explicit inspection environment requires an absolute temporary directory')
  }
  const { readAsar } = await import('app-builder-lib/out/asar/asar.js')
  const archive = await readAsar(dirname(runtimeRoot))
  const entries = runtimeEntries(archive.header)
  const unpacked = join(`${dirname(runtimeRoot)}.unpacked`, 'dsh')
  // Electron's virtual directory listing cannot observe unrecorded sidecar files.
  verifyUnpackedFileNames(unpacked, entries.filter(entry => entry.node.unpacked === true).map(entry => entry.path))
  const materialized = mkdtempSync(join(temporaryRoot, 'dsh-asar-verification-'))
  try {
    for (const { path, node } of entries) {
      const destination = join(materialized, ...path.split('/'))
      let mode = node.executable === true ? 0o755 : 0o644
      if (node.unpacked === true) {
        const stat = lstatSync(join(unpacked, ...path.split('/')))
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`desktop runtime: unsupported unpacked file ${path}`)
        mode = stat.mode
      }
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, await archive.readFile(join('dsh', ...path.split('/'))), { flag: 'wx', mode })
      if (process.platform !== 'win32') chmodSync(destination, mode)
    }
    await run(executable, ['--input-type=module', '--eval', [
      requireElectron,
      `import { verifyDesktopRuntime } from ${JSON.stringify(verifier)};`,
      `await verifyDesktopRuntime(${JSON.stringify(materialized)}, ${JSON.stringify(version)}, ${JSON.stringify(target)});`,
    ].join('\n')], {
      env: packagedDesktopRuntimeEnvironment(environment), cwd: environment?.DSH_HOME, windowsHide: true,
      timeout: 120_000, maxBuffer: 1024 * 1024,
    })
  } finally {
    rmSync(materialized, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
