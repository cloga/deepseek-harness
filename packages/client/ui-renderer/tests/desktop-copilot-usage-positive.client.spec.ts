// @vitest-environment jsdom
/** Adapter conformance only: real official renderer/hooks, synthetic selector consumer, no released Client execution. */
import assert from 'node:assert/strict'
import * as React from 'react'
import * as Cordis from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, SlotScopeAdapter } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '../../ui-conversation/src/client/contract/slots.ts'
import * as UiRenderer from '../src/client/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
// This test exercises the same Desktop acceptance adapter, not a copied renderer or replacement hook.
import { runPositiveUsageInBrowser } from '../../../../apps/desktop/tests/fixtures/copilot-usage-positive-browser.ts'
import { assertPositiveCopilotUsageEvidence } from '../../../../apps/desktop/tests/fixtures/copilot-usage-positive-smoke.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

type SyntheticRuntime = PropsRuntime<'conversation.composer.dock'>

function syntheticClient(fail = false) {
  return {
    inject: ['slots', 'remote.githubCopilotUsage'],
    apply(ctx: Context) {
      const candidate: unknown = ctx.get('remote.githubCopilotUsage')
      assert(typeof candidate === 'object' && candidate !== null && 'get' in candidate && typeof candidate.get === 'function')
      const get = candidate.get as () => Promise<unknown>
      function Card() {
        const [text, setText] = React.useState('Loading')
        React.useEffect(() => {
          let active = true
          void get.call(candidate).then((result: unknown) => {
            const value = object(object(result)?.value)
            if (active && value?.used === 7 && value.remaining === 13) setText('Copilot credits: 7 used · 13 left')
          })
          return () => { active = false }
        }, [])
        return React.createElement('button', { 'data-copilot-usage-trigger': '' }, text)
      }
      function Surface(runtime: SyntheticRuntime) {
        const valid = runtime.useSession((value) => {
          const session = object(value)
          return session?.sessionId === runtime.sessionId && session.removed === false && session.openState === 'open'
        })
        const provider = runtime.useProjection('modelSelection', value => object(object(value)?.next)?.provider)
        if (fail) throw new Error('Synthetic selector consumer failed')
        return valid && (provider === 'github-copilot' || provider === 'github-copilot-preview') ? React.createElement(Card) : null
      }
      ctx.slots.register({ name: 'conversation.composer.dock', id: 'synthetic-usage-consumer' }, Surface)
    },
  }
}

function installModules(client: ReturnType<typeof syntheticClient>) {
  const application = document.createElement('main')
  application.id = 'root'
  application.textContent = 'Original signed-out application'
  document.body.append(application)
  Object.defineProperty(window, '__desktopUsageModules', {
    configurable: true,
    value: {
      async import(id: string) {
        if (id === '@deepseek-ai/cordis') return Cordis
        if (id === 'react') return React
        if (id === '@deepseek-ai/dsh-client-ui-renderer') return UiRenderer
        if (id === 'dsh-github-copilot') return client
        throw new Error(`Unexpected fixture module: ${id}`)
      },
    },
  })
  return application
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, '__desktopUsageModules')
  document.body.replaceChildren()
})

describe('official alpha2 renderer with the actual positive-fixture adapter', () => {
  it.each(['github-copilot', 'github-copilot-preview'])('exercises inherited/absent and reactive %s transitions with real selector hooks', async (route) => {
    const application = installModules(syntheticClient())
    const originalError = console.error
    const install = vi.spyOn(UiRenderer.SlotRegistry.prototype, 'installScope')
    const evidence = await runPositiveUsageInBrowser(route)
    assertPositiveCopilotUsageEvidence(evidence, route)
    expect(evidence.quotaReads).toBe(4)
    expect(console.error).toBe(originalError)
    expect(document.getElementById('root')).toBe(application)
    expect(application.isConnected).toBe(true)
    expect(document.querySelector('[data-desktop-usage-acceptance]')).toBeNull()
    const adapter: SlotScopeAdapter | undefined = install.mock.calls[0]?.[1]
    assert(adapter !== undefined)
    const absent = adapter.bindingSource(undefined)
    const absentSnapshot = absent.getSnapshot()
    expect(absent.getSnapshot()).toBe(absentSnapshot)
    expect(absentSnapshot.key).toBeUndefined()
    expect(Object.keys(absentSnapshot.hooks)).toEqual(['session'])
    expect(absentSnapshot.hooks.session).toBeUndefined()
    expect(Object.keys(absentSnapshot.keyedHooks)).toEqual(['projection'])
    expect(absentSnapshot.keyedHooks.projection).toBeUndefined()
    expect(absentSnapshot.props.sessionId).toBeUndefined()
    expect(adapter.bindingSource(undefined)).toBe(absent)
    expect(adapter.current.getSnapshot()).toBe(adapter.current.getSnapshot())
    expect(() => { Reflect.apply(adapter.bindingSource.bind(adapter), undefined, [{ sessionId: 'unsupported' }]) })
      .toThrow('Unsupported explicit fixture Session reference')
  })

  it('rejects a real Slot component failure and restores its application, listeners and console', async () => {
    const application = installModules(syntheticClient(true))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    await expect(runPositiveUsageInBrowser('github-copilot')).rejects.toThrow('renderer errors')
    expect(console.error).toBe(errors)
    expect(document.getElementById('root')).toBe(application)
    expect(document.querySelector('[data-desktop-usage-acceptance]')).toBeNull()
    for (const event of ['error', 'unhandledrejection']) {
      const owned = add.mock.calls.find(([name]) => name === event)
      expect(owned).toBeDefined()
      expect(remove.mock.calls.some(([name, listener]) => name === event && listener === owned?.[1])).toBe(true)
    }
  })
})
