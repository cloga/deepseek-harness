import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { openNativeComposerFixture } from './fixtures/native-composer-geometry.ts'

function fixture(sidebarExpanded: boolean, workspaceExpanded: boolean, seedReady = Promise.resolve()) {
  let sidebarOpen = sidebarExpanded
  let groupOpen = workspaceExpanded
  let selected = false
  const reveal = {
    isVisible: vi.fn(async () => !sidebarOpen),
    click: vi.fn(async () => { sidebarOpen = true }),
  }
  const collapse = { waitFor: vi.fn(async () => { expect(sidebarOpen).toBe(true) }) }
  const workspace = {
    waitFor: vi.fn(async () => { expect(sidebarOpen).toBe(true) }),
    getAttribute: vi.fn(async () => String(groupOpen)),
    click: vi.fn(async () => { groupOpen = !groupOpen }),
  }
  const seeded = {
    waitFor: vi.fn(async () => { expect(sidebarOpen && groupOpen).toBe(true); await seedReady }),
    click: vi.fn(async () => { expect(sidebarOpen && groupOpen).toBe(true); selected = true }),
  }
  const reply = { waitFor: vi.fn(async () => { expect(selected).toBe(true) }) }
  // Only navigation calls are modeled here. Actual DOM and geometry remain mandatory in packaged acceptance.
  const page = {
    getByRole: vi.fn((role: string, options?: { name: string; exact: boolean }) => {
      if (role === 'treeitem') {
        return {
          filter: ({ hasText }: { hasText: string }) => {
            if (hasText === 'synthetic-composer-workspace') return { first: () => workspace }
            expect(hasText).toBe('DESKTOP_INLINE_STATS_SYNTHETIC')
            return seeded
          },
        }
      }
      expect(role).toBe('button')
      expect(options?.exact).toBe(true)
      if (options?.name === 'Open sidebar') return reveal
      expect(options?.name).toBe('Collapse sidebar')
      return collapse
    }),
    getByText: vi.fn((text: string) => {
      expect(text).toBe('Synthetic settled reply; no inference occurred.')
      return reply
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
