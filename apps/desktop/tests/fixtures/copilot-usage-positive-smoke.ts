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
 * Capture the public boot loader on an acceptance-only reload without replacing any module exports.
 * @param page - Packaged application page in the smoke runner's isolated profile.
 */
export async function capturePackagedUsageModules(page: Page): Promise<void> {
  await page.addInitScript(`${packagedUsageBrowserSource()}\ncaptureUsageModulesInBrowser()`)
  await page.reload()
  await page.waitForFunction('window.__desktopUsageModules !== undefined')
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible' })
}

/**
 * Mount an isolated synthetic Session through the shipped renderer and real Slot error boundary.
 * The fixture provides only synthetic quota; it has no Host transport or credential service.
 * @param page - Packaged page whose public module loader has been captured.
 * @param provider - Eligible Copilot route to select without sending a message.
 * @returns Positive DOM, lifecycle, selector, and denied-Remote observations.
 */
export async function inspectPositiveCopilotUsage(page: Page, provider: string): Promise<PositiveCopilotUsageEvidence> {
  const evidence = await page.evaluate<PositiveCopilotUsageEvidence>(
    `${packagedUsageBrowserSource()}\nrunPositiveUsageInBrowser(${JSON.stringify(provider)})`,
  )
  assert.equal(evidence.scope, 'packaged-renderer-released-client-synthetic-session-and-quota')
  assert.equal(evidence.provider, provider)
  assert.equal(evidence.hostTransport, 'not-provided-to-isolated-fixture')
  assert.match(evidence.usageText, /7 used/u)
  assert.equal(evidence.quotaReads, 2)
  assert.equal(evidence.sessionSubscribed, true)
  assert.equal(evidence.removedSessionHidesUsage, true)
  assert.equal(evidence.otherProviderHidesUsage, true)
  assert.equal(evidence.clientDisposalRemovesUsage, true)
  assert.equal(evidence.applicationMountPreserved, true)
  assert.equal(evidence.syntheticSiblingPreserved, true)
  assert.equal(evidence.selectorErrors, 0)
  assert.equal(evidence.forbiddenRemoteCalls, 0)
  return evidence
}
