/** Synthetic Session acceptance using the packaged module system, renderer, and released Client. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Page } from 'playwright'

/** Positive evidence is fixture-owned; it does not attest authenticated account access. */
export interface PositiveCopilotUsageEvidence {
  readonly scope: 'packaged-renderer-released-client-synthetic-session-and-quota'
  readonly provider: string
  readonly usageText: string
  readonly quotaReads: number
  readonly sessionSubscribed: boolean
  readonly removedSessionHidesUsage: boolean
  readonly otherProviderHidesUsage: boolean
  readonly clientDisposalRemovesUsage: boolean
  readonly selectorErrors: number
  readonly forbiddenRemoteCalls: number
  readonly hostTransport: 'not-provided-to-isolated-fixture'
  readonly applicationMountPreserved: boolean
  readonly syntheticSiblingPreserved: boolean
  readonly inheritedSessionScopeVerified: boolean
  readonly explicitUndefinedSessionScopeAbsent: boolean
  readonly removedSessionRestoresUsage: boolean
  readonly closedSessionHidesUsage: boolean
  readonly closedSessionRestoresUsage: boolean
  readonly restoredProviderShowsUsage: boolean
  readonly subscriptionsReleased: boolean
  readonly syntheticContextDisposed: boolean
}

/**
 * Produce standalone browser JavaScript without source-loader keepNames helpers.
 * @returns Type-stripped fixture functions, with no imports or module closure.
 */
export function packagedUsageBrowserSource(): string {
  const source = readFileSync(new URL('./copilot-usage-positive-browser.ts', import.meta.url), 'utf8')
  return stripTypeScriptTypes(source).replaceAll('\nexport ', '\n')
}

/**
 * Capture the public boot loader on an acceptance-only reload without replacing module exports.
 * @param page - Packaged application page in the smoke runner's isolated profile.
 * @returns Awaited disposer for the owned init script and browser capture globals.
 */
export async function capturePackagedUsageModules(page: Page): Promise<() => Promise<void>> {
  const script = packagedUsageBrowserSource()
  const registration = await page.addInitScript(`${script}\ncaptureUsageModulesInBrowser()`)
  const restore = async (): Promise<void> => {
    let failed = false
    let failure: unknown
    try { await registration.dispose() } catch (error) { failed = true; failure = error }
    try { await page.evaluate(`${script}\nrestoreUsageModulesInBrowser()`) } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
    if (failed) throw failure
  }
  try {
    await page.reload()
    await page.waitForFunction('window.__desktopUsageModules !== undefined')
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible' })
    return restore
  } catch (error) {
    // Cleanup still runs; the failed capture remains the primary exception even if its page is already gone.
    await Promise.allSettled([restore()])
    throw error
  }
}

/**
 * Check the exact v2 positive case fields returned across the browser boundary.
 * @param evidence - Original JSON result from the isolated browser fixture.
 * @param provider - Exact route exercised by this invocation.
 */
export function assertPositiveCopilotUsageEvidence(evidence: unknown, provider: string): asserts evidence is PositiveCopilotUsageEvidence {
  assert(typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence))
  const value = evidence as Record<string, unknown>
  const positive = [
    'sessionSubscribed', 'removedSessionHidesUsage', 'otherProviderHidesUsage', 'clientDisposalRemovesUsage',
    'applicationMountPreserved', 'syntheticSiblingPreserved', 'inheritedSessionScopeVerified',
    'explicitUndefinedSessionScopeAbsent', 'removedSessionRestoresUsage', 'closedSessionHidesUsage',
    'closedSessionRestoresUsage', 'restoredProviderShowsUsage', 'subscriptionsReleased', 'syntheticContextDisposed',
  ]
  assert.deepEqual(Object.keys(value).sort(), [
    ...positive, 'scope', 'provider', 'usageText', 'quotaReads', 'selectorErrors', 'forbiddenRemoteCalls', 'hostTransport',
  ].sort())
  assert(['github-copilot', 'github-copilot-preview'].includes(provider))
  assert.equal(value.scope, 'packaged-renderer-released-client-synthetic-session-and-quota')
  assert.equal(value.provider, provider)
  assert.equal(value.hostTransport, 'not-provided-to-isolated-fixture')
  assert(typeof value.usageText === 'string' && value.usageText.length <= 256)
  assert.match(value.usageText, /(?:^|[^0-9.])7\s+used(?![A-Za-z])/u)
  assert.match(value.usageText, /(?:^|[^0-9.])13\s+left(?![A-Za-z0-9])/u)
  assert.equal(value.quotaReads, 4)
  for (const field of positive) assert.equal(value[field], true, `Positive usage did not establish ${field}`)
  assert.equal(value.selectorErrors, 0)
  assert.equal(value.forbiddenRemoteCalls, 0)
}

/**
 * Mount an isolated synthetic Session through the shipped renderer and real Slot error boundary.
 * @param page - Packaged page whose public module loader has been captured.
 * @param provider - Eligible Copilot route to select without sending a message.
 * @returns Positive DOM and lifecycle observations after subscriptions, context and globals are restored.
 */
export async function inspectPositiveCopilotUsage(page: Page, provider: string): Promise<PositiveCopilotUsageEvidence> {
  const evidence: unknown = await page.evaluate(
    `${packagedUsageBrowserSource()}\nrunPositiveUsageInBrowser(${JSON.stringify(provider)})`,
  )
  assertPositiveCopilotUsageEvidence(evidence, provider)
  return evidence
}
