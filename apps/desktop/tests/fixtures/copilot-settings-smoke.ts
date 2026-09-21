/** Read-only acceptance of the release-owned Copilot settings Remote views. */
import assert from 'node:assert/strict'
import type { Locator } from 'playwright'

/** V3 records role retirement, not V2's legacy role loading; registration does not imply provider availability or a search call. */
export interface CopilotSettingsEvidence {
  readonly schemaVersion: 3
  readonly accountViewLoaded: true
  readonly retiredModelRolesAbsent: true
  readonly searchProviderCatalogLoaded: true
  readonly providerOnlySearchRouting: true
  readonly fallbackProviderLabel: true
  readonly registeredSearchProviders: readonly string[]
  readonly realSearch: false
}

/**
 * Require positive Host-view readiness in a fresh signed-out Models dialog, without changing its settings.
 * @param settings - Actual packaged Desktop Settings dialog, already displaying Models.
 * @returns Observed registration IDs and read-only completion markers.
 */
export async function inspectPackagedCopilotSettings(settings: Locator): Promise<CopilotSettingsEvidence> {
  const account = settings.locator('[data-dsh-github-copilot-compact-account]')
  await account.locator('[role="status"]').filter({ hasText: /^Signed out$/ }).waitFor({ state: 'visible' })
  await account.locator('button:enabled').filter({ hasText: /^Sign in with GitHub$/ }).waitFor({ state: 'visible' })
  assert.equal(await account.locator('[data-dsh-github-copilot-account-error]').count(), 0,
    'The signed-out account view must load without an error')

  const search = settings.locator('[data-dsh-web-search-routing]')
  const primarySelector = '[data-dsh-web-search-mode]'
  const fallbackSelector = '[data-dsh-web-search-provider]'
  await search.locator(`${primarySelector}:enabled`).waitFor({ state: 'visible' })
  await search.locator(`${fallbackSelector}:enabled`).waitFor({ state: 'visible' })
  const fieldLabels = await search.locator('label > span:first-child')
    .evaluateAll(elements => elements.map(element => element.textContent?.trim()))
  assert.deepEqual(fieldLabels, ['Search provider', 'Fallback provider'])
  const modelControls = await search.locator('input, [data-dsh-copilot-search-model]')
    .evaluateAll(elements => elements.length)
  assert.equal(modelControls, 0, 'Ordinary search routing must remain provider-only without a model prerequisite')
  const searchStatus = (await search.locator('[role="status"]').allTextContents()).join(' ')
  assert(!searchStatus.includes('Search provider list is unavailable.'), 'Search registration catalog must load')
  assert.equal(await search.locator(primarySelector).inputValue(), 'auto')
  const primary = await search.locator(`${primarySelector} option:not(:disabled)`)
    .evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() })))
  const fallback = await search.locator(`${fallbackSelector} option:not(:disabled)`)
    .evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() })))
  assert(primary.some(option => option.value === 'auto' && option.text === 'Auto — follow Chat'))
  assert(fallback.some(option => option.value === 'none' && option.text === 'None — no fallback'))
  assert(!primary.some(option => option.value === 'fixed'), 'Legacy Auto/fixed controls do not establish provider catalog loading')
  const primaryIds = primary.filter(option => option.value !== 'auto').map(option => option.value).sort()
  const fallbackIds = fallback.filter(option => option.value !== 'none').map(option => option.value).sort()
  assert.equal(new Set(primaryIds).size, primaryIds.length)
  assert.equal(new Set(fallbackIds).size, fallbackIds.length)
  assert(primaryIds.includes('github-copilot-hosted'), 'The signed-out Copilot provider must still be registered')
  assert.deepEqual(primaryIds, fallbackIds, 'Both selectors must project the same registered provider catalog')
  // Check retirement only after retained account and search views have loaded.
  const roleControls = await settings.locator('*').evaluateAll(elements => elements.filter(element =>
    element.getAttributeNames().some(name => name.startsWith('data-dsh-dual-model-'))).length)
  assert.equal(roleControls, 0, 'Retired Model roles controls must be absent, including hidden controls')
  assert.equal(await settings.locator('button, [role="tab"], h1, h2, h3')
    .filter({ hasText: /^(?:Copilot\s*·\s*)?(?:Model roles|模型分工)$/i }).count(), 0,
  'Retired Model roles settings entries must be absent')
  return {
    schemaVersion: 3, accountViewLoaded: true, retiredModelRolesAbsent: true, searchProviderCatalogLoaded: true,
    providerOnlySearchRouting: true, fallbackProviderLabel: true,
    registeredSearchProviders: primaryIds, realSearch: false,
  }
}
