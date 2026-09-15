import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import {
  completeDesktopManagedUpdateHandoff,
  launchDesktopManagedUpdate,
} from '../src/managed-update-launcher.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
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
    pid: 456,
    exitCode: null as number | null,
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
    nodeExecutable: node,
    helperBundle: helper,
    capability: {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'a'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'b'.repeat(40) },
    },
    selectedManifest: 'source',
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
    pid: 456,
    exitCode: null as number | null,
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
    nodeExecutable: node,
    helperBundle: helper,
    capability: {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'a'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'b'.repeat(40) },
    },
    selectedManifest: 'source',
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
    pid: 456,
    exitCode: null as number | null,
    unref: vi.fn(),
    kill: vi.fn(() => {
      fakeChild.exitCode = 1
      return true
    }),
  }
  let now = 0

  await expect(launchDesktopManagedUpdate({
    operationsRoot: join(root, 'operations'),
    nodeExecutable: node,
    helperBundle: helper,
    capability: {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'a'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'b'.repeat(40) },
    },
    selectedManifest: 'source',
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
