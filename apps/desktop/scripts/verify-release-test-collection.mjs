/** Compare actual Vitest discovery so the Desktop release split cannot omit or duplicate a suite. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Require disjoint split collections whose union is the unchanged baseline.
 * @param {string[]} baseline - Project-qualified file identities from ordinary root configuration.
 * @param {string[]} ordinary - Discovered files under the release config.
 * @param {string[]} transactions - Discovered exact transaction-file selection.
 */
export function assertReleaseTestCollection(baseline, ordinary, transactions) {
  assert(baseline.length > 0 && ordinary.length > 0, 'Desktop test collections must not be empty')
  for (const values of [baseline, ordinary, transactions]) assert.equal(new Set(values).size, values.length, 'Duplicate collected suite')
  assert.equal(transactions.length, 1, 'Exactly one transaction suite must be selected')
  assert(transactions[0].endsWith(':apps/desktop/tests/project-manager.spec.ts'), 'Unexpected transaction selection')
  assert(!ordinary.includes(transactions[0]), 'Transaction suite also appears in ordinary tests')
  assert.deepEqual([...ordinary, ...transactions].sort(), [...baseline].sort(), 'Split collection differs from baseline')
}

/** Collect without executing any test or booting a product profile. */
async function main() {
  const require = createRequire(import.meta.url)
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const root = resolve(import.meta.dirname, '..', '..', '..')
  const scratch = mkdtempSync(join(tmpdir(), 'desktop-test-collection-'))
  try {
    const collect = (label, filters, config) => {
      const output = join(scratch, `${label}.json`)
      execFileSync(process.execPath, [vitest, 'list', ...filters, ...(config === undefined ? [] : [`--config=${config}`]),
        '--filesOnly', `--json=${output}`], { cwd: root, stdio: 'inherit', timeout: 120_000 })
      const rows = JSON.parse(readFileSync(output, 'utf8'))
      assert(Array.isArray(rows), 'Vitest collection must be an array')
      return rows.map(row => {
        assert(typeof row.file === 'string' && typeof row.projectName === 'string', 'Vitest collection identity is invalid')
        return `${row.projectName}:${relative(root, row.file).replaceAll('\\', '/')}`
      }).sort()
    }
    const baseline = collect('baseline', ['apps/desktop', 'apps/desktop-host'])
    const ordinary = collect('ordinary', ['apps/desktop', 'apps/desktop-host'], 'vitest.desktop-release.config.ts')
    const transactions = collect('transactions', ['apps/desktop/tests/project-manager.spec.ts'])
    assertReleaseTestCollection(baseline, ordinary, transactions)
    console.log(JSON.stringify({ baselineFiles: baseline.length, ordinaryFiles: ordinary.length, transactionFiles: transactions.length,
      disjoint: true, complete: true, transactions }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
