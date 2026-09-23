/** Source-level packaging guard; the frozen build and actual installed runtime remain separate acceptance gates. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

it('builds a real CLI lifecycle subpath while preserving the Python executable import', () => {
  const cli = JSON.parse(read('apps/cli/package.json')) as {
    exports: Record<string, unknown>
    files: string[]
  }
  expect(cli.exports['./profile-boot']).toEqual({
    types: './lib/types/profile-boot.d.ts', default: './lib/profile-boot.js',
  })
  expect(cli.exports['./lib/*']).toBe('./lib/*')
  expect(cli.exports['./package.json']).toBe('./package.json')
  expect(cli.files).toEqual(expect.arrayContaining(['lib/*.js', 'lib/types/*.d.ts']))
  expect(read('apps/cli/tsdown.config.ts')).toContain("entry: ['lib/types/bin.js', 'lib/types/profile-boot.js']")
  expect(read('python/sdk-runtime/runtime-bootstrap.mjs')).toContain("import('@deepseek-ai/dsh/lib/bin.js')")
  expect(read('tsconfig.base.json')).toContain('"@deepseek-ai/dsh/profile-boot": ["./apps/cli/src/profile-boot.ts"]')
})

it('packages a dormant alpha2 entry without replacing the maintained framed Desktop Host', () => {
  const host = JSON.parse(read('apps/desktop-host/package.json')) as { main: string; files: string[] }
  const references = JSON.parse(read('apps/desktop-host/tsconfig.json')) as { references: Array<{ path: string }> }
  expect(host.main).toBe('lib/index.js')
  expect(host.files).toEqual(expect.arrayContaining([
    'lib/*.js', 'config/alpha2-desktop.cordis.patch.yml',
  ]))
  expect(read('apps/desktop-host/src/alpha2-entry.ts')).toContain('patchFiles: [OWNER_PATCH]')
  expect(read('apps/desktop-host/src/alpha2-entry.ts')).toContain('validateComposition: alpha2OwnerCompositionGuard')
  expect(read('apps/desktop-host/src/alpha2-entry.ts')).toContain("type: 'alpha2-transport-ready'")
  expect(references.references).toContainEqual({ path: '../cli' })
  expect(read('apps/desktop-host/tsdown.config.ts'))
    .toContain("entry: ['lib/types/index.js', 'lib/types/alpha2-entry.js']")
})
