// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Locator } from 'playwright'
import { inspectPackagedCopilotSettings } from './fixtures/copilot-settings-smoke.ts'

function fixture(beforeWait?: (selector: string) => Promise<void>): { root: HTMLElement; settings: Locator } {
  const root = document.createElement('div')
  root.innerHTML = `
    <section data-dsh-github-copilot-compact-account>
      <span role="status">Signed out</span>
      <button>Sign in with GitHub</button>
    </section>
    <section data-dsh-web-search-routing>
      <label><span>Search provider</span>
        <select data-dsh-web-search-mode>
          <option value="auto" selected>Auto — follow Chat</option>
          <option value="github-copilot-hosted">Copilot</option><option value="deepseek-official">DeepSeek</option>
        </select>
      </label>
      <label><span>Fallback provider</span>
        <select data-dsh-web-search-provider>
          <option value="none">None — no fallback</option>
          <option value="deepseek-official" selected>DeepSeek</option><option value="github-copilot-hosted">Copilot</option>
        </select>
      </label>
      <p role="status"></p>
    </section>`
  document.body.append(root)
  // Resolve each read again so a deferred readiness wait observes later DOM updates.
  const locator = (select: () => Element[], selector: string): Locator => ({
    locator: (child: string) => locator(() => select().flatMap(element => [...element.querySelectorAll(child)]), child),
    filter: ({ hasText }: { hasText: RegExp }) => locator(() => select().filter(element => hasText.test(element.textContent ?? '')), selector),
    waitFor: async () => {
      await beforeWait?.(selector)
      const elements = select()
      if (elements.length !== 1 || elements[0]!.hasAttribute('hidden')) throw new Error('Expected one ready settings control')
    },
    count: async () => select().length,
    allTextContents: async () => select().map(element => element.textContent ?? ''),
    inputValue: async () => (select()[0] as HTMLSelectElement).value,
    evaluateAll: async (read: (nodes: Element[]) => unknown) => read(select()),
  }) as unknown as Locator
  return { root, settings: locator(() => [root], '') }
}

afterEach(() => { document.body.replaceChildren() })

describe('read-only packaged Copilot settings acceptance', () => {
  it('records schema v3 retirement after retained views load without mutating controls or assuming provider usability', async () => {
    const { root, settings } = fixture()
    const before = root.innerHTML
    await expect(inspectPackagedCopilotSettings(settings)).resolves.toEqual({
      schemaVersion: 3,
      accountViewLoaded: true,
      retiredModelRolesAbsent: true,
      searchProviderCatalogLoaded: true,
      providerOnlySearchRouting: true,
      fallbackProviderLabel: true,
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
    '<section data-dsh-dual-model-card></section>',
    '<section data-dsh-dual-model-card hidden></section>',
    '<select data-dsh-dual-model-planner></select>',
    '<select data-dsh-dual-model-executor></select>',
    '<button data-dsh-dual-model-create>Create</button>',
    '<button>Copilot · Model roles</button>',
    '<h3>Model roles</h3>',
  ])('rejects a stale role surface: %s', async (html) => {
    const { root, settings } = fixture()
    root.insertAdjacentHTML('beforeend', html)
    await expect(inspectPackagedCopilotSettings(settings)).rejects.toThrow('Retired Model roles')
  })

  it.each(['account', 'search'] as const)('does not establish absence before %s readiness', async (surface) => {
    const selector = surface === 'account' ? '[role="status"]' : '[data-dsh-web-search-mode]:enabled'
    let release!: () => void
    let reached!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    const waiting = new Promise<void>((resolve) => { reached = resolve })
    const { root, settings } = fixture(async (current) => {
      if (current === selector) { reached(); await ready }
    })
    const status = root.querySelector('[data-dsh-github-copilot-compact-account] [role="status"]')!
    const primary = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-mode]')!
    if (surface === 'account') status.textContent = 'Checking status…'
    else primary.disabled = true
    const inspection = inspectPackagedCopilotSettings(settings)
    await waiting
    root.insertAdjacentHTML('beforeend', '<section data-dsh-dual-model-card></section>')
    status.textContent = 'Signed out'
    primary.disabled = false
    release()
    await expect(inspection).rejects.toThrow('Retired Model roles')
  })

  it.each([
    'empty-dialog', 'missing-account', 'account-loading', 'account-error', 'sign-in-disabled', 'signed-in',
    'missing-search', 'catalog-disabled', 'catalog-error', 'catalog-mismatch', 'duplicate', 'copilot-unavailable', 'legacy-fixed',
    'legacy-fallback-label', 'model-prerequisite',
  ] as const)(
    'rejects %s instead of reporting successful Remote reads', async (damage) => {
      const { root, settings } = fixture()
      const account = root.querySelector('[data-dsh-github-copilot-compact-account]')!
      const primary = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-mode]')!
      const fallback = root.querySelector<HTMLSelectElement>('[data-dsh-web-search-provider]')!
      if (damage === 'empty-dialog') {
        root.replaceChildren()
      } else if (damage === 'missing-account') {
        account.remove()
      } else if (damage === 'account-loading' || damage === 'signed-in') {
        account.querySelector('[role="status"]')!.textContent = damage === 'account-loading' ? 'Checking status…' : 'Signed in'
      } else if (damage === 'account-error') {
        account.insertAdjacentHTML('beforeend', '<p data-dsh-github-copilot-account-error>Could not load status</p>')
      } else if (damage === 'sign-in-disabled') {
        account.querySelector('button')!.disabled = true
      } else if (damage === 'missing-search') {
        root.querySelector('[data-dsh-web-search-routing]')!.remove()
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
      } else if (damage === 'legacy-fixed') {
        primary.querySelector('option[value="auto"]')!.setAttribute('value', 'fixed')
      } else if (damage === 'legacy-fallback-label') {
        fallback.closest('label')!.querySelector('span')!.textContent = 'Default provider'
      } else {
        fallback.insertAdjacentHTML('afterend', '<input data-dsh-copilot-search-model>')
      }
      await expect(inspectPackagedCopilotSettings(settings)).rejects.toThrow()
    },
  )
})
