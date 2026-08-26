/** Local packed-release installation planning and platform behavior. */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cliShimContent,
  cliShimPath,
  dependencyOrder,
  installReceipt,
  npmCliShimPath,
  replaceInstallPrefix,
  runtimeClosure,
  tarballsFromDirectory,
  type LocalPackedPackage,
  verifyRuntimeClosure,
  writeCliShim,
} from './install-local.ts'
import { capture } from './process.ts'

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

  it('uses a stable prefix-root shim while retaining the npm shim location', () => {
    expect(cliShimPath('C:\\dsh-local', 'win32')).toBe('C:\\dsh-local\\dsh.cmd')
    expect(npmCliShimPath('C:\\dsh-local', 'win32')).toBe('C:\\dsh-local\\node_modules\\.bin\\dsh.cmd')
    expect(cliShimPath('/opt/dsh-local', 'linux')).toBe('/opt/dsh-local/dsh')
    expect(npmCliShimPath('/opt/dsh-local', 'linux')).toBe('/opt/dsh-local/node_modules/.bin/dsh')
  })

  it('writes the Windows root shim atomically and idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh local shim-'))
    roots.push(root)

    const first = writeCliShim(root, 'win32')
    const second = writeCliShim(root, 'win32')

    expect(first).toBe(join(root, 'dsh.cmd'))
    expect(second).toBe(first)
    expect(readFileSync(first, 'utf8')).toBe(cliShimContent('win32'))
    expect(readFileSync(first, 'utf8')).toContain('%~dp0node_modules\\.bin\\dsh.cmd')
  })

  it('boots through the stable root shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh local shim-'))
    roots.push(root)
    const internal = npmCliShimPath(root)
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    if (process.platform === 'win32') {
      writeFileSync(internal, '@ECHO off\r\n@ECHO shim-booted %*\r\n')
    } else {
      writeFileSync(internal, '#!/bin/sh\nprintf "shim-booted %s\\n" "$*"\n', { mode: 0o755 })
    }
    const shim = writeCliShim(root)

    expect(capture(shim, ['--version'], { cwd: root })).toBe('shim-booted --version')
  })

  it('records the Desktop-compatible root shim without changing provenance hashes', () => {
    const pkg: LocalPackedPackage = {
      ...packed('@deepseek-ai/dsh'),
      files: ['package/lib/bin.js'],
      sha256: 'a'.repeat(64),
    }
    const rootPath = cliShimPath('C:\\dsh-local', 'win32')
    const receipt = installReceipt(
      [pkg],
      'https://github.com/cloga/deepseek-harness.git',
      'abc123',
      '0.1.0',
      rootPath,
    )

    expect(receipt.cliPath).toBe('C:\\dsh-local\\dsh.cmd')
    expect(receipt.repositoryUrl).toBe('https://github.com/cloga/deepseek-harness.git')
    expect(receipt.commitSha).toBe('abc123')
    expect(receipt.packages[0]?.sha256).toBe('a'.repeat(64))
    expect(receipt.releaseManifestSha256).toHaveLength(64)
  })

  it('restores the previous prefix when publication fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-local-publish-'))
    roots.push(parent)
    const prefix = join(parent, 'selected')
    const staging = join(parent, 'staging')
    mkdirSync(prefix)
    mkdirSync(staging)
    writeFileSync(join(prefix, 'dsh.cmd'), 'old')
    writeFileSync(join(staging, 'dsh.cmd'), 'new')
    let moves = 0

    expect(() => {
      replaceInstallPrefix(staging, prefix, (source, destination) => {
        moves += 1
        if (moves === 2) throw new Error('publication failed')
        renameSync(source, destination)
      })
    }).toThrow(/publication failed/)
    expect(readFileSync(join(prefix, 'dsh.cmd'), 'utf8')).toBe('old')
    expect(readFileSync(join(staging, 'dsh.cmd'), 'utf8')).toBe('new')
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
