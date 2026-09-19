/** Read-only acceptance of the release-owned Copilot settings Remote views. */
import assert from 'node:assert/strict'
import type { Locator } from 'playwright'

/** Read-only settings evidence; registration does not imply provider availability or a search call. */
export interface CopilotSettingsEvidence {
  readonly modelRolesViewLoaded: true
  readonly currentWorkspaceReadOnly: true
  readonly searchProviderCatalogLoaded: true
  readonly registeredSearchProviders: readonly string[]
  readonly realSearch: false
}

/**
 * Require positive Host-view readiness in a fresh signed-out Models dialog, without changing its settings.
 * @param settings - Actual packaged Desktop Settings dialog, already displaying Models.
 * @returns Observed registration IDs and read-only completion markers.
 */
export async function inspectPackagedCopilotSettings(settings: Locator): Promise<CopilotSettingsEvidence> {
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

  const workspaces = await roles.locator('[data-dsh-dual-model-workspace]')
    .evaluateAll(elements => elements.map(element => ({
      tag: element.tagName,
      label: element.textContent?.trim(),
      editable: element.getAttribute('contenteditable'),
    })))
  assert.equal(workspaces.length, 1, 'Model roles must show the current workspace')
  assert.equal(workspaces[0]!.tag, 'P', 'The current workspace is read-only, not a workspace selector')
  assert(workspaces[0]!.label, 'The current workspace must have a visible label or unavailable explanation')
  assert(workspaces[0]!.editable === null || workspaces[0]!.editable === 'false')

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
  return {
    modelRolesViewLoaded: true, currentWorkspaceReadOnly: true, searchProviderCatalogLoaded: true,
    registeredSearchProviders: primaryIds, realSearch: false,
  }
}
