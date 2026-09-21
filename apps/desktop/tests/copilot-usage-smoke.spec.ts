import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectCopilotUsageCapability,
  inspectSignedOutCopilotUsage,
} from './fixtures/copilot-usage-smoke.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function profile(capability: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-copilot-usage-'))
  roots.push(root)
  const packageRoot = join(root, 'node_modules', 'dsh-github-copilot')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'deployment-baseline.json'), JSON.stringify({ capabilities: [capability] }))
  return root
}

function page(
  counts: { trigger: number; text: number },
  readiness = { account: Promise.resolve(), signIn: Promise.resolve() },
) {
  const trigger = { count: vi.fn(async () => counts.trigger) }
  const text = { count: vi.fn(async () => counts.text) }
  const signIn = { waitFor: vi.fn(() => readiness.signIn) }
  const account = {
    waitFor: vi.fn(() => readiness.account),
    getByRole: vi.fn(() => signIn),
  }
  const locators = {
    locator: vi.fn((selector: string) => selector === '[data-dsh-github-copilot-compact-account]' ? account : trigger),
    getByText: vi.fn(() => text),
  }
  return { page: locators as unknown as Page, locators, account, signIn, trigger, text }
}

const capability = {
  id: 'account-quota-composer-usage',
  required: true,
  evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access',
  tests: [
    { name: 'quota Remote reaches the actual Host gateway without startup or signed-out network requests' },
    { name: 'uses real Cordis Remote tracing and reversible public SlotRegistry registration' },
  ],
}

describe('packaged Copilot usage acceptance', () => {
  it('binds the required immutable capability and exact regression inventory', () => {
    expect(inspectCopilotUsageCapability(profile(capability))).toEqual({
      id: 'account-quota-composer-usage',
      required: true,
      evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access',
      signedOutNetworkRegressionDeclared: true,
      lifecycleRegressionDeclared: true,
    })
  })

  it.each([
    { damage: 'optional', value: { ...capability, required: false } },
    { damage: 'scope', value: { ...capability, evidenceScope: 'live' } },
    { damage: 'network regression', value: { ...capability, tests: capability.tests.slice(1) } },
    { damage: 'lifecycle regression', value: { ...capability, tests: capability.tests.slice(0, 1) } },
  ])('rejects a damaged $damage declaration', ({ value }) => {
    expect(() => inspectCopilotUsageCapability(profile(value))).toThrow()
  })

  it('accepts a signed-out page without quota UI or Remote demand', async () => {
    await expect(inspectSignedOutCopilotUsage(page({ trigger: 0, text: 0 }).page)).resolves.toEqual({
      usageTriggerCount: 0,
      accountUsageTextCount: 0,
      usageSurfaceAbsent: true,
      hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke',
    })
  })

  it('waits for account and sign-in readiness before reading whole-page absence counts', async () => {
    const account = Promise.withResolvers<undefined>()
    const signIn = Promise.withResolvers<undefined>()
    const fixture = page({ trigger: 0, text: 0 }, { account: account.promise, signIn: signIn.promise })
    const inspection = inspectSignedOutCopilotUsage(fixture.page)
    try {
      expect(fixture.trigger.count).not.toHaveBeenCalled()
      expect(fixture.text.count).not.toHaveBeenCalled()
      expect(fixture.account.waitFor).toHaveBeenCalledWith({ state: 'visible' })
      expect(fixture.signIn.waitFor).not.toHaveBeenCalled()
      account.resolve(undefined)
      await Promise.resolve()
      expect(fixture.signIn.waitFor).toHaveBeenCalledWith({ state: 'visible' })
      expect(fixture.account.getByRole).toHaveBeenCalledWith('button', { name: 'Sign in with GitHub', exact: true })
      expect(fixture.trigger.count).not.toHaveBeenCalled()
      expect(fixture.text.count).not.toHaveBeenCalled()
      signIn.resolve(undefined)
      await expect(inspection).resolves.toMatchObject({ usageSurfaceAbsent: true })
      expect(fixture.locators.locator).toHaveBeenCalledWith('[data-copilot-usage-trigger]')
      expect(fixture.locators.getByText).toHaveBeenCalledWith(/^(?:Copilot credits|Premium requests|Copilot usage)$/u)
      expect(fixture.trigger.count).toHaveBeenCalledTimes(1)
      expect(fixture.text.count).toHaveBeenCalledTimes(1)
    } finally {
      account.resolve(undefined)
      signIn.resolve(undefined)
      await inspection.catch(() => {})
    }
  })

  it('rejects usage emitted while the signed-out plugin is still becoming ready', async () => {
    const ready = Promise.withResolvers<undefined>()
    const counts = { trigger: 0, text: 0 }
    const fixture = page(counts, { account: ready.promise, signIn: ready.promise })
    const inspection = inspectSignedOutCopilotUsage(fixture.page)
    counts.trigger = 1
    ready.resolve(undefined)
    await expect(inspection).rejects.toThrow('must not mount the Copilot usage control')
  })

  it.each(['account', 'signIn'] as const)('rejects missing %s readiness without reporting absence evidence', async (missing) => {
    const unavailable = Promise.withResolvers<undefined>()
    // The negative control ignores this promise; observe its rejection independently.
    void unavailable.promise.catch(() => {})
    const fixture = page({ trigger: 0, text: 0 }, {
      account: missing === 'account' ? unavailable.promise : Promise.resolve(),
      signIn: missing === 'signIn' ? unavailable.promise : Promise.resolve(),
    })
    const inspection = inspectSignedOutCopilotUsage(fixture.page)
    unavailable.reject(new Error(`${missing} readiness unavailable`))
    await expect(inspection).rejects.toThrow(`${missing} readiness unavailable`)
    expect(fixture.trigger.count).not.toHaveBeenCalled()
    expect(fixture.text.count).not.toHaveBeenCalled()
  })

  it.each([{ trigger: 1, text: 0 }, { trigger: 0, text: 1 }])(
    'rejects emitted signed-out usage evidence %#', async (counts) => {
      await expect(inspectSignedOutCopilotUsage(page(counts).page)).rejects.toThrow()
    },
  )
})
