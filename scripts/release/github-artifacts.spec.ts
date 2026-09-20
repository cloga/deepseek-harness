/** The retired entry refuses legacy inputs without credentials, network calls or artifact mutations. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('./github-artifacts.ts', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// No ambient credentials reach the child. These selectors previously admitted
// the guard, so refusal cannot depend on a missing token or malformed input.
const legacyEnvironment = {
  GITHUB_REPOSITORY: 'cloga/deepseek-harness', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/tags/dsh-v0.1.6-alpha.5', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'synthetic-token',
  RELEASE_PUBLISH: 'true', RELEASE_VERSION: '0.1.6-alpha.5',
  RELEASE_REVIEWED_HEAD: 'b'.repeat(40), RELEASE_MERGED_COMMIT: 'a'.repeat(40),
  RELEASE_CI_RUN: '100', RELEASE_POLICY_RUN: '101', RELEASE_ARTIFACT_ID: '500',
}

// Tripwires run in the actual CLI process, before its entry. They emit an
// observable failure even if a regressed writer catches the thrown error.
const tripwireSource = `
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const refuse = () => { process.stderr.write('UNEXPECTED_RELEASE_EFFECT\\n'); throw new Error('Release effect forbidden') }
globalThis.fetch = refuse
for (const name of ['writeFile', 'appendFile', 'write', 'writev', 'rename', 'rm', 'unlink', 'mkdir', 'rmdir', 'truncate', 'ftruncate', 'copyFile', 'cp', 'link', 'symlink', 'chmod', 'chown', 'utimes']) {
  for (const key of [name, name + 'Sync']) if (key in fs) fs[key] = refuse
  if (name in fs.promises) fs.promises[name] = refuse
}
fs.createWriteStream = refuse
for (const owner of [http, https]) { owner.request = refuse; owner.get = refuse }
net.connect = refuse
net.createConnection = refuse
tls.connect = refuse
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = refuse
syncBuiltinESMExports()
`

const commands = [
  { name: 'guard', args: ['guard'] },
  { name: 'publish', args: ['publish', '$directory', '$journal'] },
  { name: 'publish with recovery flags', args: ['publish', '$directory', '$journal', '--force', '--resume'] },
  { name: 'publish without paths', args: ['publish'] },
  { name: 'empty command', args: [] },
  { name: 'help', args: ['--help'] },
  { name: 'unknown command', args: ['seal', '$directory'] },
]

for (const [environment, selectors] of [['empty', {}], ['formerly admitted', legacyEnvironment]] as const) {
  describe(`${environment} environment`, () => {
    it.each(commands)('refuses $name under plain Node without side effects', ({ args }) => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-retired-release-'))
      roots.push(root)
      const preload = join(root, 'tripwire.mjs')
      const artifact = join(root, 'member.tgz')
      const journal = join(root, 'journal.jsonl')
      writeFileSync(preload, tripwireSource)
      writeFileSync(artifact, 'original artifact bytes')
      const before = readdirSync(root).sort()
      const argv = args.map(value => value === '$directory' ? root : value === '$journal' ? journal : value)
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, entry, ...argv], {
        cwd: root, env: selectors, encoding: 'utf8', timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Core/Web GitHub artifact publication is retired.')
      expect(result.stderr).not.toContain('UNEXPECTED_RELEASE_EFFECT')
      expect(result.stderr).not.toContain('synthetic-token')
      expect(readdirSync(root).sort()).toEqual(before)
      expect(readFileSync(artifact, 'utf8')).toBe('original artifact bytes')
      expect(existsSync(journal)).toBe(false)
    })
  })
}

it.each(['write', 'fetch'])('detects an attempted %s instead of accepting an ineffective tripwire', (effect) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-retired-tripwire-'))
  roots.push(root)
  const preload = join(root, 'tripwire.mjs')
  const output = join(root, 'forbidden.txt')
  writeFileSync(preload, tripwireSource)
  const code = effect === 'write'
    ? "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'unexpected')"
    : "await fetch('https://release-tripwire.invalid/')"
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', code, output], {
    cwd: root, env: {}, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('UNEXPECTED_RELEASE_EFFECT')
  expect(existsSync(output)).toBe(false)
})

it('retains only the refusal entry, without the old imported writer or seal helpers', () => {
  const source = readFileSync(entry, 'utf8')
  expect(source).not.toMatch(/\b(?:import|export|require|fetch)\b/)
  expect(source).not.toMatch(/process\.(?:env|argv)/)
  for (const name of ['github-artifacts-evidence.ts', 'github-artifacts-prepare.ts']) {
    expect(existsSync(new URL(name, import.meta.url))).toBe(false)
  }
})
