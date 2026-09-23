import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html).toContain('Promise.withResolvers()')
  expect(html).toContain('assets/entry.js')
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
  expect((await serveWebDocument(new Request('dsh-app://shell/'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app:19387/'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('https://elsewhere.example/'), root)).status).toBe(403)
})

it('refuses linked files and ancestor junctions inside the static Web dist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-assets-'))
  const outside = await mkdtemp(join(tmpdir(), 'desktop-web-outside-'))
  roots.push(root, outside)
  await mkdir(join(root, 'assets'))
  await writeFile(join(outside, 'private.js'), 'private bytes must not be served')
  await symlink(outside, join(root, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await serveWebDocument(new Request('dsh-app://app/assets/linked/private.js'), root)).status).toBe(403)
  if (process.platform !== 'win32') {
    await symlink(join(outside, 'private.js'), join(root, 'assets', 'private.js'))
    expect((await serveWebDocument(new Request('dsh-app://app/assets/private.js'), root)).status).toBe(403)
  }
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  for (const request of [
    new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }),
    new Request('dsh-app://shell/api/read'),
    new Request('dsh-app://app:19387/api/read'),
    new Request('https://elsewhere.example/api/read'),
  ]) {
    const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')
    expect(response.status).toBe(403)
  }
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  'https://elsewhere.example/', 'http://127.0.0.2:1234/', 'file:///private',
  'http://user:password@127.0.0.1:1234/', 'http://127.0.0.1:1234/private',
  'http://127.0.0.1:1234/#private', 'not an origin',
])('refuses an unowned Host authority without exchanging cookies or proxying: %s', async (host) => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(authenticateWebHost(host)).rejects.toThrow('Desktop Host origin is invalid')
  await expect(forwardWebRequest(new Request('dsh-app://app/api/read'), host, 'session=owned'))
    .rejects.toThrow('Desktop Host origin is invalid')
  expect(fetch).not.toHaveBeenCalled()
})
