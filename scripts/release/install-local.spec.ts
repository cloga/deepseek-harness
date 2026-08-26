/** Local packed-release installation planning and platform behavior. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cliShimPath,
  dependencyOrder,
  runtimeClosure,
  tarballsFromDirectory,
  type LocalPackedPackage,
  verifyRuntimeClosure,
} from './install-local.ts'

const roots: string[] = []

function packed(name: string, dependencies: Record<string, string> = {}): LocalPackedPackage {
  return {
    tarball: join('packed', `${name}.tgz`),
    name,
    version: '0.1.0',
    manifest: { name, version: '0.1.0', dependencies },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local packed release installation', () => {
  it('orders dependencies before consumers', () => {
    const base = packed('@deepseek-ai/base')
    const middle = packed('@deepseek-ai/middle', { '@deepseek-ai/base': '^0.1.0' })
    const entry = packed('@deepseek-ai/entry', { '@deepseek-ai/middle': '^0.1.0' })

    expect(dependencyOrder([entry, base, middle]).map(pkg => pkg.name)).toEqual([
      '@deepseek-ai/base',
      '@deepseek-ai/middle',
      '@deepseek-ai/entry',
    ])
  })

  it('fails before installation when the fork runtime closure is incomplete', () => {
    const entry = packed('@deepseek-ai/entry', { '@deepseek-ai/missing': '^0.1.0' })

    expect(() => { verifyRuntimeClosure([entry]) }).toThrow(
      /@deepseek-ai\/entry -> @deepseek-ai\/missing/,
    )
  })

  it('rejects a publish order whose tarball is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-local-pack-'))
    roots.push(root)
    writeFileSync(join(root, 'publish-order.txt'), 'missing.tgz\n')

    expect(() => tarballsFromDirectory(root)).toThrow(/holds no packed tarball/)

    writeFileSync(join(root, 'present.tgz'), '')
    expect(() => tarballsFromDirectory(root)).toThrow(/missing ordered tarball missing\.tgz/)
  })

  it('returns the same deterministic order across repeated planning', () => {
    const packages = [
      packed('@deepseek-ai/zebra'),
      packed('@deepseek-ai/alpha'),
    ]

    expect(dependencyOrder(packages).map(pkg => pkg.name)).toEqual(
      dependencyOrder(packages).map(pkg => pkg.name),
    )
  })

  it('installs only the entry runtime closure from a complete pack family', () => {
    const runtime = packed('@deepseek-ai/runtime')
    const entry = packed('@deepseek-ai/dsh', { '@deepseek-ai/runtime': '^0.1.0' })
    const testSupport = packed('@deepseek-ai/test-support', { vitest: '^4.0.0' })

    expect(runtimeClosure([testSupport, entry, runtime], '@deepseek-ai/dsh').map(pkg => pkg.name)).toEqual([
      '@deepseek-ai/runtime',
      '@deepseek-ai/dsh',
    ])
  })

  it('uses the isolated npm shim location on Windows and POSIX', () => {
    expect(cliShimPath('C:\\dsh-local', 'win32')).toBe('C:\\dsh-local\\node_modules\\.bin\\dsh.cmd')
    expect(cliShimPath('/opt/dsh-local', 'linux')).toBe('/opt/dsh-local/node_modules/.bin/dsh')
  })

  it('accepts a complete closure and ignores external registry dependencies', () => {
    const cordis = packed('@deepseek-ai/cordis')
    const entry: LocalPackedPackage = {
      ...packed('@deepseek-ai/dsh', { '@deepseek-ai/cordis': '^4.0.0', execa: '^10.0.0' }),
      manifest: {
        dependencies: { '@deepseek-ai/cordis': '^4.0.0', execa: '^10.0.0' },
        optionalDependencies: { '@deepseek-ai/native-other-platform': '0.1.0' },
      },
    }

    expect(() => { verifyRuntimeClosure([entry, cordis]) }).not.toThrow()
  })
})
