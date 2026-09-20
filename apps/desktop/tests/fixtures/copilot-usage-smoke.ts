/** Read-only packaged evidence for the alpha32 Copilot account-usage capability. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'

/** Immutable package capability facts retained as acceptance evidence. */
export interface CopilotUsageCapabilityEvidence {
  readonly id: 'account-quota-composer-usage'
  readonly required: true
  readonly evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access'
  readonly signedOutNetworkRegressionDeclared: true
  readonly lifecycleRegressionDeclared: true
}

/** Signed-out DOM evidence without creating a Session or invoking the usage Remote. */
export interface SignedOutCopilotUsageEvidence {
  readonly usageTriggerCount: 0
  readonly accountUsageTextCount: 0
  readonly usageSurfaceAbsent: true
  readonly hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke'
}

/**
 * Read the installed plugin's immutable capability declaration without loading its code.
 * @param profile - Isolated packaged Desktop profile after provisioning.
 * @returns Minimal owned evidence for the required alpha32 capability and its regressions.
 */
export function inspectCopilotUsageCapability(profile: string): CopilotUsageCapabilityEvidence {
  const raw: unknown = JSON.parse(readFileSync(join(
    profile, 'node_modules', 'dsh-github-copilot', 'deployment-baseline.json',
  ), 'utf8'))
  assert(typeof raw === 'object' && raw !== null)
  const capabilities = Reflect.get(raw, 'capabilities') as unknown
  assert(Array.isArray(capabilities))
  const capability = capabilities.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null
    && Reflect.get(candidate, 'id') === 'account-quota-composer-usage') as unknown
  assert(typeof capability === 'object' && capability !== null)
  assert(Reflect.get(capability, 'required') === true)
  assert(Reflect.get(capability, 'evidenceScope')
    === 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access')
  const tests = Reflect.get(capability, 'tests') as unknown
  assert(Array.isArray(tests))
  const names = tests.map((test: unknown) => {
    if (typeof test !== 'object' || test === null) return undefined
    const name = Reflect.get(test, 'name') as unknown
    return typeof name === 'string' ? name : undefined
  })
  assert(names.includes('quota Remote reaches the actual Host gateway without startup or signed-out network requests'))
  assert(names.includes('uses real Cordis Remote tracing and reversible public SlotRegistry registration'))
  return {
    id: 'account-quota-composer-usage', required: true,
    evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access',
    signedOutNetworkRegressionDeclared: true, lifecycleRegressionDeclared: true,
  }
}

/**
 * Assert that a fresh signed-out, no-Session page emits no account-usage presentation.
 * The immutable capability regression owns the Host no-network claim; this DOM check has no Host-request instrumentation.
 * @param page - Actual packaged Desktop application page.
 * @returns Actual emitted DOM counts and the explicit no-invocation boundary.
 */
export async function inspectSignedOutCopilotUsage(page: Page): Promise<SignedOutCopilotUsageEvidence> {
  const usageTriggerCount = await page.locator('[data-copilot-usage-trigger]').count()
  assert.equal(usageTriggerCount, 0, 'Signed-out startup without a Session must not mount the Copilot usage control')
  const accountUsageTextCount = await page.getByText(/^(?:Copilot credits|Premium requests|Copilot usage)$/u).count()
  assert.equal(accountUsageTextCount, 0, 'Signed-out startup must not emit account quota or credit summaries')
  return {
    usageTriggerCount: 0, accountUsageTextCount: 0, usageSurfaceAbsent: true,
    hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke',
  }
}
