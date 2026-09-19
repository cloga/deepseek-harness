/** Read-only-token preparation after packed-install; the official dsh family owns membership and payload policy. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { releaseFamily, tarballName } from './families.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity, tarballFiles } from './tarball.ts'
import { sealDirectory, selectionFromEnvironment, type Selection } from './github-artifacts.ts'

/** Reject unsafe archive entries, duplicates and non-regular/non-directory tar types without extracting.
 * @param paths - Names reported by tar for the original archive.
 * @param listing - Verbose tar inventory used to reject links, devices and special entries.
 */
export function validateArchiveEntries(paths: string[], listing: string): void {
  const normalized = paths.map(path => path.endsWith('/') ? path.slice(0, -1) : path)
  if (!paths.length || new Set(normalized).size !== paths.length || normalized.some(path =>
    !path.startsWith('package/') || /[\\\x00-\x1f\x7f]/u.test(path) || path.split('/').some(part => part === '..' || part === '.' || part === ''))
    || normalized.filter(path => path === 'package/package.json').length !== 1) throw new Error('Unsafe or ambiguous archive entries')
  const lines = listing.trimEnd().split(/\r?\n/u)
  if (lines.length !== paths.length || lines.some(line => !/^[-d][rwxstST-]{9}\s/u.test(line))) throw new Error('Archive links and special entries are forbidden')
}

/** Validate source identity and every original packed member against the official family's discovery and order.
 * @param root - Source checkout owning root and member manifests.
 * @param directory - Flat original pack output.
 * @param version - Exact requested version.
 * @returns Canonical tarball basenames after archive and payload validation.
 */
export function validateArtifactFamily(root: string, directory: string, version: string): string[] {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  if (rootManifest.version !== version) throw new Error('Root manifest differs from requested version')
  const family = releaseFamily('dsh')
  const members = family.publishOrder(family.members(root)).order
  family.verifyVersions(members)
  if (members.length === 0 || members.some(member => member.version !== version)) throw new Error('Source manifests differ from requested version')
  const expected = members.map(tarballName)
  const actual = readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected, 'publish-order.txt'].sort())
    || readFileSync(join(directory, 'publish-order.txt'), 'utf8') !== `${expected.join('\n')}\n`) throw new Error('Exact family set or publish order differs')
  for (const member of members) {
    const path = join(directory, tarballName(member))
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Tarball must be an original regular file')
    const paths = tarballFiles(path)
    validateArchiveEntries(paths, capture('tar', ['-tvzf', path]))
    const identity = packedIdentity(path)
    if (identity.name !== member.name || identity.version !== member.version) throw new Error('Packed package identity differs from source')
    family.validatePayload(member, paths)
  }
  return expected
}

/** Seal original tarballs only after source checkout, official build and family validation.
 * @param root - Tagged checkout containing built official artifacts.
 * @param directory - Original dsh pack output after packed-install succeeds.
 * @param selection - Validated Actions source/run selectors.
 */
export function prepareArtifacts(root: string, directory: string, selection: Selection): void {
  if (capture('git', ['-C', root, 'rev-parse', 'HEAD']).trim() !== selection.source) throw new Error('Checkout differs from selected source')
  releaseFamily('dsh').verifyBuildArtifacts(root)
  const expected = validateArtifactFamily(root, directory, selection.version)
  sealDirectory(directory, selection, capture('git', ['-C', root, 'rev-parse', 'HEAD^{tree}']).trim(), expected)
}

if (isEntry(import.meta.url)) {
  const selection = selectionFromEnvironment(process.env)
  const directory = process.argv[2]
  if (process.argv.length !== 3 || directory === undefined) throw new Error('Usage: github-artifacts-prepare.ts <pack-directory>')
  prepareArtifacts(process.cwd(), resolve(directory), selection)
}
