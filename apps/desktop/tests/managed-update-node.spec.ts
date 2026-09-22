import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeDesktopManagedNodeAttestation, resolveDesktopManagedNode } from '../src/managed-update-node.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-managed-node-'))
  roots.push(root)
  const runtime = join(root, 'dsh')
  const primary = join(root, 'primary-runtime')
  const node = join(primary, 'dependencies', 'node', 'bin', 'node.exe')
  mkdirSync(join(node, '..'), { recursive: true })
  writeFileSync(node, 'official standalone Node fixture')
  writeFileSync(join(primary, 'runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64', components: { node: '24.13.0' } }))
  const descriptor = runtimeFixture(runtime)
  writeDesktopManagedNodeAttestation(runtime, primary)
  writeDesktopRuntime(runtime, descriptor.release, descriptor.sharedPackages.map(entry => entry.name), { platform: 'win32', arch: 'x64' })
  return { runtime, primary, node }
}

it('selects the fixed official standalone Node and returns its post-copy verification hash', () => {
  const f = fixture()
  expect(resolveDesktopManagedNode(f.runtime, f.primary)).toEqual({ path: f.node,
    sha256: createHash('sha256').update(readFileSync(f.node)).digest('hex') })
})

it('rejects metadata tampering even when it points at another nominal Node version', () => {
  const f = fixture()
  writeFileSync(join(f.runtime, 'managed-update-node.json'), JSON.stringify({ schemaVersion: 1, path: 'Electron.exe' }))
  expect(() => resolveDesktopManagedNode(f.runtime, f.primary)).toThrow('not sealed')
})

it('rejects changed standalone executable bytes before returning a launch path', () => {
  const f = fixture()
  writeFileSync(f.node, 'unrelated Electron carrier')
  expect(() => resolveDesktopManagedNode(f.runtime, f.primary)).toThrow('does not match')
})
