import { expect, it } from 'vitest'
import { openDesktopSmokeBridge } from '../scripts/smoke-runtime-browser.ts'

it('forwards browser methods, bodies and streaming bytes through an isolated carrier', async () => {
  const requests: Request[] = []
  const bridge = await openDesktopSmokeBridge({
    async fetch(request) {
      requests.push(request)
      return new Response(`${request.method}:${await request.text()}`, {
        headers: { 'content-type': 'text/plain' },
      })
    },
  })
  try {
    const result = await fetch(`${bridge.origin}/api/neutral`, { method: 'POST', body: 'fixture' })
    expect(await result.text()).toBe('POST:fixture')
    expect(requests[0]?.url).toBe('dsh-app://app/api/neutral')
    expect(bridge.errors).toEqual([])
  } finally {
    await bridge.close()
  }
  await expect(fetch(bridge.origin)).rejects.toThrow()
})

it('allocates independent listeners and aborts pending streams before returning from cleanup', async ({ onTestFinished }) => {
  let cancelled = false
  const bridge = await openDesktopSmokeBridge({
    async fetch() {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('ready')) },
        cancel() { cancelled = true },
      }))
    },
  })
  onTestFinished(() => bridge.close())
  const second = await openDesktopSmokeBridge({ fetch: async () => new Response('second') })
  onTestFinished(() => second.close())
  try {
    expect(bridge.origin).not.toBe(second.origin)
    const response = await fetch(bridge.origin)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready')
    await bridge.close()
    expect(cancelled).toBe(true)
    await expect(reader.read()).rejects.toThrow()
    expect(await (await fetch(second.origin)).text()).toBe('second')
  } finally {
    await second.close()
  }
})
