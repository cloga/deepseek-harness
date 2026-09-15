import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  benchmarkNpmResolution,
  benchmarkNpmResolutionTestCaseTimeoutMs,
  benchmarkNpmResolutionTestTimeoutMs,
  buildRegistryIndex,
  parseBenchmarkOptions,
  publishWorkspaceRange,
  removeNpmResolutionConsumer,
  resolveNpmPackageLock,
  runCommandWithTimeout,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'

const roots: string[] = []
const npmResolutionTimeoutMs = benchmarkNpmResolutionTestTimeoutMs()
const npmResolutionTestCaseTimeoutMs = benchmarkNpmResolutionTestCaseTimeoutMs()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(root: string, path: string, value: unknown): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}

function processCanExecute(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('npm resolution benchmark', () => {
  it('parses repeat, timeout, threshold, and ref options', () => {
    expect(parseBenchmarkOptions([])).toEqual({ runs: 1, timeoutMs: 300_000 })
    expect(parseBenchmarkOptions([
      '--runs', '3', '--timeout-ms', '45000', '--max-ms', '20000', '--ref', 'master',
    ])).toEqual({ runs: 3, timeoutMs: 45_000, maxMs: 20_000, ref: 'master' })
    expect(parseBenchmarkOptions(['--', '--runs', '2'])).toEqual({ runs: 2, timeoutMs: 300_000 })
    expect(() => parseBenchmarkOptions(['--runs', '0'])).toThrow('--runs must be a positive integer')
  })

  it('inherits the bounded coverage-lane timeout without lowering the normal floor', () => {
    expect(benchmarkNpmResolutionTestTimeoutMs({})).toBe(10_000)
    expect(benchmarkNpmResolutionTestTimeoutMs({ DSH_COVERAGE_TEST_TIMEOUT_MS: '5000' })).toBe(10_000)
    expect(benchmarkNpmResolutionTestTimeoutMs({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' })).toBe(80_000)
    expect(benchmarkNpmResolutionTestCaseTimeoutMs({})).toBe(20_000)
    expect(benchmarkNpmResolutionTestCaseTimeoutMs({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' })).toBe(90_000)
    expect(() => benchmarkNpmResolutionTestTimeoutMs({ DSH_COVERAGE_TEST_TIMEOUT_MS: 'invalid' }))
      .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must be a positive integer')
    expect(() => benchmarkNpmResolutionTestTimeoutMs({ DSH_COVERAGE_TEST_TIMEOUT_MS: '300001' }))
      .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must not exceed 300000')
  })

  it('retries only transient Windows cleanup failures with bounded backoff', async () => {
    const tempRoot = join(tmpdir(), 'benchmark-cleanup-test-root')
    const target = join(tempRoot, 'dsh-npm-resolution-owned')
    const waits: number[] = []
    let attempts = 0
    await removeNpmResolutionConsumer(target, {
      tempRoot,
      platform: 'win32',
      remove: () => {
        attempts++
        if (attempts < 4) {
          const codes = ['EPERM', 'EBUSY', 'ENOTEMPTY']
          throw Object.assign(new Error('busy'), { code: codes[attempts - 1] })
        }
      },
      wait: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })
    expect(attempts).toBe(4)
    expect(waits).toEqual([100, 200, 300])
  })

  it('fails after the bounded Windows cleanup retries are exhausted', async () => {
    const tempRoot = join(tmpdir(), 'benchmark-cleanup-test-root')
    const target = join(tempRoot, 'dsh-npm-resolution-owned')
    const failure = Object.assign(new Error('still busy'), { code: 'EPERM' })
    let attempts = 0
    await expect(removeNpmResolutionConsumer(target, {
      tempRoot,
      platform: 'win32',
      maxRetries: 2,
      remove: () => {
        attempts++
        throw failure
      },
      wait: () => Promise.resolve(),
    })).rejects.toBe(failure)
    expect(attempts).toBe(3)
  })

  it('does not retry a non-transient cleanup failure', async () => {
    const tempRoot = join(tmpdir(), 'benchmark-cleanup-test-root')
    const target = join(tempRoot, 'dsh-npm-resolution-owned')
    const failure = Object.assign(new Error('access denied'), { code: 'EACCES' })
    const wait = vi.fn((_ms: number) => Promise.resolve())
    const remove = vi.fn(() => { throw failure })
    await expect(removeNpmResolutionConsumer(target, {
      tempRoot,
      platform: 'win32',
      remove,
      wait,
    })).rejects.toBe(failure)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  it('refuses cleanup outside the private benchmark directory namespace', async () => {
    const tempRoot = join(tmpdir(), 'benchmark-cleanup-test-root')
    const remove = vi.fn()
    await expect(removeNpmResolutionConsumer(tempRoot, { tempRoot, remove })).rejects.toThrow('refusing to remove')
    await expect(removeNpmResolutionConsumer(join(tempRoot, 'other'), { tempRoot, remove }))
      .rejects.toThrow('refusing to remove')
    await expect(removeNpmResolutionConsumer(join(tempRoot, '..', 'dsh-npm-resolution-outside'), {
      tempRoot,
      remove,
    })).rejects.toThrow('refusing to remove')
    expect(remove).not.toHaveBeenCalled()
  })

  it('projects workspace protocols to published ranges', () => {
    expect(publishWorkspaceRange('workspace:^', '1.2.3')).toBe('^1.2.3')
    expect(publishWorkspaceRange('workspace:~', '1.2.3')).toBe('~1.2.3')
    expect(publishWorkspaceRange('workspace:*', '1.2.3')).toBe('1.2.3')
    expect(publishWorkspaceRange('^4.0.0', '1.2.3')).toBe('^4.0.0')
  })

  it('combines installed metadata with current publishable workspace fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-registry-index-'))
    roots.push(root)
    writeJson(root, 'node_modules/.pnpm/external@2.0.0/node_modules/external/package.json', {
      name: 'external',
      version: '2.0.0',
      dependencies: { child: '^1.0.0' },
      devDependencies: { ignored: '^1.0.0' },
    })
    writeJson(root, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': 'workspace:^', external: '^2.0.0' },
      devDependencies: { ignored: 'workspace:^' },
    })
    writeJson(root, 'packages/core/child/package.json', {
      name: '@deepseek-ai/dsh-child',
      version: '0.1.0',
    })

    const index = buildRegistryIndex(root)

    expect(index.get('external')?.get('2.0.0')).toMatchObject({ dependencies: { child: '^1.0.0' } })
    expect(index.get('@deepseek-ai/dsh')?.get('0.1.0')).toEqual({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.1.0', external: '^2.0.0' },
    })
  })

  it('runs npm against the local registry without requesting an archive', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }]]),
    ]])
    const result = await benchmarkNpmResolution(index, '0.1.0', npmResolutionTimeoutMs)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.registryRequests).toBeGreaterThan(0)
    expect(result.archiveRequests).toBe(0)
    expect(result.unknownPackages).toEqual([])
  }, npmResolutionTestCaseTimeoutMs)

  it('returns npm placement for two aliased package versions without requesting archives', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([
        ['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }],
        ['0.2.0', { name: '@deepseek-ai/dsh', version: '0.2.0' }],
      ]),
    ]])

    const result = await resolveNpmPackageLock(index, {
      '@deepseek-ai/dsh': '0.2.0',
      'dsh-previous': 'npm:@deepseek-ai/dsh@0.1.0',
    }, npmResolutionTimeoutMs)

    expect(result.archiveRequests).toBe(0)
    expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh']?.version).toBe('0.2.0')
    expect(result.packageLock.packages['node_modules/dsh-previous']).toMatchObject({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
    })
  }, npmResolutionTestCaseTimeoutMs)

  it('isolates peer resolution from inherited npm configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hostile-npm-config-'))
    roots.push(root)
    const userConfig = join(root, 'user.npmrc')
    writeFileSync(userConfig, '@deepseek-ai:registry=http://127.0.0.1:1/\nlegacy-peer-deps=true\nomit=peer\n')
    const previous = {
      userConfig: process.env.npm_config_userconfig,
      legacyPeerDeps: process.env.npm_config_legacy_peer_deps,
      omit: process.env.npm_config_omit,
    }
    process.env.npm_config_userconfig = userConfig
    process.env.npm_config_legacy_peer_deps = 'true'
    process.env.npm_config_omit = 'peer'
    try {
      const index: RegistryIndex = new Map([
        ['@deepseek-ai/dsh', new Map([['0.1.0', {
          name: '@deepseek-ai/dsh',
          version: '0.1.0',
          peerDependencies: { '@deepseek-ai/dsh-peer': '1.0.0' },
        }]])],
        ['@deepseek-ai/dsh-peer', new Map([['1.0.0', {
          name: '@deepseek-ai/dsh-peer',
          version: '1.0.0',
        }]])],
      ])

      const result = await resolveNpmPackageLock(index, { '@deepseek-ai/dsh': '0.1.0' }, npmResolutionTimeoutMs)

      expect(result.archiveRequests).toBe(0)
      expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh-peer']?.version).toBe('1.0.0')
    } finally {
      if (previous.userConfig === undefined) delete process.env.npm_config_userconfig
      else process.env.npm_config_userconfig = previous.userConfig
      if (previous.legacyPeerDeps === undefined) delete process.env.npm_config_legacy_peer_deps
      else process.env.npm_config_legacy_peer_deps = previous.legacyPeerDeps
      if (previous.omit === undefined) delete process.env.npm_config_omit
      else process.env.npm_config_omit = previous.omit
    }
  }, npmResolutionTestCaseTimeoutMs)

  it.skipIf(process.platform === 'win32')('force-kills a timed-out process tree', async () => {
    const source = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGTERM', () => {})",
      'const child = spawn(process.execPath, [\'-e\', "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: \'ignore\' })',
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    let descendantPid: number | undefined
    try {
      const result = await runCommandWithTimeout(process.execPath, ['-e', source], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1_000,
        terminationGraceMs: 100,
      })
      const reportedPid = Number.parseInt(result.output.trim(), 10)
      if (!Number.isSafeInteger(reportedPid)) throw new Error(`child reported invalid pid ${result.output.trim()}`)
      descendantPid = reportedPid

      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      await expect.poll(() => processCanExecute(reportedPid), { timeout: 5_000 }).toBe(false)
    } finally {
      if (descendantPid !== undefined && Number.isSafeInteger(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
  })
})
