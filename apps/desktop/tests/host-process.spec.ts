import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi, type TestContext } from 'vitest'
import { DesktopHostProcess, DesktopHostUncleanExitError, type DesktopPluginCommandEvent } from '../src/host-process.ts'

interface OwnedHostFixtures {
  roots: string[]
  hosts: DesktopHostProcess[]
}

const fixtures = new WeakMap<TestContext, OwnedHostFixtures>()

function owned(test: TestContext): OwnedHostFixtures {
  const existing = fixtures.get(test)
  if (existing !== undefined) return existing
  const resources: OwnedHostFixtures = { roots: [], hosts: [] }
  fixtures.set(test, resources)
  test.onTestFinished(async () => {
    const stopped = await Promise.allSettled(resources.hosts.map(host => host.stop()))
    const failures = stopped.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'fixture Hosts did not reach quiescence')
    for (const root of resources.roots) rmSync(root, { recursive: true, force: true })
  })
  return resources
}

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEnvironmentData } from 'node:worker_threads'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals'), policyRoots: getEnvironmentData('@deepseek-ai/dsh-desktop-host/module-resolution-policy')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

/** Assemble the genuine policy for lifecycle fixture Hosts, not a full packaged Core boot. */
function projectWithHost(test: TestContext, source = HTTP_HOST): string {
  const resources = owned(test)
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  resources.roots.push(project)
  mkdirSync(join(project, 'home'))
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  copyFileSync(new URL('../../desktop-host/register-module-resolution-policy.mjs', import.meta.url),
    join(packageRoot, 'register-module-resolution-policy.mjs'))

  // The genuine preload's only package dependency imports Node builtins. Emit its current
  // source for plain Node rather than using stale lib output or an inherited test resolver.
  const homePaths = join(project, 'node_modules', '@deepseek-ai', 'dsh-home-paths')
  mkdirSync(join(homePaths, 'lib'), { recursive: true })
  copyFileSync(new URL('../../../packages/util/home-paths/package.json', import.meta.url), join(homePaths, 'package.json'))
  writeFileSync(join(homePaths, 'lib', 'index.js'), transpileModule(
    readFileSync(new URL('../../../packages/util/home-paths/src/index.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } },
  ).outputText)
  return project
}

function hostEnvironment(runtime: string, environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: undefined }): NodeJS.ProcessEnv {
  return { ...environment, DSH_HOME: join(runtime, 'home') }
}

function hostProcess(
  test: TestContext, runtime: string, profile = runtime, onFailure?: (error: Error) => void,
  environment = hostEnvironment(runtime),
  onPluginCommand?: (host: DesktopHostProcess, event: DesktopPluginCommandEvent) => void,
): DesktopHostProcess {
  const resources = owned(test)
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, hostEnvironment(runtime, environment), onFailure,
    undefined, 'link', undefined, undefined, false, onPluginCommand)
  resources.hosts.push(host)
  return host
}

describe('desktop host process', () => {
  it('routes command control over the retained alpha2 child without replacing URL or task protocols', async (test) => {
    const runtime = projectWithHost(test, `
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/?token=fixture', injections: [] })
process.send({ type: 'plugin-command-request', requestId: 1, commandId: 'command-list', operation: { type: 'list' } })
process.on('message', message => {
  if (message.type === 'plugin-command-response' && message.requestId === 1 && message.result.kind === 'list') {
    process.send({ type: 'plugin-command-settled', requestId: 1, commandId: 'command-list' })
  }
  if (message.type === 'update-tasks') process.send({ type: 'update-tasks', requestId: message.requestId, active: false })
  if (message.type === 'shutdown') process.send({ type: 'shutdown-complete' }, () => process.disconnect())
})
`)
    const events: string[] = []
    const settled = Promise.withResolvers<undefined>()
    const host = hostProcess(test, runtime, runtime, undefined, hostEnvironment(runtime), (source, event) => {
      expect(source).toBe(host)
      events.push(event.type)
      if (event.type === 'plugin-command-request') {
        void source.pluginCommandResponse(event.requestId, { kind: 'list', plugins: [] }).catch(settled.reject)
      } else if (event.type === 'plugin-command-settled') settled.resolve(undefined)
    })
    expect(await host.start()).toEqual({ url: 'http://127.0.0.1:3080/?token=fixture', injections: [], packages: undefined })
    await settled.promise
    expect(events).toEqual(['plugin-command-request', 'plugin-command-settled'])
    expect(await host.updateTasks('inspect')).toBe(false)
    await host.stop(true)
    await expect(host.pluginCommandResponse(1, { kind: 'prepared' })).rejects.toThrow('Host is unavailable')
  })

  it('returns a safe unavailable response when no command consumer owns the child', async (test) => {
    const runtime = projectWithHost(test, `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
process.send({ type: 'plugin-command-request', requestId: 1, commandId: 'command-list', operation: { type: 'list' } })
process.on('message', message => {
  if (message.type === 'plugin-command-response') writeFileSync(join(process.argv[3], 'reply.json'), JSON.stringify(message))
  if (message.type === 'shutdown') process.send({ type: 'shutdown-complete' }, () => process.disconnect())
})
`)
    const host = hostProcess(test, runtime)
    await host.start()
    const path = join(runtime, 'reply.json')
    await expect.poll(() => existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      type: 'plugin-command-response', requestId: 1, result: { kind: 'error', code: 'unavailable' },
    })
    await host.stop(true)
  })

  it('rejects malformed command events before dispatching or interpreting them as task responses', async (test) => {
    const runtime = projectWithHost(test, `
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
process.send({ type: 'plugin-command-request', requestId: 1, commandId: 'command-list', operation: { type: 'list' }, authority: true })
process.on('message', () => {})
`)
    const failed = vi.fn()
    const dispatch = vi.fn()
    const host = hostProcess(test, runtime, runtime, failed, hostEnvironment(runtime), dispatch)
    await host.start()
    await expect.poll(() => failed.mock.calls.length).toBe(1)
    expect(failed).toHaveBeenCalledWith(new Error('dsh desktop host sent an invalid IPC event'))
    expect(dispatch).not.toHaveBeenCalled()
    await host.stop()
  })

  it('contains a command listener exception through the existing child failure owner', async (test) => {
    const runtime = projectWithHost(test, `
process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
process.send({ type: 'plugin-command-cancel', requestId: 1 })
process.on('message', () => {})
`)
    const primary = new Error('owned command listener failed')
    const failed = vi.fn()
    const host = hostProcess(test, runtime, runtime, failed, hostEnvironment(runtime), () => { throw primary })
    await host.start()
    await expect.poll(() => failed.mock.calls.length).toBe(1)
    expect(failed).toHaveBeenCalledWith(primary)
    await host.stop()
  })

  it('correlates task inspections and admission changes over private IPC', async (test) => {
    const host = hostProcess(test, projectWithHost(test))
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  for (const exit of ['process.exit(17)', 'process.exit(0)']) {
    it(`refuses installation when exit lacks successful teardown acknowledgement: ${exit}`, async (test) => {
      const host = hostProcess(test, projectWithHost(test, `
        process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
        process.on('message', message => {
          if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
        })
      `))
      await host.start()
      const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
      expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
      expect(String(error)).toContain('shutdown acknowledged false')
      expect(String(error)).toContain('graceful deadline exceeded false')
      expect(String(error)).not.toContain('fixture-secret')
      await expect(host.stop()).resolves.toBeUndefined()
    })
  }

  it('returns the Web authentication URL and waits for graceful shutdown', async (test) => {
    const runtime = projectWithHost(test)
    const failure = vi.fn()
    const host = hostProcess(test, runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    const response = await fetch(ready.url)
    expect(response.status).toBe(200)
    const body = await response.json() as { policyRoots: unknown; nodeOptions?: unknown }
    expect(body.policyRoots).toEqual({ schemaVersion: 1, runtimeDir: runtime, profileDir: runtime, home: join(runtime, 'home') })
    expect(body.nodeOptions).toBeUndefined()
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and runtime profile resolution to the Host', async (test) => {
    const runtime = projectWithHost(test, HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[6], nodeBin: process.argv[7], primaryRuntime: process.argv[4], profileResolution: process.argv[5], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, hostEnvironment(runtime),
      undefined, primaryRuntime, 'runtime', { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    owned(test).hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, profileResolution: 'runtime', pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async (test) => {
    const runtime = projectWithHost(test)
    const failure = vi.fn()
    const host = hostProcess(test, runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async (test) => {
    const runtime = projectWithHost(test)
    const failure = vi.fn()
    const host = hostProcess(test, runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async (test) => {
    const runtime = projectWithHost(test, 'process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(test, runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async (test) => {
    const runtime = projectWithHost(test)
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime, undefined, hostEnvironment(runtime))
    owned(test).hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async (test) => {
    const runtime = projectWithHost(test)
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    owned(test).roots.push(profile)
    const host = hostProcess(test, runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({
      runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/',
      nodeOptions: '--no-warnings', runAsNode: '1', internals: true,
      policyRoots: { schemaVersion: 1, runtimeDir: runtime, profileDir: profile, home: join(runtime, 'home') },
    })
  })

  for (const [source, message] of [
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ] as const) {
    it(`rejects startup when the child fails before readiness: ${source}`, async (test) => {
      const host = hostProcess(test, projectWithHost(test, source))
      await expect(host.start()).rejects.toThrow(message)
    })
  }
})
