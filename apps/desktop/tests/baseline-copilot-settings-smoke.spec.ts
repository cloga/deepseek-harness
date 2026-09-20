// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Locator } from 'playwright'
import { inspectBaselinePackagedCopilotSettings } from './fixtures/baseline-copilot-settings-smoke.ts'
import { inspectPackagedCopilotSettings } from './fixtures/copilot-settings-smoke.ts'

function fixture(): { root: HTMLElement; settings: Locator } {
  const root = document.createElement('div')
  root.innerHTML = `
    <section data-dsh-dual-model-card aria-busy="false">
      <input data-dsh-dual-model-enabled type="checkbox">
      <button data-dsh-dual-model-save>Save</button>
      <select data-dsh-dual-model-workspace><option value="" disabled selected>Choose workspace</option></select>
      <button data-dsh-dual-model-create disabled>Create</button>
      <select data-dsh-dual-model-planner><option value="">Choose</option></select>
      <select data-dsh-dual-model-executor><option value="">Choose</option></select>
      <p role="status"></p>
    </section>
    <section data-dsh-web-search-routing>
      <label><span>Search provider</span>
        <select data-dsh-web-search-mode>
          <option value="auto" selected>Auto — follow Chat</option>
          <option value="github-copilot-hosted">Copilot</option><option value="deepseek-official">DeepSeek</option>
        </select>
      </label>
      <label><span>Default search provider</span>
        <select data-dsh-web-search-provider>
          <option value="none">None — no fallback</option>
          <option value="deepseek-official" selected>DeepSeek</option><option value="github-copilot-hosted">Copilot</option>
        </select>
      </label>
      <p role="status"></p>
    </section>`
  document.body.append(root)
  const locator = (elements: Element[]): Locator => ({
    locator: (selector: string) => locator(elements.flatMap(element => [...element.querySelectorAll(selector)])),
    waitFor: async () => { if (elements.length !== 1) throw new Error('Expected one ready settings control') },
    getAttribute: async (name: string) => elements[0]!.getAttribute(name),
    allTextContents: async () => elements.map(element => element.textContent ?? ''),
    isChecked: async () => (elements[0] as HTMLInputElement).checked,
    isEnabled: async () => !(elements[0] as HTMLInputElement).disabled,
    inputValue: async () => (elements[0] as HTMLSelectElement).value,
    evaluateAll: async (read: (nodes: Element[]) => unknown) => read(elements),
  }) as unknown as Locator
  return { root, settings: locator([root]) }
}

afterEach(() => { document.body.replaceChildren() })

describe('sequence-12 Copilot alpha.24 baseline settings acceptance', () => {
  it('reproduces the current inspector rejecting the baseline workspace selector', async () => {
    const { settings } = fixture()
    await expect(inspectPackagedCopilotSettings(settings)).rejects.toThrow('The current workspace is read-only, not a workspace selector')
  })

  it('does not weaken the current inspector to accept the old default-provider label', async () => {
    const { root, settings } = fixture()
    root.querySelector('[data-dsh-dual-model-workspace]')!.outerHTML = '<p data-dsh-dual-model-workspace>No workspace selected</p>'
    await expect(inspectPackagedCopilotSettings(settings)).rejects.toThrow()
  })

  it('accepts the original baseline roles and provider catalogs without mutating controls', async () => {
    const { root, settings } = fixture()
    const before = root.innerHTML
    await expect(inspectBaselinePackagedCopilotSettings(settings)).resolves.toEqual({
      modelRolesViewLoaded: true,
      searchProviderCatalogLoaded: true,
      registeredSearchProviders: ['deepseek-official', 'github-copilot-hosted'],
      realSearch: false,
    })
    expect(root.innerHTML).toBe(before)
  })

  it('retains registered providers and excludes disabled saved choices from evidence', async () => {
    const { root, settings } = fixture()
    for (const selector of ['[data-dsh-web-search-mode]', '[data-dsh-web-search-provider]']) {
      root.querySelector(selector)!.insertAdjacentHTML('beforeend', '<option value="another-provider">Another</option>')
    }
    root.querySelector('[data-dsh-web-search-provider]')!
      .insertAdjacentHTML('beforeend', '<option value="retired" disabled>Retired — unavailable</option>')
    root.querySelector('[data-dsh-web-search-routing] [role="status"]')!.textContent = 'A saved provider is no longer registered.'
    expect((await inspectBaselinePackagedCopilotSettings(settings)).registeredSearchProviders)
      .toEqual(['another-provider', 'deepseek-official', 'github-copilot-hosted'])
  })

  it('observes the baseline conditional Copilot model field without configuring it or searching', async () => {
    const { root, settings } = fixture()
    const fallback = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-provider]')!
    fallback.value = 'github-copilot-hosted'
    root.querySelector('[data-dsh-web-search-routing]')!.insertAdjacentHTML('beforeend', `
      <label><span>Copilot search model</span>
        <input data-dsh-copilot-search-model list="dsh-copilot-search-models" value=""
          placeholder="account-authorized Responses model id">
        <datalist id="dsh-copilot-search-models"></datalist>
      </label>`)
    const before = root.innerHTML
    await expect(inspectBaselinePackagedCopilotSettings(settings)).resolves.toEqual({
      modelRolesViewLoaded: true,
      searchProviderCatalogLoaded: true,
      registeredSearchProviders: ['deepseek-official', 'github-copilot-hosted'],
      realSearch: false,
    })
    expect(root.innerHTML).toBe(before)
    expect(fallback.value).toBe('github-copilot-hosted')
    expect(root.querySelector<HTMLInputElement>('[data-dsh-copilot-search-model]')!.value).toBe('')
  })

  it.each([
    'missing-view', 'view-error', 'busy', 'enabled', 'save-disabled', 'create', 'planner-models', 'executor-models',
    'primary-disabled', 'fallback-disabled', 'catalog-error', 'catalog-mismatch', 'duplicate-primary', 'duplicate-fallback',
    'copilot-unavailable', 'legacy-fixed', 'non-auto-primary', 'missing-auto', 'missing-none',
  ] as const)('rejects %s rather than bypassing the baseline Host-view checks', async (damage) => {
    const { root, settings } = fixture()
    const input = root.querySelector<HTMLInputElement>('[data-dsh-dual-model-enabled]')!
    const primary = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-mode]')!
    const fallback = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-provider]')!
    if (damage === 'missing-view') {
      input.disabled = true
    } else if (damage === 'view-error') {
      root.querySelector('[data-dsh-dual-model-card] [role="status"]')!.textContent = 'Could not load model roles'
    } else if (damage === 'busy') {
      root.querySelector('[data-dsh-dual-model-card]')!.setAttribute('aria-busy', 'true')
    } else if (damage === 'enabled') {
      input.checked = true
    } else if (damage === 'save-disabled') {
      root.querySelector<HTMLButtonElement>('[data-dsh-dual-model-save]')!.disabled = true
    } else if (damage === 'create') {
      root.querySelector<HTMLButtonElement>('[data-dsh-dual-model-create]')!.disabled = false
    } else if (damage === 'planner-models' || damage === 'executor-models') {
      const role = damage === 'planner-models' ? 'planner' : 'executor'
      root.querySelector(`[data-dsh-dual-model-${role}]`)!.insertAdjacentHTML('beforeend', '<option value="model">Model</option>')
    } else if (damage === 'primary-disabled' || damage === 'fallback-disabled') {
      const select = damage === 'primary-disabled' ? primary : fallback
      select.disabled = true
    } else if (damage === 'catalog-error') {
      root.querySelector('[data-dsh-web-search-routing] [role="status"]')!.textContent = 'Search provider list is unavailable.'
    } else if (damage === 'catalog-mismatch') {
      fallback.insertAdjacentHTML('beforeend', '<option value="other">Other</option>')
    } else if (damage === 'duplicate-primary' || damage === 'duplicate-fallback') {
      const select = damage === 'duplicate-primary' ? primary : fallback
      select.insertAdjacentHTML('beforeend', '<option value="github-copilot-hosted">Duplicate</option>')
    } else if (damage === 'copilot-unavailable') {
      for (const option of root.querySelectorAll<HTMLOptionElement>('option[value="github-copilot-hosted"]')) option.disabled = true
    } else if (damage === 'legacy-fixed') {
      primary.querySelector('option[value="auto"]')!.setAttribute('value', 'fixed')
    } else if (damage === 'non-auto-primary') {
      primary.value = 'github-copilot-hosted'
    } else if (damage === 'missing-auto') {
      primary.querySelector('option[value="auto"]')!.remove()
    } else {
      fallback.querySelector('option[value="none"]')!.remove()
    }
    await expect(inspectBaselinePackagedCopilotSettings(settings)).rejects.toThrow()
  })
})
