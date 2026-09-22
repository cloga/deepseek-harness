/** Exercise the staged hook and read-only PR guard against real isolated Git repositories. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-vendor-manifest.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vendor-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Vendor guard fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
    '-c', `core.hooksPath=${join(root, '.git', 'fixture-no-hooks')}`, ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path, content = 'changed\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commit = () => { git('add', '--all'); git('commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD') }
  git('init', '--quiet')
  write('vendor/README.md', '# Local modifications\n')
  write('vendor/example/src/index.ts', 'export const value = 1\n')
  write('vendor/example/bin.js', '// initial binary entry\n')
  write('vendor/example/package.json', '{}\n')
  const base = commit()
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  return { root, git, write, commit, base, run }
}

function verdict(result, code) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, code, result.stdout + result.stderr)
}

test('staged default accepts an empty index and ignores unstaged source changes', t => {
  const f = fixture(t)
  verdict(f.run(), 0)
  f.write('vendor/example/src/index.ts')
  verdict(f.run(), 0)
})

test('staged source changes require a staged vendor modification log', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  f.git('add', 'vendor/example/src/index.ts')
  verdict(f.run(), 1)
  f.write('vendor/README.md')
  verdict(f.run(), 1)
  f.git('add', 'vendor/README.md')
  verdict(f.run(), 0)
})

test('retains the hook bin.js prefix rule without including ordinary manifests', t => {
  const f = fixture(t)
  f.write('vendor/example/package.json', '{"private":true}\n')
  f.git('add', '--all')
  verdict(f.run(), 0)
  for (const path of ['vendor/example/bin.js', 'vendor/example/bin.js.map']) {
    f.write(path)
    f.git('add', path)
    const result = f.run()
    verdict(result, 1)
    assert.ok(result.stderr.includes(path))
  }
})

test('PR mode rejects committed source changes even with a clean index', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  const head = f.commit()
  assert.equal(f.git('status', '--porcelain'), '')
  verdict(f.run(), 0)
  const result = f.run('--base', f.base, '--head', head)
  verdict(result, 1)
  assert.match(result.stderr, /vendor\/example\/src\/index\.ts/)
})

test('PR mode accepts the vendor log in the same base-to-head change', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  f.write('vendor/README.md')
  const head = f.commit()
  verdict(f.run('--head', head, '--base', f.base), 0)
})

test('PR mode includes moved-away and deleted source paths', t => {
  const f = fixture(t)
  f.git('mv', 'vendor/example/src/index.ts', 'moved.ts')
  f.git('rm', 'vendor/example/bin.js')
  const head = f.commit()
  const result = f.run('--base', f.base, '--head', head)
  verdict(result, 1)
  assert.match(result.stderr, /vendor\/example\/src\/index\.ts/)
  assert.match(result.stderr, /vendor\/example\/bin\.js/)
})

test('PR mode does not use unrelated staged or working-tree log changes', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  const head = f.commit()
  f.write('vendor/README.md')
  f.git('add', 'vendor/README.md')
  f.write('untracked.txt')
  const index = readFileSync(join(f.root, '.git', 'index'))
  const status = f.git('status', '--porcelain')
  const diff = f.git('diff', '--cached')
  verdict(f.run('--base', f.base, '--head', head), 1)
  assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), index)
  assert.equal(f.git('status', '--porcelain'), status)
  assert.equal(f.git('diff', '--cached'), diff)
  assert.equal(readFileSync(join(f.root, 'untracked.txt'), 'utf8'), 'changed\n')
  assert.equal(f.git('rev-parse', 'HEAD'), head)
})

test('deleting the log cannot satisfy staged or PR source-change requirements', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  f.git('add', '--all')
  f.git('rm', 'vendor/README.md')
  verdict(f.run(), 1)
  const head = f.commit()
  f.write('vendor/README.md', 'Uncommitted replacement must not count\n')
  verdict(f.run('--base', f.base, '--head', head), 1)
})

test('moving the log away cannot satisfy staged or PR source-change requirements', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  f.git('add', '--all')
  f.git('mv', 'vendor/README.md', 'vendor/OLD-README.md')
  verdict(f.run(), 1)
  const head = f.commit()
  verdict(f.run('--base', f.base, '--head', head), 1)
})

test('a symlink log is rejected based on the index and head rather than working-tree bytes', t => {
  const f = fixture(t)
  f.write('vendor/example/src/index.ts')
  f.git('add', '--all')
  const blob = f.git('hash-object', 'vendor/README.md')
  f.git('update-index', '--cacheinfo', `120000,${blob},vendor/README.md`)
  verdict(f.run(), 1)
  f.git('commit', '--quiet', '-m', 'symlink fixture')
  const head = f.git('rev-parse', 'HEAD')
  verdict(f.run('--base', f.base, '--head', head), 1)
})

test('NUL path parsing retains spaces in vendor source names', t => {
  const f = fixture(t)
  const path = 'vendor/example/src/name with spaces.ts'
  f.write(path)
  const head = f.commit()
  const result = f.run('--base', f.base, '--head', head)
  verdict(result, 1)
  assert.ok(result.stderr.includes(path))
})

test('rejects partial, duplicate, unknown, symbolic, and absent revisions', t => {
  const f = fixture(t)
  for (const args of [
    ['--base', f.base], ['--head', f.base],
    ['--base', f.base, '--base', f.base], ['--base', f.base, '--other', f.base],
    ['--base', 'HEAD', '--head', f.base], ['--base', f.base, '--head'],
    ['--base', f.base, '--head', '0'.repeat(40)], ['--cached'],
  ]) verdict(f.run(...args), 1)
})

test('the shell hook delegates its default and explicit arguments to the same guard', () => {
  const wrapper = readFileSync(new URL('./check-vendor-manifest.sh', import.meta.url), 'utf8')
  assert.ok(wrapper.includes('exec node "$(dirname "$0")/check-vendor-manifest.mjs" "$@"'))
})

test('PR CI runs the guard and whitespace check on explicit event revisions as a required job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const job = workflow.split('  source-guards:\n')[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0]
  assert.ok(job)
  assert.ok(job.includes('runs-on: windows-2025'))
  assert.ok(job.includes('shell: pwsh'))
  assert.ok(job.includes('fetch-depth: 0'))
  assert.ok(job.includes('persist-credentials: false'))
  assert.ok(job.includes('node --test scripts/check-vendor-manifest.test.mjs'))
  assert.ok(job.includes('PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}'))
  assert.ok(job.includes('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}'))
  assert.ok(job.includes('node scripts/check-vendor-manifest.mjs --base $env:PR_BASE_SHA --head $env:PR_HEAD_SHA'))
  assert.ok(job.includes('git diff --no-ext-diff --check $env:PR_BASE_SHA $env:PR_HEAD_SHA --'))
  assert.equal(job.match(/if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/g)?.length, 3)
  assert.doesNotMatch(job, /continue-on-error|\sif:/)
  assert.match(workflow.split('  all-checks-passed:\n')[1] ?? '', /needs: \[[^\]\n]*\bsource-guards\b/)
})
