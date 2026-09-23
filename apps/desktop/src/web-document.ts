/** Local Web document and authenticated HTTP forwarding for the application window. */
import { lstat, readFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Host launch credentials remain inside Electron main and may address only its owned loopback server. */
function ownedHostUrl(input: string): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Desktop Host origin is invalid') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== ''
    || url.password !== '' || url.pathname !== '/' || url.hash !== '') {
    throw new Error('Desktop Host origin is invalid')
  }
  return url
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  if (url.protocol !== 'dsh-app:' || url.hostname !== 'app' || url.port !== ''
    || url.username !== '' || url.password !== '') {
    return new Response(null, { status: 403 })
  }
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try {
    // The packaged Web dist is a fixed resource. Reject links *inside* it before
    // reading; lexical containment alone would follow an injected junction out.
    // Do not call realpath on virtual paths within Electron's app.asar archive.
    for (let current = target; ; current = dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) return new Response(null, { status: 403 })
      if (current === directory) break
    }
    body = await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', '<head>' + BOOT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const host = ownedHostUrl(url)
  const response = await fetch(host, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without network-only encoding headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (source.protocol !== 'dsh-app:' || source.hostname !== 'app' || source.port !== ''
    || source.username !== '' || source.password !== ''
    || (origin !== null && origin !== 'dsh-app://app')) return new Response(null, { status: 403 })
  const target = ownedHostUrl(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of ['content-encoding', 'content-length', 'set-cookie']) outgoing.delete(name)
  return new Response(response.body, { status: response.status, headers: outgoing })
}
