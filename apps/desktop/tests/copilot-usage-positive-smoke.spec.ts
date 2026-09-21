import { runInNewContext } from 'node:vm'
import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import {
  inspectPositiveCopilotUsage,
  packagedUsageBrowserSource,
  type PositiveCopilotUsageEvidence,
} from './fixtures/copilot-usage-positive-smoke.ts'

const evidence: PositiveCopilotUsageEvidence = {
  scope: 'packaged-renderer-released-client-synthetic-session-and-quota',
  provider: 'github-copilot', usageText: 'Copilot credits: 7 used', quotaReads: 2,
  sessionSubscribed: true, removedSessionHidesUsage: true, otherProviderHidesUsage: true,
  clientDisposalRemovesUsage: true, selectorErrors: 0, forbiddenRemoteCalls: 0,
  hostTransport: 'not-provided-to-isolated-fixture', applicationMountPreserved: true, syntheticSiblingPreserved: true,
}

function page(result: PositiveCopilotUsageEvidence): Page {
  // Tests the evidence validator only; the release workflow owns the actual packaged browser run.
  return { evaluate: vi.fn(async () => result) } as unknown as Page
}

describe('positive packaged usage evidence validation', () => {
  it.each([false, true])('serializes bootstrap without loader closures and restores create (failure=%s)', (fail) => {
    const modules = {}
    const error = new Error('bootstrap failed')
    const create = vi.fn(() => { if (fail) throw error; return modules })
    const facade = { create }
    const window: { __ModuleLoader__?: typeof facade; __desktopUsageModules?: unknown } = {}
    const script = packagedUsageBrowserSource()
    expect(script).not.toContain('__name')
    runInNewContext(`${script}\ncaptureUsageModulesInBrowser()`, { window })
    window.__ModuleLoader__ = facade
    if (fail) expect(() => facade.create()).toThrow(error)
    else expect(facade.create()).toBe(modules)
    expect(facade.create).toBe(create)
    expect(window.__desktopUsageModules).toBe(fail ? undefined : modules)
    expect(Object.getOwnPropertyDescriptor(window, '__ModuleLoader__')?.value).toBe(facade)
  })

  it('evaluates the emitted positive callback without source-loader helpers', async () => {
    const script = packagedUsageBrowserSource()
    await expect(runInNewContext(`${script}\nrunPositiveUsageInBrowser('github-copilot')`, { window: {} }))
      .rejects.toThrow('Packaged module loader was not captured')
  })

  it('rejects missing public exports before mounting a synthetic context', async () => {
    const load = vi.fn(async () => ({}))
    const window = { __desktopUsageModules: { import: load } }
    await expect(runInNewContext(`${packagedUsageBrowserSource()}\nrunPositiveUsageInBrowser('github-copilot')`, { window }))
      .rejects.toThrow('Packaged Cordis public methods are unavailable')
    expect(load).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/cordis', '', {})
  })

  it('requires positive DOM and real subscription/lifecycle observations', async () => {
    await expect(inspectPositiveCopilotUsage(page(evidence), 'github-copilot')).resolves.toEqual(evidence)
  })

  it.each([
    { usageText: '' }, { quotaReads: 0 }, { quotaReads: 3 }, { sessionSubscribed: false },
    { removedSessionHidesUsage: false }, { otherProviderHidesUsage: false },
    { clientDisposalRemovesUsage: false }, { selectorErrors: 1 }, { forbiddenRemoteCalls: 1 },
    { applicationMountPreserved: false }, { syntheticSiblingPreserved: false }, { provider: 'other-provider' },
  ])('rejects invalid evidence %j', async (damage) => {
    await expect(inspectPositiveCopilotUsage(page({ ...evidence, ...damage }), 'github-copilot')).rejects.toThrow()
  })

  it('rejects a Host-connected result rather than claiming isolated acceptance', async () => {
    const connected = { ...evidence, hostTransport: 'real-host' } as unknown as PositiveCopilotUsageEvidence
    await expect(inspectPositiveCopilotUsage(page(connected), 'github-copilot')).rejects.toThrow()
  })

  it('propagates browser failure instead of accepting absent controls', async () => {
    const broken = { evaluate: vi.fn(async () => { throw new Error('Slot selector failed') }) } as unknown as Page
    await expect(inspectPositiveCopilotUsage(broken, 'github-copilot')).rejects.toThrow('Slot selector failed')
  })
})
