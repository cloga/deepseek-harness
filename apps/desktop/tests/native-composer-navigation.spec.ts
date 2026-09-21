import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { openNativeComposerFixture } from './fixtures/native-composer-geometry.ts'

function fixture(sidebarExpanded: boolean, workspaceExpanded: boolean, seedReady = Promise.resolve(), title = 'synthetic-composer-workspace') {
  let sidebarOpen = sidebarExpanded
  let groupOpen = workspaceExpanded
  let selected = false
  const reveal = {
    isVisible: vi.fn(async () => !sidebarOpen),
    click: vi.fn(async () => { sidebarOpen = true }),
  }
  const collapse = { waitFor: vi.fn(async () => { expect(sidebarOpen).toBe(true) }) }
  const workspace = {
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => { expect(sidebarOpen).toBe(true) }),
    getAttribute: vi.fn(async () => String(groupOpen)),
    click: vi.fn(async () => { groupOpen = !groupOpen }),
  }
  const seeded = {
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => { expect(sidebarOpen && groupOpen).toBe(true); await seedReady }),
    click: vi.fn(async () => { expect(sidebarOpen && groupOpen).toBe(true); selected = true }),
  }
  const reply = { waitFor: vi.fn(async () => { expect(selected).toBe(true) }) }
  // Only navigation calls are modeled here. Actual DOM and geometry remain mandatory in packaged acceptance.
  const page = {
    getByRole: vi.fn((role: string, options?: { name: string; exact: boolean }) => {
      expect(role).toBe('button')
      expect(options?.exact).toBe(true)
      if (options?.name === 'Open sidebar') return reveal
      expect(options?.name).toBe('Collapse sidebar')
      return collapse
    }),
    locator: vi.fn((selector: string) => ({
      filter: ({ has }: { has: { text: string | RegExp; exact?: boolean } }) => {
        if (selector === '[role="treeitem"][aria-expanded]') {
          expect(has).toEqual({ text: 'synthetic-composer-workspace', exact: true })
          return workspace
        }
        expect(selector).toBe('[role="treeitem"][aria-selected]')
        if (typeof has.text === 'string') throw new Error('Session matcher must cover cold and folded titles')
        expect(has.text.test(title)).toBe(true)
        expect(has.text.test('New Session')).toBe(false)
        expect(has.text.test('synthetic-composer-workspace-other')).toBe(false)
        return seeded
      },
    })),
    getByText: vi.fn((text: string | RegExp, options?: { exact: boolean }) => {
      if (text === 'Synthetic settled reply; no inference occurred.') return reply
      return { text, ...options }
    }),
  } as unknown as Page
  return { page, reveal, collapse, workspace, seeded, reply }
}

describe('packaged native composer fixture navigation', () => {
  it.each([
    { sidebarExpanded: false, workspaceExpanded: false },
    { sidebarExpanded: false, workspaceExpanded: true },
    { sidebarExpanded: true, workspaceExpanded: false },
    { sidebarExpanded: true, workspaceExpanded: true },
  ])('reveals native controls without toggling already-expanded state: %j', async ({ sidebarExpanded, workspaceExpanded }) => {
    const bench = fixture(sidebarExpanded, workspaceExpanded)
    await openNativeComposerFixture(bench.page)
    expect(bench.reveal.click).toHaveBeenCalledTimes(sidebarExpanded ? 0 : 1)
    expect(bench.workspace.click).toHaveBeenCalledTimes(workspaceExpanded ? 0 : 1)
    expect(bench.workspace.getAttribute).toHaveBeenCalledExactlyOnceWith('aria-expanded')
    expect(bench.seeded.click).toHaveBeenCalledTimes(1)
    for (const locator of [bench.collapse, bench.workspace, bench.seeded, bench.reply]) {
      expect(locator.waitFor).toHaveBeenCalledExactlyOnceWith({ state: 'visible', timeout: 15_000 })
    }
  })

  it.each(['synthetic-composer-workspace', 'DESKTOP_INLINE_STATS_SYNTHETIC'])('accepts the exact cold or folded Session title: %s', async (title) => {
    const bench = fixture(true, true, Promise.resolve(), title)
    await openNativeComposerFixture(bench.page)
    expect(bench.seeded.count).toHaveBeenCalledTimes(1)
    expect(bench.seeded.click).toHaveBeenCalledTimes(1)
  })

  it.each(['workspace', 'seeded'] as const)('rejects ambiguous %s rows before selection', async (kind) => {
    const bench = fixture(true, true)
    bench[kind].count.mockResolvedValue(2)
    await expect(openNativeComposerFixture(bench.page)).rejects.toThrow('Exactly one')
    expect(bench.workspace.click).not.toHaveBeenCalled()
    expect(bench.seeded.click).not.toHaveBeenCalled()
  })

  it('waits for the seeded row rather than closing an expanded group while its contents load', async () => {
    const ready = Promise.withResolvers<undefined>()
    const bench = fixture(false, true, ready.promise)
    const opening = openNativeComposerFixture(bench.page)
    try {
      await vi.waitFor(() => { expect(bench.seeded.waitFor).toHaveBeenCalledTimes(1) })
      expect(bench.workspace.click).not.toHaveBeenCalled()
      expect(bench.seeded.click).not.toHaveBeenCalled()
      ready.resolve(undefined)
      await opening
      expect(bench.seeded.click).toHaveBeenCalledTimes(1)
    } finally {
      ready.resolve(undefined)
      await opening
    }
  })

  it('rejects a missing workspace expansion contract rather than blindly clicking', async () => {
    const bench = fixture(true, false)
    bench.workspace.getAttribute.mockResolvedValue('unknown')
    await expect(openNativeComposerFixture(bench.page)).rejects.toThrow('workspace row must expose its expansion state')
    expect(bench.workspace.click).not.toHaveBeenCalled()
    expect(bench.seeded.click).not.toHaveBeenCalled()
  })
})
