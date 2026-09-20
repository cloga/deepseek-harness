import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectInstalledStartupDiagnostics, inspectInstalledStartup } from './fixtures/installed-startup-diagnostics.ts'

const SECRET = 'github_pat_PRIVATE_SENTINEL_0123456789'
const privateText = `${SECRET} https://private.invalid/path?token=${SECRET} C:\\Users\\private\\${SECRET}`

function fixture(state: unknown = { phase: 'error', message: privateText }, href = 'dsh-app://shell/startup.html') {
  const status = vi.fn(async () => state)
  const actions = { retry: vi.fn(), recover: vi.fn(), reset: vi.fn(), disablePlugins: vi.fn() }
  const backend = { status, ...actions }
  const error = { hidden: false, textContent: privateText, getClientRects: () => [{}] }
  const document = { querySelector: vi.fn((selector: string) => {
    if (selector === '#error') return error
    if (selector === 'main[aria-busy]') return { getAttribute: () => 'true' }
    throw new Error(privateText)
  }) }
  const window: { dshDesktop?: unknown } = { dshDesktop: { backend } }
  const context = { URL, location: { href }, window, document, setTimeout, clearTimeout }
  const inspect = runInNewContext(`(${inspectInstalledStartup.toString()})`, context) as typeof inspectInstalledStartup
  return { status, actions, backend, error, document, window, context, inspect }
}

function expectPrivate(data: unknown): void {
  const text = JSON.stringify(data)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('private.invalid')
  expect(text).not.toContain('C:\\Users')
}

afterEach(() => { vi.useRealTimers() })

describe('installed startup failure observation', () => {
  it.each([
    ['ERR_MODULE_NOT_FOUND', 'module-resolution'], ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'module-resolution'],
    ['ERR_DLOPEN_FAILED', 'native-addon'], ['NODE_MODULE_VERSION', 'native-addon'],
    ['ENOENT', 'missing-file'], ['EPERM', 'permission'], ['CERT_HAS_EXPIRED', 'tls'],
    ['GitHub request failed with 403', 'http'], ['ERR_PNPM_FETCH_429', 'http'],
    ['UND_ERR_SOCKET', 'network'], ['TimeoutError', 'timeout'], ['unclassified message', 'unknown'],
  ])('classifies only observed %s and never serializes its surrounding private text', async (code, category) => {
    const f = fixture({ phase: 'error', message: `${code}: ${privateText}`, profileRecovery: true })
    f.error.textContent = `${code}: ${privateText}`
    const result = await f.inspect()
    expect(result).toMatchObject({ document: 'startup', bridgeAvailable: true, phase: 'error', profileRecovery: true,
      backendCategory: category, errorCategory: category, errorPresent: true, errorVisible: true, errorNonempty: true, busy: true })
    expect(result.backendHttpStatus).toBe(code.includes('403') ? 403 : code.includes('429') ? 429 : null)
    expect(result.diagnosticFailures).toEqual([])
    expect(f.status).toHaveBeenCalledOnce()
    for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it.each([
    ['dsh-app://shell/startup.html', 'startup'], ['dsh-app://app/index.html', 'baseline-app'], ['dsh-app://app/', 'candidate-app'],
  ])('reports fixed document category for %s without query values', async (url, document) => {
    const f = fixture({ phase: 'ready' }, `${url}?token=${SECRET}`)
    const result = await f.inspect()
    expect(result.document).toBe(document)
    expect(result.phase).toBe('ready')
    expectPrivate(result)
  })

  it.each([
    `https://private.invalid/${SECRET}`, `file:///C:/Users/private/${SECRET}`, `dsh-app://user:${SECRET}@shell/startup.html`,
    'dsh-app://shell:123/startup.html', `dsh-app://shell/${SECRET}`, 'not a URL',
  ])('never inspects an unrecognized document or bridge: %s', async (url) => {
    const f = fixture(undefined, url)
    const result = await f.inspect()
    expect(result.document).toBe('other')
    expect(result.bridgeAvailable).toBeNull()
    expect(f.status).not.toHaveBeenCalled()
    expect(f.document.querySelector).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it('bounds message inspection and retains unknown instead of returning unclassified text', async () => {
    const message = `${'x'.repeat(4096)} ERR_MODULE_NOT_FOUND ${privateText}`
    const f = fixture({ phase: 'error', message, profileRecovery: privateText })
    f.error.textContent = message
    const result = await f.inspect()
    expect(result).toMatchObject({ backendCategory: 'unknown', errorCategory: 'unknown', profileRecovery: null,
      backendMessageTruncated: true, errorMessageTruncated: true })
    expectPrivate(result)
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  })

  it('keeps nonempty status unknown when only a truncated whitespace prefix was inspected', async () => {
    const f = fixture()
    f.error.textContent = `${' '.repeat(4096)}${privateText}`
    const result = await f.inspect()
    expect(result).toMatchObject({ errorNonempty: null, errorMessageTruncated: true, errorCategory: 'unknown' })
    expectPrivate(result)
  })

  it.each([null, 42, privateText, { phase: privateText, message: privateText, profileRecovery: true }])(
    'keeps malformed backend status unknown without disclosing payloads', async (state) => {
      const result = await fixture(state).inspect()
      expect(result).toMatchObject({ bridgeAvailable: true, phase: 'unknown', profileRecovery: null, backendCategory: 'unknown' })
      expectPrivate(result)
    },
  )

  it('does not coerce backend objects or inspect unrelated profile fields', async () => {
    const state = { phase: 'error', message: { toString() { throw new Error(privateText) } }, profileRecovery: false,
      get profile() { throw new Error(privateText) } }
    const result = await fixture(state).inspect()
    expect(result).toMatchObject({ phase: 'error', profileRecovery: false, backendCategory: 'unknown' })
    expect(result.diagnosticFailures).toEqual([])
    expectPrivate(result)
  })

  it.each(['000', '600', '999'])('does not invent an HTTP category for invalid status %s', async (status) => {
    const result = await fixture({ phase: 'error', message: `GitHub request failed with ${status} ${privateText}` }).inspect()
    expect(result).toMatchObject({ backendCategory: 'unknown', backendHttpStatus: null })
    expectPrivate(result)
  })

  it.each(['bridge', 'status', 'phase', 'message', 'profileRecovery'])('contains throwing %s getters without exposing their error', async (field) => {
    const state: Record<string, unknown> = { phase: 'error', message: privateText }
    const f = fixture(state)
    const target = field === 'bridge' ? f.window : field === 'status' ? f.backend : state
    const key = field === 'bridge' ? 'dshDesktop' : field
    Object.defineProperty(target, key, { get() { throw new Error(privateText) } })
    const result = await f.inspect()
    expect(result.phase).toBe('unknown')
    expect(result.diagnosticFailures).toContain('backend-status-unavailable')
    expectPrivate(result)
  })

  it('keeps absent bridge, DOM visibility and empty error evidence distinct', async () => {
    const f = fixture()
    delete f.window.dshDesktop
    f.error.hidden = true
    f.error.textContent = ''
    const result = await f.inspect()
    expect(result).toMatchObject({ bridgeAvailable: false, phase: 'unavailable', errorPresent: true, errorVisible: false, errorNonempty: false })
    expect(f.status).not.toHaveBeenCalled()
  })

  it('preserves the bridge receiver and records transport/getter errors only by fixed category', async () => {
    const f = fixture()
    f.status.mockImplementation(async function (this: unknown) {
      expect(this).toBe(f.backend)
      throw new Error(privateText)
    })
    f.document.querySelector.mockImplementation(() => { throw new Error(privateText) })
    const result = await f.inspect()
    expect(result).toMatchObject({ bridgeAvailable: true, phase: 'unknown', errorPresent: null })
    expect(result.diagnosticFailures).toEqual(['document-state-unavailable', 'backend-status-unavailable'])
    expectPrivate(result)
  })

  it('bounds a stalled read-only bridge and clears its timer without recovery', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.status.mockImplementation(() => new Promise(() => {}))
    const pending = f.inspect()
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending
    expect(result).toMatchObject({ bridgeAvailable: true, phase: 'unknown', diagnosticFailures: ['backend-status-timeout'] })
    expect(vi.getTimerCount()).toBe(0)
    for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled()
  })

  it('serializes through the actual fixture tsx/esm loader without captured helpers', async () => {
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())))
    const url = new URL('./fixtures/installed-startup-diagnostics.ts', import.meta.url).href
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval',
      `import {inspectInstalledStartup} from ${JSON.stringify(url)}; console.log(JSON.stringify(inspectInstalledStartup.toString()))`],
    { env: { ...env, TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, child.stderr).toBe(0)
    const source: unknown = JSON.parse(child.stdout)
    expect(typeof source).toBe('string')
    const f = fixture({ phase: 'error', message: `ENOENT ${privateText}` })
    const inspect = runInNewContext(`(${String(source)})`, f.context) as typeof inspectInstalledStartup
    const result = await inspect()
    expect(result.backendCategory).toBe('missing-file')
    expectPrivate(result)
  }, 30_000)

  it('records only owned process exit leaves and existing page data', async () => {
    const f = fixture()
    const app = { process: () => ({ exitCode: 23, signalCode: null }) }
    const page = { isClosed: () => false, evaluate: vi.fn(async () => f.inspect()) }
    const result = await collectInstalledStartupDiagnostics(app, page)
    expect(result).toMatchObject({ appExited: true, appExitCode: 23, pageAvailable: true })
    expect(page.evaluate).toHaveBeenCalledExactlyOnceWith(inspectInstalledStartup)
    expectPrivate(result)
  })

  it('records absent/closed or failed handles without opening another window or losing failures', async () => {
    const closed = { isClosed: () => true, evaluate: vi.fn() }
    expect(await collectInstalledStartupDiagnostics(undefined, closed)).toMatchObject({
      pageAvailable: false, observation: null, appExited: null,
    })
    expect(closed.evaluate).not.toHaveBeenCalled()
    const result = await collectInstalledStartupDiagnostics({ process() { throw new Error(privateText) } },
      { isClosed() { throw new Error(privateText) }, evaluate: vi.fn() })
    expect(result.diagnosticFailures).toEqual(['app-exit-state-unavailable', 'page-observation-unavailable'])
    expectPrivate(result)
  })

  it('bounds page transport before the owning fixture closes the app', async () => {
    vi.useFakeTimers()
    const page = {
      isClosed: () => false,
      evaluate: vi.fn(() => new Promise<Awaited<ReturnType<typeof inspectInstalledStartup>>>(() => {})),
    }
    const pending = collectInstalledStartupDiagnostics(undefined, page)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await pending
    expect(result.diagnosticFailures).toEqual(['page-observation-timeout'])
    expect(result.observation).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('captures only in the failed round before the existing application close, without readiness changes', () => {
    const source = readFileSync(fileURLToPath(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url)), 'utf8')
    const start = source.indexOf('    } catch (error) {\n      roundFailure = error')
    const close = source.indexOf('try { await app?.close() }', start)
    const capture = source.indexOf('collectInstalledStartupDiagnostics(app, page)', start)
    expect(start).toBeGreaterThan(0)
    expect(capture).toBeGreaterThan(start)
    expect(capture).toBeLessThan(close)
    expect(source).toContain("assert.equal(page.url(), expectedUrl, 'Installed application did not reach its version-owned URL')")
    expect(source).toContain('expectedUrl, { timeout: 300_000 }')
    expect(source).toContain("secondaryErrors.push('startup-diagnostic-unavailable')")
    expect(source).toContain('if (roundFailure !== undefined) throw roundFailure')
  })
})
