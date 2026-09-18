/** Package failures commonly print their diagnostic on stdout; secrets and oversized lines remain bounded. */
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runDesktopPackagePnpm } from '../src/profile-package-pnpm.ts'

it.each(['deadline', 'user', 'user-named-timeout'] as const)('keeps %s cancellation distinct after the real owned child exits', { timeout: 60000 }, async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pnpm-cancel-'))
  const ready = Promise.withResolvers<undefined>()
  const watcher = watch(root, (_event, name) => { if (String(name) === 'ready') ready.resolve(undefined) })
  watcher.on('error', ready.reject)
  const controller = new AbortController()
  const operation: { run?: ReturnType<typeof runDesktopPackagePnpm> } = {}
  onTestFinished(async () => {
    controller.abort()
    await operation.run?.catch(() => {})
    watcher.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const stub = join(root, 'pnpm-stub.mjs')
  writeFileSync(stub, "import { writeFileSync, writeSync } from 'node:fs'; writeSync(1, 'OWNED_CHILD_READY token=fixture-secret\\n'); writeFileSync(process.argv.at(-1), 'ready'); setInterval(() => {}, 1000);\n")
  const run = runDesktopPackagePnpm({ node: process.execPath, pnpm: stub, nodeBin: dirname(process.execPath) }, {
    cwd: root, args: [join(root, 'ready')], env: {}, signal: controller.signal,
  })
  operation.run = run
  void run.catch(ready.reject)
  try {
    await ready.promise
    const reason = mode === 'deadline' ? new DOMException('owned deadline', 'TimeoutError')
      : Object.assign(new Error('user cancellation'), mode === 'user-named-timeout' ? { name: 'TimeoutError' } : {})
    controller.abort(reason)
    const failure = await run.then(() => { throw new Error('cancelled child must not succeed') }, (error: unknown) => error)
    if (mode === 'deadline') {
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBe(reason)
      expect((failure as Error).cause).toBe(reason)
      expect((failure as Error).message).toContain('OWNED_CHILD_READY')
      expect((failure as Error).message).not.toContain('fixture-secret')
    } else expect(failure).toBe(reason)
  } finally {
    controller.abort()
    await run.catch(() => {})
    watcher.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('retains stdout failure diagnostics while bounding and redacting their contents', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pnpm-output-'))
  const stub = join(root, 'pnpm-stub.mjs')
  mkdirSync(join(root, 'work'))
  writeFileSync(stub, "process.stdout.write('token=' + 'x'.repeat(10000) + '\\nERR_FIXTURE token=fixture-token https://name:fixture-password@example.invalid/path?key=fixture-query\\n'); process.exitCode = 7;\n")
  try {
    const failure = await runDesktopPackagePnpm({ node: process.execPath, pnpm: stub, nodeBin: dirname(process.execPath) }, {
      cwd: join(root, 'work'), args: [], env: {}, signal: AbortSignal.timeout(30000),
    }).then(() => { throw new Error('fixture must fail') }, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('pnpm failed (7)')
    expect(message).toContain('ERR_FIXTURE')
    expect(message).toContain('[redacted]')
    expect(message).not.toContain('fixture-token')
    expect(message).not.toContain('fixture-password')
    expect(message).not.toContain('fixture-query')
    expect(Buffer.byteLength(message)).toBeLessThan(8400)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
