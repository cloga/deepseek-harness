import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAiResponsesSearchProvider } from '@deepseek-ai/dsh-web-search-openai-responses'

interface ReceivedRequest {
  readonly body: string
  readonly headers: IncomingMessage['headers']
  readonly method?: string
}

const targetRequests: ReceivedRequest[] = []
let redirectOrigin: string
let targetOrigin: string

const targetServer = createServer((request, response) => {
  void captureRequest(request).then((received) => {
    targetRequests.push(received)
    response.writeHead(204).end()
  }, (error: unknown) => response.destroy(asError(error)))
})

const redirectServer = createServer((request, response) => {
  request.resume()
  const status = Number(new URL(request.url ?? '/', 'http://fixture.test').pathname.split('/')[1])
  response.writeHead(status, { location: `${targetOrigin}/collect` }).end()
})

beforeAll(async () => {
  targetOrigin = await listen(targetServer)
  redirectOrigin = await listen(redirectServer)
})

afterAll(async () => {
  await Promise.all([close(redirectServer), close(targetServer)])
})

describe('OpenAiResponsesSearchProvider redirect policy', () => {
  it.each([301, 302, 303, 307, 308])('rejects HTTP %i without contacting the target', async (status) => {
    targetRequests.length = 0
    const provider = new OpenAiResponsesSearchProvider(() => ({
      apiKey: 'redirect-secret',
      baseURL: `${redirectOrigin}/${String(status)}`,
      model: 'model',
      maxOutputTokens: 32,
    }))
    await expect(provider.search({ query: 'private redirect query' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(targetRequests).toHaveLength(0)
  })

  it('proves a default 307 follow would contact the target with the POST body', async () => {
    targetRequests.length = 0
    const body = JSON.stringify({ input: 'private redirect query' })
    await fetch(`${redirectOrigin}/307`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer redirect-secret',
        'content-type': 'application/json',
      },
      body,
    })
    expect(targetRequests).toHaveLength(1)
    expect(targetRequests[0]).toMatchObject({ method: 'POST', body })
    // Native fetch strips Authorization on a cross-origin redirect, but still
    // forwards the private query body. `redirect: "error"` prevents both.
    expect(targetRequests[0]?.headers.authorization).toBeUndefined()
  })
})

function captureRequest(request: IncomingMessage): Promise<ReceivedRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    request.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
      else reject(new TypeError('unexpected HTTP request chunk'))
    })
    request.once('error', reject)
    request.once('end', () => {
      resolve({
        ...request.method === undefined ? {} : { method: request.method },
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
