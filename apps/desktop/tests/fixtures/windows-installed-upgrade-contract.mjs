/** Fail-closed inputs for the disposable-runner, real-installer upgrade fixture. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Require a hosted Windows qualification invocation.
 * @param {NodeJS.ProcessEnv} environment - Invocation environment.
 * @param {NodeJS.Platform} platform - Native platform, injectable only in unit tests.
 */
export function assertUpgradeRunner(environment, platform = process.platform) {
  assert.equal(platform, 'win32', 'Installer qualification requires Windows')
  assert.equal(environment.GITHUB_ACTIONS, 'true', 'Installer qualification is GitHub-only')
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted', 'Self-hosted machines are not disposable qualification targets')
  assert.equal(environment.RUNNER_OS, 'Windows')
  assert.match(environment.GITHUB_RUN_ID ?? '', /^\d+$/)
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/)
  assert.ok(environment.RUNNER_TEMP, 'Runner temporary root is required')
}

/** Reject root escapes and existing symlink/reparse aliases.
 * @param {string} root - Existing owned root.
 * @param {string} path - Requested descendant.
 * @returns {string} Absolute owned path.
 */
export function ownedUpgradePath(root, path) {
  const owner = realpathSync.native(root)
  const candidate = resolve(path)
  const suffix = relative(owner, candidate)
  assert.ok(suffix !== '' && suffix !== '..' && !isAbsolute(suffix) && !suffix.startsWith(`..${sep}`) && !resolve(candidate).startsWith('\\\\'), 'Path must be a strict owned descendant')
  let current = candidate
  const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  while (!samePath(current, owner)) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    assert.ok(stat === undefined || !stat.isSymbolicLink(), 'Owned path must not traverse a link')
    if (stat !== undefined) assert.equal(realpathSync.native(current).toLowerCase(), current.toLowerCase(), 'Owned path must not traverse a filesystem alias')
    const parent = dirname(current)
    assert.notEqual(parent, current, 'Owned path escaped its root')
    current = parent
  }
  return candidate
}

/** Locate the exact nested application installed by the shared NSIS driver.
 * @param {string} root - Existing owned qualification root.
 * @returns {string} Owned application path; does not launch or verify installed bytes.
 */
export function installedUpgradeApplication(root) {
  return ownedUpgradePath(root, join(root, 'Installed App', 'cloga-deepseek-harness-desktop', 'cloga-deepseek-harness.exe'))
}

/** Hash exact file bytes, not a manifest self-hash.
 * @param {string} path - Regular evidence file.
 * @param {string} algorithm - Hash algorithm.
 * @param {import('node:crypto').BinaryToTextEncoding} encoding - Digest encoding.
 * @returns {string} Digest of the file bytes.
 */
export function upgradeFileHash(path, algorithm = 'sha256', encoding = 'hex') {
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Evidence must be a regular file')
  return createHash(algorithm).update(readFileSync(path)).digest(encoding)
}

/** Reject path-bearing asset names.
 * @param {string} directory - Acquisition directory.
 * @param {string} name - Manifest-owned filename.
 * @returns {string} Asset path within the directory.
 */
export function upgradeAssetPath(directory, name) {
  assert.equal(typeof name, 'string')
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.equal(basename(name), name)
  return join(directory, name)
}

/** Derive the baseline commit only after checking its independently pinned manifest bytes.
 * @param {string} directory - Acquired baseline directory.
 * @param {string} manifestSha256 - Reviewed raw manifest digest, never its self-reported hash.
 * @returns {string} Exact source commit committed to by the pinned manifest.
 */
export function pinnedUpgradeSourceCommit(directory, manifestSha256) {
  assert.match(manifestSha256, /^[a-f0-9]{64}$/)
  const path = join(directory, 'release.json')
  const stat = lstatSync(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Baseline manifest must be a regular file')
  const bytes = readFileSync(path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifestSha256, 'Baseline manifest bytes differ from the reviewed digest')
  const manifest = JSON.parse(bytes.toString('utf8'))
  assert.equal(manifest.source.repository, 'cloga/deepseek-harness')
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/)
  return manifest.source.commit
}

/** Verify finalized installer and receipt bytes.
 * @param {string} directory - Acquired release directory.
 * @param {{commit: string, version: string, upstreamVersion: string, manifestSha256?: string}} expected - Reviewed identity.
 * @param {(value: unknown) => string} jsonHash - Production canonical JSON hash function.
 * @returns {{manifest: object, installer: string, manifestPath: string, manifestFileSha256: string}} Verified release inputs; not execution evidence.
 */
export function verifyUpgradeRelease(directory, expected, jsonHash) {
  const manifestPath = join(directory, 'release.json')
  if (expected.manifestSha256 !== undefined) assert.equal(upgradeFileHash(manifestPath), expected.manifestSha256)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { manifestSha256, ...manifestPayload } = manifest
  assert.equal(jsonHash(manifestPayload), manifestSha256, 'Manifest self-hash mismatch')
  assert.equal(manifest.schemaVersion, 3)
  assert.equal(manifest.owner, 'cloga/deepseek-harness')
  assert.equal(manifest.mode, 'interactive-windows-installer')
  assert.equal(manifest.channel, 'cloga-windows-x64')
  assert.equal(manifest.source.repository, 'cloga/deepseek-harness')
  assert.equal(manifest.source.commit, expected.commit)
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/)
  assert.match(manifest.source.tree, /^[a-f0-9]{40}$/)
  assert.equal(manifest.version, expected.version)
  assert.equal(manifest.upstreamVersion, expected.upstreamVersion)
  assert.equal(manifest.source.tag, `dsh-desktop-v${expected.version}`)
  assert.equal(manifest.identity.appId, 'io.github.cloga.deepseek-harness.desktop')
  assert.equal(manifest.identity.productName, 'DeepSeek Harness (cloga)')
  assert.equal(manifest.identity.executableName, 'cloga-deepseek-harness')
  assert.equal(manifest.identity.packageName, 'cloga-deepseek-harness-desktop')
  assert.deepEqual(manifest.installation.installerArguments, [])
  assert.equal(manifest.installation.interaction, 'required')
  assert.equal(manifest.installer.signature, 'NotSigned')
  assert.equal(manifest.installer.file, `cloga-deepseek-harness-${expected.version}-win-x64.exe`)
  const installer = upgradeAssetPath(directory, manifest.installer.file)
  assert.equal(lstatSync(installer).size, manifest.installer.bytes)
  assert.equal(upgradeFileHash(installer), manifest.installer.sha256)
  assert.equal(upgradeFileHash(installer, 'sha512', 'base64'), manifest.installer.sha512)
  const receiptPath = upgradeAssetPath(directory, manifest.buildReceipt.file)
  assert.equal(upgradeFileHash(receiptPath), manifest.buildReceipt.sha256)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  const { receiptSha256, ...receiptPayload } = receipt
  assert.equal(jsonHash(receiptPayload), receiptSha256)
  assert.equal(receiptSha256, manifest.buildReceipt.receiptSha256)
  assert.equal(receipt.action, 'desktop-fork-release')
  assert.equal(receipt.status, 'complete')
  assert.equal(receipt.source.commit, manifest.source.commit)
  assert.equal(receipt.source.tree, manifest.source.tree)
  assert.equal(receipt.source.version, manifest.version)
  assert.equal(receipt.identity.sequence, manifest.sequence)
  assert.deepEqual(receipt.artifacts.installer, manifest.installer)
  assert.equal(receipt.artifacts.executableSha256, manifest.installedEvidence.executableSha256)
  assert.equal(receipt.artifacts.runtimeSha256, manifest.installedEvidence.runtimeSha256)
  assert.equal(receipt.buildInputs.lockfileSha256, manifest.build.lockfileSha256)
  assert.equal(receipt.buildInputs.planSha256, manifest.build.planSha256)
  return { manifest, installer, manifestPath, manifestFileSha256: upgradeFileHash(manifestPath) }
}
