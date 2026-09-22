import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createPackagingRun, packagingOutputRedactor } from '../scripts/packaging-run.mjs'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(name)))

describe('packaging run records', () => {
  it('redacts credential values across every byte split', () => {
    const secret = 'test-口令-!secret'
    const bytes = Buffer.from(`before ${secret} after`)
    for (let split = 0; split <= bytes.length; split++) {
      let output = ''
      const redactor = packagingOutputRedactor([secret], (text) => { output += text })
      redactor.write(bytes.subarray(0, split))
      redactor.write(bytes.subarray(split))
      redactor.end()
      expect(output).toBe('before [REDACTED] after')
    }
  })

  it('retains redacted output and prevents a later stage after a failed child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-record-'))
    try {
      const run = createPackagingRun(root, { target: 'fixture' })
      await expect(run.run('failure', process.execPath, ['-e', "process.stdout.write(process.env.TEST_SECRET_KEY);process.stderr.write('fixture failure');process.exitCode=1"], {
        cwd: root, env: { ...environment, TEST_SECRET_KEY: 'test-secret-value' },
      })).rejects.toThrow('failure failed')
      await expect(run.run('not-started', process.execPath, ['--version'], { cwd: root, env: environment })).rejects.toThrow('run is blocked')
      run.finish(false)
      expect(await readFile(join(run.directory, 'stdout.log'), 'utf8')).toBe('[REDACTED]')
      expect(await readFile(join(run.directory, 'stderr.log'), 'utf8')).toBe('fixture failure')
      const events = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
      expect(events).toContain('stage-end')
      expect(events).not.toContain('not-started')
      expect(JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'))).toMatchObject({ success: false })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('kills the stage and its descendant on a fatal marker before either exits voluntarily', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-tree-'))
    try {
      const run = createPackagingRun(root, {})
      await expect(run.run('fatal', process.execPath, [resolve(import.meta.dirname, 'fixtures/packaging-failure.mjs')], {
        cwd: root, env: environment,
      })).rejects.toThrow('fatal failed')
      const descendant = JSON.parse(await readFile(join(run.directory, 'descendant.json'), 'utf8')) as { pid: number }
      expect(() => process.kill(descendant.pid, 0)).toThrow()
      const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; fatalObserved?: boolean; terminationError?: boolean })
      expect(events.at(-1)).toMatchObject({ type: 'stage-end', fatalObserved: true, terminationError: false })
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(['delayed-exit', 'probe-error', 'deadline'] as const)(
    'awaits POSIX group absence after direct-child close: %s', async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-package-group-'))
      const pid = 13_107_001
      const child = Object.assign(new EventEmitter(), {
        pid, stdout: new PassThrough(), stderr: new PassThrough(),
      })
      let work: Promise<void> | undefined
      let assertion: Promise<void> | undefined
      let probes = 0
      let settled = false
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      // Only this stage is synthetic; the other cases retain real subprocesses.
      vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)
      const kill = vi.fn<typeof process.kill>((target, signal) => {
        expect(target).toBe(-pid)
        if (signal === 'SIGKILL') return true
        expect(signal).toBe(0)
        probes++
        if (outcome === 'probe-error') throw Object.assign(new Error('probe denied'), { code: 'EPERM' })
        if (outcome === 'delayed-exit' && probes === 3) {
          throw Object.assign(new Error('group absent'), { code: 'ESRCH' })
        }
        return true
      })
      // Exercise the POSIX branch on every host, without sending any real signal.
      vi.stubGlobal('process', new Proxy(process, {
        get(target, key) {
          if (key === 'platform') return 'linux'
          if (key === 'kill') return kill
          return Reflect.get(target, key, target) as unknown
        },
      }))
      try {
        const run = createPackagingRun(root, {})
        work = run.run('fatal', process.execPath, [], { cwd: root, env: environment })
        assertion = expect(work).rejects.toThrow('fatal failed')
        void work.then(() => { settled = true }, () => { settled = true })
        child.stderr.write('DSH_DESKTOP_PACKAGING_FATAL\n')
        child.emit('close', null, 'SIGKILL')
        await Promise.resolve()
        if (outcome === 'delayed-exit') {
          expect(probes).toBe(1)
          expect(settled).toBe(false)
          await vi.advanceTimersByTimeAsync(25)
          expect(probes).toBe(2)
          expect(settled).toBe(false)
          await vi.advanceTimersByTimeAsync(25)
          expect(probes).toBe(3)
        } else if (outcome === 'deadline') {
          await vi.advanceTimersByTimeAsync(9_999)
          expect(settled).toBe(false)
          await vi.advanceTimersByTimeAsync(1)
        }
        await assertion
        expect(settled).toBe(true)
        if (outcome === 'probe-error') expect(probes).toBe(1)
        expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1)
        const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n')
          .map(line => JSON.parse(line) as { type: string; terminationError?: boolean })
        expect(events.at(-1)).toMatchObject({
          type: 'stage-end', fatalObserved: true, terminationError: outcome !== 'delayed-exit',
        })
        await expect(run.run('later', process.execPath, [], { cwd: root, env: environment })).rejects.toThrow('blocked')
        run.finish(true)
        expect(JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'))).toMatchObject({ success: false })
      } finally {
        child.emit('close', null, 'SIGKILL')
        await vi.runAllTimersAsync()
        await work?.catch(() => undefined)
        await assertion?.catch(() => undefined)
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        vi.useRealTimers()
        child.stdout.destroy()
        child.stderr.destroy()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('fails closed when the output journal cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-log-failure-'))
    try {
      const run = createPackagingRun(root, {})
      await rm(join(run.directory, 'stdout.log'))
      await mkdir(join(run.directory, 'stdout.log'))
      await expect(run.run('output', process.execPath, ['-e', "process.stdout.write('fixture');setInterval(()=>{},1000)"], {
        cwd: root, env: environment,
      })).rejects.toThrow('output failed')
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records successful stages without creating a release completion record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-success-'))
    try {
      const run = createPackagingRun(root, {})
      await run.run('version', process.execPath, ['--version'], { cwd: root, env: environment })
      run.finish(true)
      expect(JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'))).toMatchObject({ success: true })
      expect(await readFile(join(run.directory, 'events.jsonl'), 'utf8')).toContain('stage-spawn')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records a stage deadline separately from child exit and refuses subsequent stages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-deadline-'))
    try {
      const run = createPackagingRun(root, {})
      await expect(run.run('deadline', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: root, env: environment, timeoutMs: 50,
      })).rejects.toThrow('deadline failed')
      const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { type: string; childPid?: number })
      expect(events.at(-1)).toMatchObject({ type: 'stage-end', timedOut: true, fatalObserved: true, terminationError: false })
      expect(() => process.kill(events.find(row => row.type === 'stage-spawn')!.childPid!, 0)).toThrow()
      await expect(run.run('later', process.execPath, ['--version'], { cwd: root, env: environment })).rejects.toThrow('blocked')
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
