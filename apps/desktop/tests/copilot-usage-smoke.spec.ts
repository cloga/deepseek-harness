import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
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

function page(counts: { trigger: number; text: number }): Page {
  const locator = (count: number): Locator => ({ count: async () => count }) as unknown as Locator
  return {
    locator: () => locator(counts.trigger),
    getByText: () => locator(counts.text),
  } as unknown as Page
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
    await expect(inspectSignedOutCopilotUsage(page({ trigger: 0, text: 0 }))).resolves.toEqual({
      usageTriggerCount: 0,
      accountUsageTextCount: 0,
      usageSurfaceAbsent: true,
      hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke',
    })
  })

  it.each([{ trigger: 1, text: 0 }, { trigger: 0, text: 1 }])(
    'rejects emitted signed-out usage evidence %#', async counts => {
      await expect(inspectSignedOutCopilotUsage(page(counts))).rejects.toThrow()
    },
  )
})
