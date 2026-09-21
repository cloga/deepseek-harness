// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from '../src/client/skeleton/InputBar.module.css'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })
const slot = 'conversation.composer.dock'
const empty = `.${css.dock}:empty, .${css.dock}:has(> [data-slot="${slot}"]:only-child:empty)`

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.sessions.add({ id: 'composer-dock-anchor' }, { current: true })
  // The production renderer, not a mocked renderSlot, owns the stable outlet.
  await runtime.root.declare({ [slot]: { kind: 'list', scope: 'session' } }, ({ renderSlot, SessionProvider }) => (
    <SessionProvider>
      <div className={css.dock} data-testid="dock-owner">{renderSlot(slot, {})}</div>
    </SessionProvider>
  ))
  const view = runtime.renderRoot()
  const owner = view.getByTestId('dock-owner')
  const anchor = owner.querySelector(`[data-slot="${slot}"]`) as HTMLElement
  expect(anchor).not.toBeNull()
  expect(anchor.style.display).toBe('contents')
  return { runtime, owner, anchor }
}

async function contribution(runtime: SlotTestRuntime, content: ReactNode) {
  return runtime.mount({
    inject: ['slots'],
    apply(ctx) { ctx.slots.register({ name: slot, id: 'probe' }, () => content) },
  })
}

describe('composer empty spacing with the actual Slot outlet', () => {
  it('recognizes the same empty anchor before registration, for null output, and after unload', async () => {
    const { runtime, owner, anchor } = await bench()
    expect(owner.matches(`.${css.dock}:empty`)).toBe(false)
    expect(owner.matches(empty)).toBe(true)
    const feature = await contribution(runtime, null)
    expect(owner.querySelector(`[data-slot="${slot}"]`)).toBe(anchor)
    expect(owner.matches(empty)).toBe(true)
    await feature.dispose()
    expect(owner.querySelector(`[data-slot="${slot}"]`)).toBe(anchor)
    expect(owner.matches(empty)).toBe(true)
  })

  it.each([
    { name: 'text-only entry', content: 'Ambient note' },
    { name: 'full-width entry', content: <div style={{ width: '100%' }}>Full width</div> },
    { name: 'another compact entry', content: <button type="button">Other entry</button> },
  ])('preserves $name instead of treating no native stats as empty', async ({ content }) => {
    const { runtime, owner, anchor } = await bench()
    const feature = await contribution(runtime, content)
    expect(owner.matches(empty)).toBe(false)
    expect(anchor.textContent).not.toBe('')
    await feature.dispose()
    expect(owner.querySelector(`[data-slot="${slot}"]`)).toBe(anchor)
    expect(owner.matches(empty)).toBe(true)
  })

  it('does not hide the actual renderer crash marker', async () => {
    const { runtime, owner, anchor } = await bench()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runtime.mount({
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.register({ name: slot, id: 'crash' }, () => { throw new Error('expected dock fixture render failure') })
        },
      })
      expect(anchor.querySelector(`[data-slot-error="${slot}"]`)).not.toBeNull()
      expect(owner.matches(empty)).toBe(false)
    } finally { errors.mockRestore() }
  })
})
