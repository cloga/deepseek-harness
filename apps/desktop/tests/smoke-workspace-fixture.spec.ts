import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeWorkspaceHostPackages } from '../scripts/smoke-workspace-fixture.ts'

it('copies published host payloads under the owned runtime without nested modules, private files, or link cycles', ({ onTestFinished }) => {
  const repo = mkdtempSync(join(tmpdir(), 'desktop-workspace-fixture-'))
  onTestFinished(() => { rmSync(repo, { recursive: true, force: true }) })
  const source = join(repo, 'package')
  const root = join(repo, 'owned-runtime')
  const destination = join(root, 'node_modules', '@deepseek-ai', 'fixture')
  const link = (from: string, to: string): void => { symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir') }
  mkdirSync(join(source, 'lib', 'node_modules'), { recursive: true })
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  mkdirSync(join(source, '.git'), { recursive: true })
  mkdirSync(join(source, 'private'), { recursive: true })
  mkdirSync(join(source, 'profiles'), { recursive: true })
  mkdirSync(join(repo, 'presets'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/fixture', version: '1.0.0', files: ['lib/**/*', 'lib', 'node_modules', '.env', '.git', 'private', 'profiles', 'secret.key'],
    dsh: { configTrees: [{ path: '../presets', mount: 'config/agent-presets' }] },
  }))
  writeFileSync(join(source, 'lib', 'index.js'), 'export const fixture = true\n')
  writeFileSync(join(source, '.env'), 'FIXTURE_ONLY=excluded\n')
  writeFileSync(join(source, 'secret.key'), 'fixture-only excluded key\n')
  writeFileSync(join(source, 'private', 'data.json'), '{}')
  writeFileSync(join(source, 'profiles', 'fixture.json'), '{}')
  writeFileSync(join(repo, 'presets', 'cordis.yml'), '[]\n')
  writeFileSync(join(repo, 'presets', '.env'), 'FIXTURE_ONLY=excluded\n')
  link(source, join(source, 'lib', 'node_modules', 'cycle'))
  link(source, join(source, 'node_modules', 'cycle'))
  link(join(source, 'private'), join(source, 'lib', 'private-link'))
  link(source, destination)
  link(source, join(root, 'node_modules', 'third-party-fixture'))

  materializeWorkspaceHostPackages(root, repo)

  expect(lstatSync(destination).isSymbolicLink()).toBe(false)
  expect(realpathSync.native(destination)).toBe(join(realpathSync.native(root), 'node_modules', '@deepseek-ai', 'fixture'))
  expect(readFileSync(join(destination, 'lib', 'index.js'), 'utf8')).toBe('export const fixture = true\n')
  for (const excluded of ['node_modules', 'lib/node_modules', 'lib/private-link', '.env', '.git', 'private', 'profiles', 'secret.key']) {
    expect(existsSync(join(destination, excluded)), excluded).toBe(false)
  }
  expect(lstatSync(join(root, 'node_modules', 'third-party-fixture')).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(destination, 'config', 'agent-presets', 'cordis.yml'), 'utf8')).toBe('[]\n')
  expect(existsSync(join(destination, 'config', 'agent-presets', '.env'))).toBe(false)
  const manifest: unknown = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'))
  expect(manifest).toMatchObject({ dsh: { configTrees: [{ path: 'config/agent-presets' }] } })
})

it('refuses first-party sources outside the trusted workspace before reading or copying them', ({ onTestFinished }) => {
  const owned = mkdtempSync(join(tmpdir(), 'desktop-workspace-refusal-'))
  onTestFinished(() => { rmSync(owned, { recursive: true, force: true }) })
  const repo = join(owned, 'repo')
  const outside = join(owned, 'outside')
  const root = join(repo, 'owned-runtime')
  const destination = join(root, 'node_modules', '@deepseek-ai', 'fixture')
  mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => { materializeWorkspaceHostPackages(root, repo) }).toThrow('package source outside workspace')
  expect(lstatSync(destination).isSymbolicLink()).toBe(true)
})
