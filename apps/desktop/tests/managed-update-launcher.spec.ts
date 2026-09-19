import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import {
  completeDesktopManagedUpdateHandoff,
  launchDesktopManagedUpdate,
  isDesktopManagedUpdateHelperQuiescent,
} from '../src/managed-update-launcher.ts'
import { MANAGED_VERSION, managedCapability } from './managed-update-fixture.ts'

const selection = {
  kind: 'source' as const,
  manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/dsh-desktop-v${MANAGED_VERSION}/release.json`,
  manifestSha256: 'a'.repeat(64),
  assetSha256: 'b'.repeat(64),
}

const roots: string[] = []

async function quiescenceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-quiescence-'))
  roots.push(root)
  const node = join(root, 'node.exe'), helper = join(root, 'helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  const child = { pid: 456, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    on: vi.fn(), unref: vi.fn(), kill: vi.fn(() => true), stderr: undefined }
  let handoffPath = ''
  let now = 0
  const spawn = vi.fn((_command: string, args: readonly string[]) => {
    handoffPath = args[1]!
    return child
  })
  const waitForExit = vi.fn(async () => true)
  const sleep = vi.fn(async () => { now = 15_000 })
  const launch = () => launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'), nodeExecutable: node,
    nodeSha256: createHash('sha256').update('node').digest('hex'), helperBundle: helper,
    capability: managedCapability(), selection, installedSequence: 1, waitPids: [12, 34],
  }, { platform: 'win32', spawn: spawn as unknown as typeof import('node:child_process').spawn,
    now: () => now, sleep, waitForExit })
  return { root, node, child, spawn, sleep, waitForExit, launch,
    operationRoot: () => dirname(handoffPath),
    acknowledge: async () => {
      const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { token: string }
      await writeFile(join(dirname(handoffPath), 'ack.json'), JSON.stringify({
        schemaVersion: 1, token: handoff.token, manifestSha256: selection.manifestSha256, helperPid: child.pid,
      }))
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('recognizes only failures with launcher-owned quiescence evidence', async () => {
  expect(isDesktopManagedUpdateHelperQuiescent(new Error('helper did not start'))).toBe(false)
  expect(isDesktopManagedUpdateHelperQuiescent({ quiescent: true })).toBe(false)
  expect(isDesktopManagedUpdateHelperQuiescent(undefined)).toBe(false)
  const f = await quiescenceFixture()
  await rm(f.node)
  const failure: unknown = await f.launch().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(true)
  expect(f.spawn).not.toHaveBeenCalled()
})

it('preserves a synchronous spawn failure as safe only when no child was returned', async () => {
  const f = await quiescenceFixture()
  const failure = new Error('fixture spawn failed before child creation')
  f.spawn.mockImplementation(() => { throw failure })
  await expect(f.launch()).rejects.toBe(failure)
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(true)
  expect(f.waitForExit).not.toHaveBeenCalled()
})

it.each([true, false])('cleans up a post-spawn setup failure and reports confirmed exit=%s', async (exited) => {
  const f = await quiescenceFixture()
  const primary = new Error('fixture post-spawn setup failed')
  f.child.unref.mockImplementation(() => { throw primary })
  f.waitForExit.mockResolvedValue(exited)
  const failure: unknown = await f.launch().catch((error: unknown) => error)
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(f.waitForExit).toHaveBeenCalledExactlyOnceWith(f.child, 5000)
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(exited)
  if (exited) expect(failure).toMatchObject({ cause: primary })
  else {
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(primary)
  }
})

it('keeps primary and diagnostic-write failures after confirmed helper cleanup', async () => {
  const f = await quiescenceFixture()
  f.sleep.mockImplementation(async () => {
    await mkdir(join(f.operationRoot(), 'helper-startup-error.json'))
    throw new Error('fixture acknowledgement failed')
  })
  const failure: unknown = await f.launch().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(2)
  expect((failure as AggregateError).errors[0]).toMatchObject({ message: 'fixture acknowledgement failed' })
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(true)
})

it('does not classify a cancellation deadline or kill intent as helper exit', async () => {
  const f = await quiescenceFixture()
  f.waitForExit.mockResolvedValue(false)
  const failure: unknown = await f.launch().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(false)
})

it.each([false, true])('classifies a returned abandonment failure using observed signal exit=%s', async (exited) => {
  const f = await quiescenceFixture()
  f.sleep.mockImplementation(f.acknowledge)
  const acknowledgement = await f.launch()
  if (exited) f.child.signalCode = 'SIGTERM'
  await rm(f.operationRoot(), { recursive: true, force: true })
  const failure: unknown = await acknowledgement.abandon().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(isDesktopManagedUpdateHelperQuiescent(failure)).toBe(exited)
  expect(f.child.kill).not.toHaveBeenCalled()
})

it('refuses to execute a copied Node whose bytes differ from the sealed runtime hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-node-drift-'))
  roots.push(root)
  const node = join(root, 'node.exe')
  const helper = join(root, 'helper.mjs')
  await writeFile(node, 'changed executable')
  await writeFile(helper, 'helper')
  const spawn = vi.fn() as unknown as typeof import('node:child_process').spawn
  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'), nodeExecutable: node, nodeSha256: 'a'.repeat(64), helperBundle: helper,
    capability: managedCapability(), selection, installedSequence: 1, waitPids: [12],
  }, { spawn, platform: 'win32', now: () => 0, sleep: async () => {}, waitForExit: async () => true }))
    .rejects.toThrow('copied standalone Node failed release verification')
  expect(spawn).not.toHaveBeenCalled()
})

it('returns only after the detached helper acknowledges the one-time handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-launch-'))
  roots.push(root)
  const node = join(root, 'source-node.exe')
  const helper = join(root, 'source-helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  let handoffPath: string | undefined
  const fakeChild = {
    on: vi.fn(),
    stderr: new PassThrough(),
    pid: 456,
    exitCode: null as number | null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn(() => {
      fakeChild.exitCode = 1
      return true
    }),
  }
  const fakeSpawn = vi.fn((_command: string, args: readonly string[]) => {
    handoffPath = args[1]
    return fakeChild
  }) as unknown as typeof spawn
  let now = 0
  const result = await launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'),
    nodeExecutable: node, nodeSha256: createHash('sha256').update(await readFile(node)).digest('hex'),
    helperBundle: helper,
    capability: managedCapability(),
    selection,
    installedSequence: 1,
    waitPids: [12, 34],
  }, {
    spawn: fakeSpawn,
    platform: 'win32',
    now: () => now,
    waitForExit: async () => true,
    sleep: async () => {
      now += 50
      if (handoffPath === undefined) throw new Error('missing handoff path')
      const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { token: string }
      await writeFile(join(dirname(handoffPath), 'ack.json'), JSON.stringify({
        schemaVersion: 1,
        token: handoff.token,
        manifestSha256: 'a'.repeat(64),
        helperPid: 456,
      }))
    },
  })

  expect(result.helperPid).toBe(456)
  expect(fakeChild.unref).toHaveBeenCalledOnce()
  expect(fakeSpawn).toHaveBeenCalledOnce()
  const handoff = JSON.parse(await readFile(handoffPath!, 'utf8')) as { waitPids: number[] }
  expect(handoff.waitPids).toEqual([12, 34])
})

it('does not stop the Host or quit before helper acknowledgement', async () => {
  const order: string[] = []
  let acknowledge!: () => void
  const handoff = completeDesktopManagedUpdateHandoff(
    () => new Promise((resolve) => {
      acknowledge = () => {
        order.push('ack')
        resolve({
          operationRoot: 'root',
          helperPid: 1,
          token: 'a'.repeat(64),
          abandon: async () => { order.push('abandon') },
        })
      }
    }),
    () => {
      order.push('claim')
      return () => { order.push('release') }
    },
    async () => { order.push('stop') },
    () => { order.push('quit') },
  )
  await Promise.resolve()
  expect(order).toEqual([])
  acknowledge()
  await handoff
  expect(order).toEqual(['ack', 'claim', 'stop', 'quit'])
})

it('rejects an acknowledgement for a different manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-launch-'))
  roots.push(root)
  const node = join(root, 'source-node.exe')
  const helper = join(root, 'source-helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  let handoffPath: string | undefined
  const fakeChild = {
    on: vi.fn(),
    stderr: new PassThrough(),
    pid: 456,
    exitCode: null as number | null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn(() => {
      fakeChild.exitCode = 1
      return true
    }),
  }
  const fakeSpawn = vi.fn((_command: string, args: readonly string[]) => {
    handoffPath = args[1]
    return fakeChild
  }) as unknown as typeof spawn

  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'),
    nodeExecutable: node, nodeSha256: createHash('sha256').update(await readFile(node)).digest('hex'),
    helperBundle: helper,
    capability: managedCapability(),
    selection,
    installedSequence: 1,
    waitPids: [12],
  }, {
    spawn: fakeSpawn,
    platform: 'win32',
    now: () => 0,
    waitForExit: async () => true,
    sleep: async () => {
      if (handoffPath === undefined) throw new Error('missing handoff path')
      const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { token: string }
      await writeFile(join(dirname(handoffPath), 'ack.json'), JSON.stringify({
        schemaVersion: 1,
        token: handoff.token,
        manifestSha256: 'c'.repeat(64),
        helperPid: 456,
      }))
    },
  })).rejects.toThrow(/acknowledgement is invalid/u)
  expect(fakeChild.kill).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(dirname(handoffPath!), 'cancelled.json'), 'utf8')))
    .toMatchObject({ schemaVersion: 1 })
})

it('cancels the exact helper when acknowledgement times out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-launch-'))
  roots.push(root)
  const node = join(root, 'source-node.exe')
  const helper = join(root, 'source-helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  const fakeChild = {
    on: vi.fn(),
    stderr: new PassThrough(),
    pid: 456,
    exitCode: null as number | null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn(() => {
      fakeChild.exitCode = 1
      return true
    }),
  }
  let now = 0

  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'),
    nodeExecutable: node, nodeSha256: createHash('sha256').update(await readFile(node)).digest('hex'),
    helperBundle: helper,
    capability: managedCapability(),
    selection,
    installedSequence: 1,
    waitPids: [12],
  }, {
    spawn: vi.fn(() => fakeChild) as unknown as typeof spawn,
    platform: 'win32',
    now: () => now,
    waitForExit: async () => true,
    sleep: async () => { now = 15_000 },
  })).rejects.toThrow(/did not acknowledge/u)

  expect(fakeChild.kill).toHaveBeenCalledOnce()
  const operations = await readdir(join(root, 'operations'))
  expect(JSON.parse(await readFile(join(root, 'operations', operations[0]!, 'cancelled.json'), 'utf8')))
    .toMatchObject({ schemaVersion: 1, token: operations[0] })
})

it('rolls back quit ownership and cancels the helper when Host stop fails', async () => {
  const order: string[] = []
  const failure = new Error('Host stop failed')

  await expect(completeDesktopManagedUpdateHandoff(
    async () => ({
      operationRoot: 'root',
      helperPid: 1,
      token: 'a'.repeat(64),
      abandon: async () => { order.push('abandon') },
    }),
    () => {
      order.push('claim')
      return () => { order.push('release') }
    },
    async () => {
      order.push('stop')
      throw failure
    },
    () => { order.push('quit') },
  )).rejects.toBe(failure)

  expect(order).toEqual(['claim', 'stop', 'release', 'abandon'])
})

it('persists bounded redacted bootstrap stderr without recording the handoff token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-stderr-'))
  roots.push(root)
  const node = join(root, 'node.exe')
  const helper = join(root, 'helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  const stderr = new PassThrough()
  const child = { pid: 456, exitCode: null as number | null, signalCode: null, stderr, on: vi.fn(), unref: vi.fn(), kill: vi.fn() }
  let handoffPath = ''
  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'), nodeExecutable: node, nodeSha256: createHash('sha256').update(await readFile(node)).digest('hex'), helperBundle: helper,
    capability: managedCapability(), selection, installedSequence: 1, waitPids: [12],
  }, {
    spawn: vi.fn((_node, args: string[]) => {
      handoffPath = args[1]!
      return child
    }) as unknown as typeof spawn,
    platform: 'win32', now: () => 0, waitForExit: async () => true,
    sleep: async () => {
      const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { token: string }
      stderr.write(Buffer.from([
        'x'.repeat(100_000), handoff.token,
        ['Authorization:', 'Bearer', 'credential-value'].join(' '),
        ['https://example.test/', '?secret=', 'hidden'].join(''),
        'ERR_MODULE_NOT_FOUND semver',
      ].join('\n')))
      child.exitCode = 1
    },
  })).rejects.toThrow(/helper exited before acknowledgement \(1\).*helper-startup-error.json/u)
  const text = await readFile(join(dirname(handoffPath), 'helper-startup-error.json'), 'utf8')
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8')) as { token: string }
  expect(Buffer.byteLength(text)).toBeLessThan(20_000)
  expect(text).not.toContain(handoff.token)
  expect(text).not.toContain('credential-value')
  expect(text).not.toContain('secret=hidden')
  expect(JSON.parse(text)).toMatchObject({
    schemaVersion: 1, phase: 'before-acknowledgement', exitCode: 1, stderrTruncated: true,
  })
  expect(text).toContain('ERR_MODULE_NOT_FOUND semver')
  expect(stderr.destroyed).toBe(true)
})

it('records a spawn failure without waiting for or killing an unstarted process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-spawn-'))
  roots.push(root)
  const node = join(root, 'node.exe')
  const helper = join(root, 'helper.mjs')
  await writeFile(node, 'node')
  await writeFile(helper, 'helper')
  const child = { pid: undefined, exitCode: null, signalCode: null, stderr: new PassThrough(), on: vi.fn(), unref: vi.fn(), kill: vi.fn() }
  const waitForExit = vi.fn()
  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'), nodeExecutable: node, nodeSha256: createHash('sha256').update(await readFile(node)).digest('hex'), helperBundle: helper,
    capability: managedCapability(), selection, installedSequence: 1, waitPids: [12],
  }, {
    spawn: vi.fn(() => child) as unknown as typeof spawn,
    platform: 'win32', now: () => 0, waitForExit, sleep: vi.fn(),
  })).rejects.toThrow(/helper process did not start.*helper-startup-error/u)
  expect(child.kill).not.toHaveBeenCalled()
  expect(waitForExit).not.toHaveBeenCalled()
  const [operation] = await readdir(join(root, 'operations'))
  expect(JSON.parse(await readFile(join(root, 'operations', operation!, 'helper-startup-error.json'), 'utf8')))
    .toMatchObject({ phase: 'before-acknowledgement', exitCode: null })
})
