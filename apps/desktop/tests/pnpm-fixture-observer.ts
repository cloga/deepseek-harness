/** Failure-only lock observations from synthetic real-pnpm fixtures, never production profiles. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Wrap the bundled package manager and retain only one synthetic root package's lock observations.
 * @param root - Test-owned temporary root, removed by the caller's teardown.
 * @param pnpm - Exact real pnpm entry executed by the fixture.
 * @param name - Synthetic root package to observe.
 * @param offline - Whether this zero-dependency fixture forbids registry acquisition.
 * @returns Wrapper entry and a failure reporter; neither observes credentials or unrelated lock entries.
 */
export function observeFixturePnpm(root: string, pnpm: string, name: string, offline = false): {
  entry: string
  reportFailure(): void
} {
  const entry = join(root, 'observed-pnpm.mjs')
  const observations = join(root, 'pnpm-root-observations.jsonl')
  writeFileSync(entry, `import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load } from ${JSON.stringify(import.meta.resolve('js-yaml'))}
const root = ${JSON.stringify(root)}
const name = ${JSON.stringify(name)}
const output = ${JSON.stringify(observations)}
const leaf = value => typeof value === 'string' ? value.replaceAll(root, '<fixture>').slice(0, 2048) : null
const actualEntry = realpathSync(${JSON.stringify(pnpm)})
const dist = join(dirname(actualEntry), '..', 'dist', 'pnpm.mjs')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
appendFileSync(output, JSON.stringify({ kind: 'software', node: process.version, nodeExecutable: leaf(realpathSync(process.execPath)),
  pnpmEntry: leaf(actualEntry), pnpmEntrySha256: sha256(actualEntry),
  pnpmDist: existsSync(dist) ? leaf(realpathSync(dist)) : null, pnpmDistSha256: existsSync(dist) ? sha256(dist) : null }) + '\\n')
process.once('exit', () => {
  const lockPath = join(process.cwd(), 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) return
  try {
    const lock = load(readFileSync(lockPath, 'utf8'))
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const importers = Object.entries(lock?.importers ?? {}).map(([key, importer]) => ({
      key: leaf(key), specifier: leaf(importer?.dependencies?.[name]?.specifier), version: leaf(importer?.dependencies?.[name]?.version),
    })).slice(0, 8)
    const packages = Object.entries(lock?.packages ?? {}).filter(([key]) => key.startsWith(name + '@')).slice(0, 8).map(([key, value]) => ({
      key: leaf(key), version: leaf(value?.version), tarball: leaf(value?.resolution?.tarball), integrity: leaf(value?.resolution?.integrity),
    }))
    appendFileSync(output, JSON.stringify({ node: process.version, command: process.argv.find(arg => ['add', 'install', 'remove', 'rebuild'].includes(arg)),
      cwd: leaf(process.cwd()), declared: leaf(manifest.dependencies?.[name]), importers, packages }) + '\\n')
  } catch {
    appendFileSync(output, JSON.stringify({ diagnostic: 'synthetic lock observation unavailable' }) + '\\n')
  }
})
${offline ? "process.argv.push('--config.offline=true')\n" : ''}await import(${JSON.stringify(pathToFileURL(pnpm).href)})
`)
  return {
    entry,
    reportFailure() {
      if (existsSync(observations)) console.error(`Synthetic pnpm root observations:\n${readFileSync(observations, 'utf8')}`)
    },
  }
}
