// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Locator } from 'playwright'
import { inspectPackagedCopilotSettings } from './fixtures/copilot-settings-smoke.ts'

function fixture(): { root: HTMLElement; settings: Locator } {
  const root = document.createElement('div')
  root.innerHTML = `
    <section data-dsh-dual-model-card aria-busy="false">
      <input data-dsh-dual-model-enabled type="checkbox">
      <button data-dsh-dual-model-save>Save</button>
      <button data-dsh-dual-model-create disabled>Create</button>
      <select data-dsh-dual-model-planner><option value="">Choose</option></select>
      <select data-dsh-dual-model-executor><option value="">Choose</option></select>
      <p role="status"></p>
    </section>
    <section data-dsh-web-search-routing>
      <select data-dsh-web-search-mode>
        <option value="auto" selected>Auto — follow Chat</option>
        <option value="github-copilot-hosted">Copilot</option><option value="deepseek-official">DeepSeek</option>
      </select>
      <select data-dsh-web-search-provider>
        <option value="none">None — no fallback</option>
        <option value="deepseek-official" selected>DeepSeek</option><option value="github-copilot-hosted">Copilot</option>
      </select>
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

describe('read-only packaged Copilot settings acceptance', () => {
  it('accepts loaded signed-out views without mutating controls or assuming provider usability', async () => {
    const { root, settings } = fixture()
    const before = root.innerHTML
    await expect(inspectPackagedCopilotSettings(settings)).resolves.toEqual({
      modelRolesViewLoaded: true,
      searchProviderCatalogLoaded: true,
      registeredSearchProviders: ['deepseek-official', 'github-copilot-hosted'],
      realSearch: false,
    })
    expect(root.innerHTML).toBe(before)
  })

  it('allows other registered providers and ignores disabled unavailable options', async () => {
    const { root, settings } = fixture()
    for (const selector of ['[data-dsh-web-search-mode]', '[data-dsh-web-search-provider]']) {
      root.querySelector(selector)!.insertAdjacentHTML('beforeend', '<option value="another-provider">Another</option>')
    }
    root.querySelector('[data-dsh-web-search-provider]')!
      .insertAdjacentHTML('beforeend', '<option value="retired" disabled>Retired — unavailable</option>')
    root.querySelector('[data-dsh-web-search-routing] [role="status"]')!.textContent = 'A saved provider is no longer registered.'
    expect((await inspectPackagedCopilotSettings(settings)).registeredSearchProviders)
      .toEqual(['another-provider', 'deepseek-official', 'github-copilot-hosted'])
  })

  it.each([
    'missing-view', 'view-error', 'busy', 'enabled', 'save-disabled', 'create', 'models',
    'catalog-disabled', 'catalog-error', 'catalog-mismatch', 'duplicate', 'copilot-unavailable', 'legacy-fixed',
  ] as const)(
    'rejects %s instead of reporting successful Remote reads', async (damage) => {
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
      } else if (damage === 'models') {
        root.querySelector('[data-dsh-dual-model-planner]')!.insertAdjacentHTML('beforeend', '<option value="model">Model</option>')
      } else if (damage === 'catalog-disabled') {
        fallback.disabled = true
      } else if (damage === 'catalog-error') {
        root.querySelector('[data-dsh-web-search-routing] [role="status"]')!.textContent = 'Search provider list is unavailable.'
      } else if (damage === 'catalog-mismatch') {
        fallback.insertAdjacentHTML('beforeend', '<option value="other">Other</option>')
      } else if (damage === 'duplicate') {
        primary.insertAdjacentHTML('beforeend', '<option value="github-copilot-hosted">Duplicate</option>')
      } else if (damage === 'copilot-unavailable') {
        for (const option of root.querySelectorAll<HTMLOptionElement>('option[value="github-copilot-hosted"]')) option.disabled = true
      } else {
        primary.querySelector('option[value="auto"]')!.setAttribute('value', 'fixed')
      }
      await expect(inspectPackagedCopilotSettings(settings)).rejects.toThrow()
    },
  )
})
