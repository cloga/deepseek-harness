// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { applyIndexInjections } from '@deepseek-ai/dsh-client-web'

it('applies Host-owned index rows in order before the carrier loads a dependent script', async () => {
  const existingHead = new Set(document.head.children)
  const existingBody = new Set(document.body.children)
  try {
    const load = vi.fn(async (src: string) => {
      expect(src).toBe('/owned-client.js')
      expect((globalThis as Record<string, unknown>).__DSH_TEST_INJECTION__).toBe('ready')
      expect(document.head.querySelector('script')?.textContent).toContain('owned early script')
      expect(document.head.querySelector('style')?.textContent).toContain('body { color: red; }')
      expect(document.body.querySelector('#owned-markup')).not.toBeNull()
    })
    await applyIndexInjections([
      { kind: 'global', name: '__DSH_TEST_INJECTION__', value: 'ready' },
      { kind: 'script', placement: 'head', text: '/* owned early script */' },
      { kind: 'style', text: 'body { color: red; }' },
      { kind: 'html', placement: 'body', html: '<p id="owned-markup">ready</p>' },
      { kind: 'script-preload', src: '/owned-client.js' },
      { kind: 'script-src', placement: 'head', src: '/owned-client.js' },
    ], load)
    expect(load).toHaveBeenCalledTimes(1)
  } finally {
    Reflect.deleteProperty(globalThis, '__DSH_TEST_INJECTION__')
    for (const child of Array.from(document.head.children)) if (!existingHead.has(child)) child.remove()
    for (const child of Array.from(document.body.children)) if (!existingBody.has(child)) child.remove()
  }
})

it('rejects an unknown Host row without leaking its body through an error', async () => {
  const secret = 'https://example.invalid/?token=hidden-value'
  const unknown = { kind: 'future-row', secret } as unknown as Parameters<typeof applyIndexInjections>[0][number]
  let failure: unknown
  try { await applyIndexInjections([unknown], async () => {}) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe('web boot: unknown index injection row')
  expect((failure as Error).message).not.toContain(secret)
})
