/** Receipt-bound repair of Windows tarball specifiers in staged pnpm lockfiles. */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import type { DesktopPluginProvisionReceipt } from './plugin-source.ts'

type VerifiedArtifact = Pick<DesktopPluginProvisionReceipt, 'packageName' | 'version' | 'artifactSha256'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Align only a verified artifact's legacy Windows specifier with its canonical manifest entry.
 * @param projectDir - Transaction-owned staging or candidate profile, never the active profile.
 * @param receipts - Parsed receipt identities already owned by the staged profile.
 * @returns Whether a lockfile changed; other dependency drift remains subject to frozen installation.
 */
export function repairVerifiedArtifactLockfile(
  projectDir: string,
  receipts: Readonly<Record<string, VerifiedArtifact>>,
): boolean {
  const path = join(projectDir, 'pnpm-lock.yaml')
  const metadata = lstatSync(path, { throwIfNoEntry: false })
  if (metadata === undefined) return false
  if (!metadata.isFile()) {
    throw new Error('desktop project: verified-artifact lockfile must be a regular file')
  }
  if (Object.keys(receipts).length === 0) return false
  const text = readFileSync(path, 'utf8')
  if (!text.includes('file:.desktop-plugin-artifacts\\')) return false
  const lock: unknown = load(text, { schema: JSON_SCHEMA })
  if (!isRecord(lock) || lock.lockfileVersion !== '9.0' || !isRecord(lock.importers)) {
    throw new Error('desktop project: unsupported legacy verified-artifact lockfile')
  }
  const manifest: unknown = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    throw new Error('desktop project: invalid manifest for verified-artifact lockfile repair')
  }
  let changed = false
  for (const [name, receipt] of Object.entries(receipts)) {
    const canonical = `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz`
    const legacy = `file:.desktop-plugin-artifacts\\${receipt.artifactSha256}.tgz`
    if (!Object.hasOwn(manifest.dependencies, name) || manifest.dependencies[name] !== canonical) continue
    const entries: Record<string, unknown>[] = []
    for (const importer of Object.values(lock.importers)) {
      if (!isRecord(importer) || !isRecord(importer.dependencies)
        || !Object.hasOwn(importer.dependencies, name)) continue
      const entry = importer.dependencies[name]
      if (isRecord(entry)) entries.push(entry)
    }
    if (!entries.some(entry => entry.specifier === legacy)) continue
    const entry = entries[0]
    if (entries.length !== 1 || entry === undefined) {
      throw new Error(`desktop project: ambiguous verified-artifact importer for ${name}`)
    }
    const version = entry.version
    const packages = lock.packages
    const packageKey = `${name}@${canonical}`
    const locked = isRecord(packages) && Object.hasOwn(packages, packageKey) ? packages[packageKey] : undefined
    const resolution = isRecord(locked) ? locked.resolution : undefined
    if (receipt.packageName !== name || typeof version !== 'string'
      || (version !== canonical && !(version.startsWith(`${canonical}(`) && version.endsWith(')')))
      || !isRecord(locked) || locked.version !== receipt.version || !isRecord(resolution)
      || resolution.tarball !== canonical) {
      throw new Error(`desktop project: inconsistent verified-artifact lock identity for ${name}`)
    }
    const artifactPath = join(projectDir, '.desktop-plugin-artifacts', `${receipt.artifactSha256}.tgz`)
    if (!lstatSync(artifactPath).isFile()) {
      throw new Error(`desktop project: verified artifact is not a regular file for ${name}`)
    }
    const bytes = readFileSync(artifactPath)
    if (createHash('sha256').update(bytes).digest('hex') !== receipt.artifactSha256
      || resolution.integrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`) {
      throw new Error(`desktop project: verified-artifact lock integrity mismatch for ${name}`)
    }
    entry.specifier = canonical
    changed = true
  }
  if (changed) writeFileSync(path, dump(lock, { schema: JSON_SCHEMA, lineWidth: -1 }), { mode: 0o600 })
  return changed
}
