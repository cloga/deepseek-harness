import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { writePackage } from './runtime-fixture.ts'

const roots: string[] = []

const HOST_WIRE = `
import { closeSync, createReadStream, createWriteStream } from 'node:fs'
const requestPipe = createReadStream('', { fd: 3, autoClose: false })
const responsePipe = createWriteStream('', { fd: 4, autoClose: false })
const MAGIC = 0x44534833
const HEADER = 13
function responseFrame(type, streamId, payload = Buffer.alloc(0)) {
  const frame = Buffer.allocUnsafe(HEADER + payload.length)
  frame.writeUInt32BE(MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.length, 9)
  payload.copy(frame, HEADER)
  return frame
}
function responseStart(streamId, options = {}) {
  const value = { status: options.status ?? 200, headers: options.headers ?? [], hasBody: options.hasBody ?? true }
  responsePipe.write(responseFrame(1, streamId, Buffer.from(JSON.stringify(value))))
}
function responseData(streamId, data) {
  responsePipe.write(responseFrame(2, streamId, Buffer.from(data)))
}
function responseEnd(streamId) { responsePipe.write(responseFrame(3, streamId)) }
function responseError(streamId, message) {
  responsePipe.write(responseFrame(4, streamId, Buffer.from(JSON.stringify({ message }))))
}
let requestBuffer = Buffer.alloc(0)
requestPipe.on('data', chunk => {
  requestBuffer = requestBuffer.length === 0 ? chunk : Buffer.concat([requestBuffer, chunk])
  while (requestBuffer.length >= HEADER) {
    if (requestBuffer.readUInt32BE(0) !== MAGIC) throw new Error('invalid request marker')
    const type = requestBuffer.readUInt8(4)
    const streamId = requestBuffer.readUInt32BE(5)
    const length = requestBuffer.readUInt32BE(9)
    if (requestBuffer.length < HEADER + length) return
    const payload = requestBuffer.subarray(HEADER, HEADER + length)
    requestBuffer = requestBuffer.subarray(HEADER + length)
    onRequestFrame({ type, streamId, payload })
  }
})
process.on('message', message => {
  if (message.type === 'shutdown') {
    requestPipe.destroy()
    closeSync(3)
    responsePipe.end(() => {
      responsePipe.destroy()
      closeSync(4)
      process.disconnect()
      process.exitCode = 0
    })
  }
})
`

const sourceLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href

function copyResolutionPolicy(project: string): string {
  const policy = join(project, 'register-module-resolution-policy.mjs')
  const implementation = join(project, 'module-resolution-policy.mjs')
  copyFileSync(resolve(import.meta.dirname, '../../desktop-host/register-module-resolution-policy.mjs'), implementation)
  const helperSource = pathToFileURL(resolve(import.meta.dirname, '../../../packages/util/home-paths/src/index.ts')).href
  writePackage(join(project, 'node_modules'), '@deepseek-ai/dsh-home-paths', {},
    `export { resolveDshHome } from ${JSON.stringify(helperSource)}\n`)
  // DesktopHostProcess owns argv; its test-owned --import entry installs the ESM source launcher first.
  writeFileSync(policy, `await import(${JSON.stringify(sourceLoader)})\nawait import(${JSON.stringify(pathToFileURL(implementation).href)})\n`)
  return policy
}

function projectWithHost(source: string): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  copyResolutionPolicy(packageRoot)
  writeFileSync(join(packageRoot, 'lib', 'index.js'), `${HOST_WIRE}\n${source}`)
  return project
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-host-owned-home-'))
  roots.push(home)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('cancels a stalled impact request through the actual Host transport without leaving it pending', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'impact-cancel' })
let canceled = 0
function onRequestFrame(frame) {
  if (frame.type === 4) { canceled++; return }
  if (frame.type !== 1) return
  const request = JSON.parse(frame.payload.toString())
  if (request.url.endsWith('/.dsh/update-impact')) return
  responseStart(frame.streamId)
  responseData(frame.streamId, JSON.stringify({ canceled }))
  responseEnd(frame.streamId)
}
`)
    const host = new DesktopHostProcess(process.execPath, runtime, runtime)
    try {
      await host.start()
      const controller = new AbortController()
      const pending = host.updateImpact(controller.signal)
      const failure = expect(pending).rejects.toThrow()
      await host.fetch(new Request('dsh-app://app/status')).then(response => response.json())
      controller.abort(); await failure
      const response = await host.fetch(new Request('dsh-app://app/status'))
      expect(await response.json()).toEqual({ canceled: 1 })
    } finally { await host.stop() }
  })

  it('reports a fatal event after readiness once and stops the child', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: '1.0.0' })
function onRequestFrame(frame) {
  if (frame.type === 1) process.send({ type: 'fatal', message: 'plugin unavailable' })
}
`)
    const failure = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, failure)
    try {
      await host.start()
      await expect(host.fetch(new Request('dsh-app://app/'))).rejects.toThrow('plugin unavailable')
      await host.stop()
      expect(failure).toHaveBeenCalledTimes(1)
      expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
    } finally { await host.stop() }
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost('function onRequestFrame() {}')
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    try { await expect(host.start()).rejects.toThrow() } finally { await host.stop() }
  })

  it('loads the resource entry with a separate profile and scrubs Node resolution overrides', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'split-runtime' })
function onRequestFrame(frame) {
  if (frame.type !== 1) return
  responseStart(frame.streamId)
  responseData(frame.streamId, JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, runAsNode: process.env.ELECTRON_RUN_AS_NODE}))
  responseEnd(frame.streamId)
}
`)
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--invalid-desktop-test-option', NODE_PATH: '/unowned',
    })
    try {
      const response = await host.fetch(new Request('dsh-app://app/environment'))
      expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), runAsNode: '1' })
    } finally { await host.stop() }
  })

  it('isolates profile package requests from ancestor modules without blocking shared or workspace files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-ancestor-policy-'))
    roots.push(home)
    const profile = join(home, 'profiles', 'desktop')
    const workspace = join(home, 'workspace.mjs')
    writeFileSync(workspace, 'export const marker = "workspace"\n')
    const ancestor = writePackage(join(home, 'legacy'), '@modelcontextprotocol/sdk', {}, 'export const marker = "ancestor"\n')
    mkdirSync(join(home, 'profiles', 'node_modules', '@modelcontextprotocol'), { recursive: true })
    symlinkSync(
      ancestor,
      join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
    symlinkSync(
      ancestor,
      join(profile, 'node_modules', 'legacy-sdk-alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeFileSync(join(plugin, 'esm.mjs'), 'export { marker } from "@modelcontextprotocol/sdk"\n')
    writeFileSync(join(plugin, 'alias.mjs'), 'export { marker } from "legacy-sdk-alias"\n')
    writeFileSync(join(plugin, 'cjs.cjs'), 'module.exports = require("@modelcontextprotocol/sdk")\n')
    writeFileSync(join(plugin, 'builtin.mjs'), 'export { sep } from "node:path"\n')
    writeFileSync(join(plugin, 'workspace.mjs'), 'export const load = url => import(url)\n')

    const runtime = projectWithHost(`
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const plugin = join(process.argv[3], 'node_modules', 'plugin')
async function rejected(path) {
  try { await import(pathToFileURL(path).href); return null } catch (error) { return error.code }
}
const esm = await rejected(join(plugin, 'esm.mjs'))
const alias = await rejected(join(plugin, 'alias.mjs'))
let cjs
try { createRequire(import.meta.url)(join(plugin, 'cjs.cjs')); cjs = null } catch (error) { cjs = error.code }
const builtin = await import(pathToFileURL(join(plugin, 'builtin.mjs')).href)
const shared = await import(pathToFileURL(join(plugin, 'shared.mjs')).href)
const loader = await import(pathToFileURL(join(plugin, 'workspace.mjs')).href)
const workspace = await loader.load(${JSON.stringify(pathToFileURL(workspace).href)})
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'isolated-resolution' })
function onRequestFrame(frame) {
  if (frame.type !== 1) return
  responseStart(frame.streamId)
  responseData(frame.streamId, JSON.stringify({ esm, alias, cjs, builtin: builtin.sep, shared: shared.marker, workspace: workspace.marker }))
  responseEnd(frame.streamId)
}
`)
    const shared = writePackage(join(runtime, 'node_modules'), 'shared-peer', {}, 'export const marker = "runtime"\n')
    symlinkSync(shared, join(profile, 'node_modules', 'shared-peer'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(plugin, 'shared.mjs'), 'export { marker } from "shared-peer"\n')
    const host = new DesktopHostProcess(process.execPath, runtime, profile)
    try {
      const response = await host.fetch(new Request('dsh-app://app/resolution'))
      expect(await response.json()).toEqual({
        esm: 'ERR_MODULE_NOT_FOUND',
        alias: 'ERR_MODULE_NOT_FOUND',
        cjs: 'MODULE_NOT_FOUND',
        builtin: process.platform === 'win32' ? '\\' : '/',
        shared: 'runtime',
        workspace: 'workspace',
      })
    } finally { await host.stop() }
  })

  it.each(['managed', 'staged'] as const)('keeps %s runtime peers unlinked and confines exact after-fallback anchors', (location) => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-policy-'))
    roots.push(root)
    const runtime = join(root, 'runtime')
    const home = join(root, 'home')
    const profile = location === 'managed' ? join(home, 'profiles', 'desktop') : join(root, 'stage', 'candidate')
    const fallbackRoot = location === 'managed' ? home : join(root, 'stage')
    const fallbackAnchor = join(fallbackRoot, 'package.json')
    const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
    const shared = writePackage(join(runtime, 'node_modules'), 'shared-peer', {}, 'export const marker = "runtime"\n')
    const canary = join(root, 'ancestor-loaded')
    const ancestor = writePackage(join(root, 'legacy'), '@modelcontextprotocol/sdk', {},
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(canary)}, 'loaded'); export const marker = 'ancestor'\n`)
    mkdirSync(join(fallbackRoot, 'node_modules', '@modelcontextprotocol'), { recursive: true })
    symlinkSync(ancestor, join(fallbackRoot, 'node_modules', '@modelcontextprotocol', 'sdk'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(runtime, 'package.json'), '{"type":"module"}\n')
    writePackage(join(root, 'node_modules'), 'outside-peer', {}, 'export const marker = "outside"\n')
    const workspace = join(root, 'workspace.mjs')
    writeFileSync(workspace, 'export { marker } from "outside-peer"\n')
    writeFileSync(join(plugin, 'local.mjs'), 'export const marker = "local"\n')
    writeFileSync(join(plugin, 'explicit.mjs'), `
import { sep } from 'node:path'
import { marker } from './local.mjs'
export const local = marker
export const builtin = sep
export const load = url => import(url)
`)
    const runtimeAlias = join(profile, 'node_modules', 'runtime-alias')
    symlinkSync(shared, runtimeAlias, process.platform === 'win32' ? 'junction' : 'dir')
    for (const [name, specifier] of [['shared', 'shared-peer'], ['ancestor', '@modelcontextprotocol/sdk'], ['alias', 'runtime-alias']]) {
      writeFileSync(join(plugin, `${name}.mjs`), `export { marker } from ${JSON.stringify(specifier)}\n`)
      writeFileSync(join(plugin, `${name}.cjs`), `module.exports = require(${JSON.stringify(specifier)})\n`)
    }
    const resolver = resolve(import.meta.dirname, '../../../packages/boot/app-boot/src/profile-resolution/resolver.ts')
    const addon = createRequire(resolver).resolve('node-addon-require-builtin')
    const entry = join(root, 'probe.mjs')
    const generation = {
      profilesDir: join(home, 'profiles'), profileDir: profile, localPackageNames: ['plugin'],
      entries: [{ name: 'shared-peer', version: '1.0.0', packageDir: shared, declarer: join(runtime, 'package.json'), scope: 'installation' }],
    }
    const cjsWorker = join(root, 'probe.cjs')
    writeFileSync(cjsWorker, `void import(${JSON.stringify(pathToFileURL(entry).href)})\n`)
    writeFileSync(entry, `
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
const require = createRequire(import.meta.url)
async function runWorker(url, nested) {
  const worker = new Worker(url, {
    workerData: nested,
    ...(nested ? { argv: ['not-runtime', 'not-profile'], env: { ...process.env, DSH_HOME: ${JSON.stringify(join(root, 'unrelated-home'))} } } : {}),
  })
  let message, failure, exit
  worker.on('message', value => { message = value })
  worker.on('error', error => { failure = error })
  await new Promise(resolve => worker.on('exit', code => { exit = code; resolve() }))
  if (failure) throw failure
  assert.equal(exit, 0)
  assert(message)
  return message
}
// Substitute only the native accessor; routing and both Node loader objects remain real.
assert.equal(require('internal/modules/cjs/loader').Module, Module)
require.cache[${JSON.stringify(addon)}] = { exports: { requireBuiltin: id => require(id) } }
const { installProfileResolution } = await import(${JSON.stringify(pathToFileURL(resolver).href)})
const registration = installProfileResolution(${JSON.stringify(generation)})
const result = {}
try {
  for (const name of ['shared', 'ancestor', 'alias']) {
    for (const kind of ['mjs', 'cjs']) {
      const path = ${JSON.stringify(plugin)} + '/' + name + '.' + kind
      try { result[name + ':' + kind] = (kind === 'mjs' ? await import(pathToFileURL(path).href) : require(path)).marker }
      catch (error) { result[name + ':' + kind] = error.code }
    }
  }
  const anchor = ${JSON.stringify(fallbackAnchor)}
  try { result.anchorCjs = createRequire(anchor)('@modelcontextprotocol/sdk').marker }
  catch (error) { result.anchorCjs = error.code }
  const loader = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
  try { result.anchorEsm = (await loader.import('@modelcontextprotocol/sdk', pathToFileURL(anchor).href, {})).marker }
  catch (error) { result.anchorEsm = error.code }
  const explicit = await import(${JSON.stringify(pathToFileURL(join(plugin, 'explicit.mjs')).href)})
  result.explicit = { local: explicit.local, builtin: explicit.builtin,
    workspace: (await explicit.load(${JSON.stringify(pathToFileURL(workspace).href)})).marker }
  result.outsideCjs = require('outside-peer').marker
  if (isMainThread) {
    result.workers = [await runWorker(new URL(import.meta.url), false), await runWorker(new URL(${JSON.stringify(pathToFileURL(cjsWorker).href)}), false)]
    console.log(JSON.stringify(result))
  } else {
    assert.equal(process.argv.length, workerData ? 4 : 2)
    if (!workerData) result.nested = await runWorker(new URL(import.meta.url), true)
    parentPort.postMessage(result)
  }
} finally { registration.dispose() }
`)
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const unprotected = spawnSync(process.execPath, ['--import', sourceLoader, '--expose-internals', entry, runtime, profile],
      { cwd: profile, env, encoding: 'utf8', timeout: 30_000 })
    expect(unprotected.error).toBeUndefined()
    expect(unprotected.signal).toBeNull()
    expect(unprotected.status, unprotected.stderr).toBe(0)
    expect(JSON.parse(unprotected.stdout)).toMatchObject({
      'ancestor:mjs': 'ancestor', 'ancestor:cjs': 'ancestor', anchorCjs: 'ancestor', anchorEsm: 'ancestor',
    })
    expect(existsSync(canary)).toBe(true)
    unlinkSync(canary)
    const result = spawnSync(process.execPath, ['--expose-internals', '--import',
      pathToFileURL(copyResolutionPolicy(root)).href,
      entry, runtime, profile,
    ], { cwd: profile, env, encoding: 'utf8', timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const expected = {
      'shared:mjs': 'runtime', 'shared:cjs': 'runtime',
      'ancestor:mjs': 'ERR_MODULE_NOT_FOUND', 'ancestor:cjs': 'MODULE_NOT_FOUND',
      'alias:mjs': 'ERR_MODULE_NOT_FOUND', 'alias:cjs': 'MODULE_NOT_FOUND',
      anchorCjs: 'MODULE_NOT_FOUND', anchorEsm: 'ERR_MODULE_NOT_FOUND',
      explicit: { local: 'local', builtin: process.platform === 'win32' ? '\\' : '/', workspace: 'outside' },
      outsideCjs: 'outside',
    }
    const expectedWorker = { ...expected, nested: expected }
    expect(JSON.parse(result.stdout)).toEqual({ ...expected, workers: [expectedWorker, expectedWorker] })
    expect(existsSync(fallbackAnchor)).toBe(false)
    expect(existsSync(canary)).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'shared-peer'))).toBe(false)
  })

  it('rejects missing main argv and missing or malformed inherited Worker roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-worker-policy-'))
    roots.push(root)
    const policy = pathToFileURL(copyResolutionPolicy(root)).href
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const missingArgs = spawnSync(process.execPath, ['--import', policy, '--input-type=module', '--eval', 'process.stdout.write("unexpected")'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
    expect(missingArgs.error).toBeUndefined()
    expect(missingArgs.signal).toBeNull()
    expect(missingArgs.status).toBe(1)
    expect(missingArgs.stdout).toBe('')
    expect(missingArgs.stderr).toContain('module resolution policy requires runtime and profile directories')
    const worker = join(root, 'worker.mjs')
    writeFileSync(worker, 'import { parentPort } from "node:worker_threads"; parentPort.postMessage("unexpected")\n')
    const entry = join(root, 'main.mjs')
    const valid = { schemaVersion: 1, runtimeDir: root, profileDir: root, home: root }
    const invalid = [null, [], { ...valid, schemaVersion: 2 }, { ...valid, runtimeDir: 'relative' }, { ...valid, extra: true }]
    writeFileSync(entry, `
import { setEnvironmentData, Worker } from 'node:worker_threads'
const results = []
for (const value of [undefined, ...${JSON.stringify(invalid)}]) {
  setEnvironmentData('@deepseek-ai/dsh-desktop-host/module-resolution-policy', value)
  const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(worker).href)}), {
    execArgv: ['--import', ${JSON.stringify(policy)}], argv: [${JSON.stringify(root)}, ${JSON.stringify(root)}],
  })
  const result = { ran: false }
  worker.on('message', () => { result.ran = true })
  worker.on('error', error => { result.error = error.message })
  await new Promise(resolve => worker.on('exit', code => { result.exit = code; resolve() }))
  results.push(result)
}
console.log(JSON.stringify(results))
`)
    const result = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(Array.from({ length: invalid.length + 1 }, () => ({
      ran: false, exit: 1, error: 'dsh desktop: module resolution policy requires valid inherited Worker roots',
    })))
  })

  it('carries raw request and response bytes and shuts the child down cleanly', async () => {
    const project = projectWithHost(`
const bodies = new Map()
process.send({ type: 'ready', protocolVersion: 3, dshVersion: process.env.NODE_OPTIONS ?? 'clean' })
function onRequestFrame(frame) {
  if (frame.type === 1) {
    const request = JSON.parse(frame.payload)
    bodies.set(frame.streamId, Buffer.alloc(0))
    if (!request.hasBody) answer(frame.streamId)
  } else if (frame.type === 2) {
    bodies.set(frame.streamId, Buffer.concat([bodies.get(frame.streamId), frame.payload]))
  } else if (frame.type === 3) {
    answer(frame.streamId)
  }
}
function answer(streamId) {
  responseStart(streamId, { headers: [['content-type', 'text/plain']] })
  responseData(streamId, Buffer.concat([Buffer.from('desktop:'), bodies.get(streamId)]))
  responseEnd(streamId)
}
`)
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require /path/that-must-not-reach-the-child'
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      await expect(host.start()).resolves.toMatchObject({ dshVersion: 'clean' })
      const response = await host.fetch(new Request('dsh-app://app/example', { method: 'POST', body: 'request' }))
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('desktop:request')
      await expect(host.stop()).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
      await host.stop().catch(() => undefined)
    }
  })

  it('streams a large binary response in bounded raw frames', async () => {
    const size = 2 * 1024 * 1024
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'large-response' })
function onRequestFrame(frame) {
  if (frame.type !== 1) return
  responseStart(frame.streamId)
  const bytes = Buffer.alloc(${String(64 * 1024)}, 97)
  for (let offset = 0; offset < ${String(size)}; offset += bytes.length) responseData(frame.streamId, bytes)
  responseEnd(frame.streamId)
}
`)
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const response = await host.fetch(new Request('dsh-app://app/large'))
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body).toHaveLength(size)
      expect(body[0]).toBe(97)
      expect(body.at(-1)).toBe(97)
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('stops an unfinished upload when the Host completes its response early', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'early-response' })
function onRequestFrame(frame) {
  if (frame.type !== 2) return
  responseStart(frame.streamId)
  responseData(frame.streamId, 'accepted')
  responseEnd(frame.streamId)
}
`)
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('first')) },
      cancel() { canceled = true },
    })
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const request = new Request('dsh-app://app/early', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const response = await host.fetch(request)
      await expect(response.text()).resolves.toBe('accepted')
      await expect.poll(() => canceled).toBe(true)
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('ignores a response end that arrives after the renderer cancels its stream', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'cancel-race' })
const urls = new Map()
function onRequestFrame(frame) {
  if (frame.type === 1) {
    const request = JSON.parse(frame.payload)
    urls.set(frame.streamId, request.url)
    responseStart(frame.streamId)
    if (request.url.endsWith('/after')) {
      responseData(frame.streamId, 'alive')
      responseEnd(frame.streamId)
    }
  } else if (frame.type === 4 && urls.get(frame.streamId).endsWith('/cancel')) {
    responseEnd(frame.streamId)
  }
}
`)
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const canceled = await host.fetch(new Request('dsh-app://app/cancel'))
      await canceled.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 25))
      const after = await host.fetch(new Request('dsh-app://app/after'))
      await expect(after.text()).resolves.toBe('alive')
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('rejects invalid response framing and a clean exit before readiness', async () => {
    const invalid = new DesktopHostProcess(process.execPath, projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'invalid-frame' })
function onRequestFrame(frame) {
  if (frame.type === 1) responsePipe.write(Buffer.alloc(13))
}
`), projectWithHost(''))
    await invalid.start()
    await expect(invalid.fetch(new Request('dsh-app://app/invalid'))).rejects.toThrow(/invalid Host response frame marker/u)
    await invalid.stop().catch(() => undefined)

    const earlyExit = new DesktopHostProcess(process.execPath, projectWithHost(`
function onRequestFrame() {}
process.exit(0)
`), projectWithHost(''))
    await expect(earlyExit.start()).rejects.toThrow(/response pipe ended/u)
  })
})
