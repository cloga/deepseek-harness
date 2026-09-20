/** Read-only settings acceptance owned by dsh-desktop-v0.1.6-alpha.1.cloga.2 and its Copilot alpha.24 package. */
import assert from 'node:assert/strict'
import type { Locator } from 'playwright'

/** Baseline Host-view evidence; it does not assert the candidate's workspace or provider-only UI. */
export interface BaselineCopilotSettingsEvidence {
  readonly modelRolesViewLoaded: true
  readonly searchProviderCatalogLoaded: true
  readonly registeredSearchProviders: readonly string[]
  readonly realSearch: false
}

/**
 * Apply the immutable baseline's qualified roles/catalog checks without changing settings.
 * The installed-upgrade caller must first validate the pinned sequence-12 Desktop and Copilot alpha.24 identity.
 * Candidate and packaged acceptance must use the current inspector, never this baseline inspector as a fallback.
 * @param settings - Baseline Desktop Settings dialog, already displaying Models.
 * @returns Observed registration IDs and the original baseline's read-only completion markers.
 */
export async function inspectBaselinePackagedCopilotSettings(settings: Locator): Promise<BaselineCopilotSettingsEvidence> {
  const roles = settings.locator('[data-dsh-dual-model-card]')
  await roles.locator('[data-dsh-dual-model-enabled]:enabled').waitFor({ state: 'visible' })
  assert.equal(await roles.getAttribute('aria-busy'), 'false')
  assert.equal((await roles.locator('[role="status"]').allTextContents()).join('').trim(), '',
    'Model roles must not show a view-load error')
  assert.equal(await roles.locator('[data-dsh-dual-model-enabled]').isChecked(), false)
  assert.equal(await roles.locator('[data-dsh-dual-model-save]').isEnabled(), true, 'A valid disabled configuration must be writable')
  assert.equal(await roles.locator('[data-dsh-dual-model-create]').isEnabled(), false)
  for (const selector of ['[data-dsh-dual-model-planner]', '[data-dsh-dual-model-executor]']) {
    assert.equal(await roles.locator(selector).inputValue(), '')
    const values = await roles.locator(`${selector} option`)
      .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    assert.deepEqual(values, [''])
  }

  const search = settings.locator('[data-dsh-web-search-routing]')
  const primarySelector = '[data-dsh-web-search-mode]'
  const fallbackSelector = '[data-dsh-web-search-provider]'
  await search.locator(`${primarySelector}:enabled`).waitFor({ state: 'visible' })
  await search.locator(`${fallbackSelector}:enabled`).waitFor({ state: 'visible' })
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
  return { modelRolesViewLoaded: true, searchProviderCatalogLoaded: true, registeredSearchProviders: primaryIds, realSearch: false }
}
