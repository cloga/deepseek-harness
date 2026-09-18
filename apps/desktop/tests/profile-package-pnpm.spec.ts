/** Offline packing acceptance using the pinned pnpm executable, not a mocked archive selector. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from 'tar'
import { expect, it } from 'vitest'
import { packDesktopSourceDirectory, runDesktopPackagePnpm } from '../src/profile-package-pnpm.ts'

it.each(['pm', 'install'])('preserves the built-in command position for %s before configuration flags', { timeout: 60000 }, async command => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pnpm-argv-'))
  const stub = join(root, 'pnpm-stub.mjs')
  const result = join(root, 'argv.json')
  writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv.at(-1), JSON.stringify(process.argv.slice(2)));\n`)
  try {
    await runDesktopPackagePnpm({ node: process.execPath, pnpm: stub, nodeBin: dirname(process.execPath) }, {
      cwd: root, args: [command, result], env: {}, signal: AbortSignal.timeout(30000),
    })
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual(command === 'pm'
      ? ['pm', '--config.update-notifier=false', result]
      : ['--config.update-notifier=false', 'install', result])
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

// The outer budget exceeds the owned pack process's 60-second deadline and includes file teardown.
it.each(['files', 'npmignore'] as const)('honors %s while suppressing lifecycle, pnpmfile, workspace and package-manager redirection', { timeout: 90000 }, async mode => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pnpm-pack-'))
  const source = join(root, 'source')
  const output = join(root, 'acquisition')
  mkdirSync(source); mkdirSync(output)
  const sentinel = join(root, 'hook-executed')
  const manifest = JSON.stringify({ name: 'offline-pack-proof', version: '1.0.0', packageManager: 'pnpm@0.0.0',
    dependencies: { 'dsh-must-not-install-for-packing': '0.0.0' },
    ...(mode === 'files' ? { files: ['index.js'] } : {}),
    scripts: { pm: 'node hook.cjs', prepack: 'node hook.cjs', prepare: 'node hook.cjs', postpack: 'node hook.cjs' } })
  writeFileSync(join(source, 'package.json'), manifest)
  writeFileSync(join(source, 'index.js'), 'export const value = 1\n')
  writeFileSync(join(source, 'private.txt'), 'not selected for publishing')
  writeFileSync(join(source, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`)
  writeFileSync(join(source, '.npmignore'), 'private.txt\nhook.cjs\n.pnpmfile.cjs\npnpm-workspace.yaml\n')
  writeFileSync(join(source, '.npmrc'), 'ignore-scripts=false\npm-on-fail=download\n')
  writeFileSync(join(source, '.pnpmfile.cjs'), 'throw new Error("source pnpm hook executed")\n')
  writeFileSync(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - .\nconfigDependencies:\n  must-never-fetch: 0.0.0\n')
  const archive = join(output, 'package.tgz')
  try {
    const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    const installed = JSON.parse(readFileSync(join(dirname(pnpm), '..', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    expect(installed.name).toBe('pnpm')
    expect(installed.version).toBe('11.7.0')
    await packDesktopSourceDirectory({ node: process.execPath, nodeBin: dirname(process.execPath), pnpm }, source, archive, AbortSignal.timeout(60000))
    const files: string[] = []
    await t({ file: archive, onReadEntry: entry => { files.push(entry.path) } })
    expect(files.sort()).toEqual(['package/index.js', 'package/package.json'])
    expect(readFileSync(join(source, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(sentinel)).toBe(false)
    expect(existsSync(join(source, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(join(source, 'node_modules'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
