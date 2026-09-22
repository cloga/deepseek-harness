import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import {
  assertNativeComposerGeometry, inspectNativeComposerGeometry, type NativeComposerGeometry,
} from './fixtures/native-composer-geometry.ts'

const wide: NativeComposerGeometry = {
  viewportWidth: 1280,
  dock: { x: 200, y: 600, width: 800, height: 26 },
  time: { x: 300, y: 604, width: 100, height: 22 },
  usage: { x: 412, y: 604, width: 180, height: 22 },
  copilot: { x: 604, y: 604, width: 150, height: 22 },
  nativeStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
  copilotStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
}

/** Boundary probe stops before geometry or dialogs; it checks actual locator construction, not native UI. */
function locatorFixture(duplicate?: 'outlet' | 'time' | 'usage' | 'copilot') {
  const control = (name: string) => ({
    waitFor: vi.fn(async () => {}), count: vi.fn(async () => duplicate === name ? 2 : 1),
  })
  const time = control('time')
  const usage = control('usage')
  const copilot = control('copilot')
  const outlet = {
    count: vi.fn(async () => duplicate === 'outlet' ? 2 : 1),
    getByRole: vi.fn((role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe('button')
      expect(options.exact).toBe(true)
      if (options.name === '1 turns 1 steps') return time
      expect(options.name).toBe('105 tok · Cache hit 90%')
      return usage
    }),
    locator: vi.fn((selector: string) => {
      expect(selector).toBe('button[data-copilot-usage-trigger]')
      return copilot
    }),
  }
  const row = { waitFor: vi.fn(async () => {}), count: vi.fn(async () => 1),
    getAttribute: vi.fn(async () => 'true'), click: vi.fn(async () => {}) }
  const stopBeforeGeometry = new Error('owned boundary: geometry not exercised')
  const api = {
    getByRole: vi.fn((role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe('button')
      expect(options.exact).toBe(true)
      if (options.name === 'Open sidebar') return { isVisible: async () => false }
      expect(options.name).toBe('Collapse sidebar')
      return row
    }),
    getByText: vi.fn(() => row),
    locator: vi.fn((selector: string) => {
      if (selector === '[data-slot="conversation.composer.dock"]') return outlet
      expect(['[role="treeitem"][aria-expanded]', '[role="treeitem"][aria-selected]']).toContain(selector)
      return { filter: () => row }
    }),
    setViewportSize: vi.fn(async () => { throw stopBeforeGeometry }),
  }
  return { page: api as unknown as Page, api, outlet, time, usage, copilot, stopBeforeGeometry }
}

describe('native composer control selection through the public outlet', () => {
  it('selects exact semantic buttons only under one public dock, without an obsolete group marker', async () => {
    const fixture = locatorFixture()
    await expect(inspectNativeComposerGeometry(fixture.page, 'unused-output')).rejects.toBe(fixture.stopBeforeGeometry)
    expect(fixture.outlet.getByRole.mock.calls).toEqual([
      ['button', { name: '1 turns 1 steps', exact: true }],
      ['button', { name: '105 tok · Cache hit 90%', exact: true }],
    ])
    expect(fixture.outlet.locator).toHaveBeenCalledExactlyOnceWith('button[data-copilot-usage-trigger]')
    expect(fixture.api.locator.mock.calls.map(([selector]) => selector)).not.toContain('[data-composer-stats]')
    for (const locator of [fixture.outlet, fixture.time, fixture.usage, fixture.copilot]) expect(locator.count).toHaveBeenCalledOnce()
  })

  it.each(['outlet', 'time', 'usage', 'copilot'] as const)('rejects duplicate %s before any geometry sampling', async (kind) => {
    const fixture = locatorFixture(kind)
    await expect(inspectNativeComposerGeometry(fixture.page, 'unused-output')).rejects.toThrow(
      kind === 'outlet' ? 'one public composer dock outlet' : 'Exactly one semantic statistics control',
    )
    expect(fixture.api.setViewportSize).not.toHaveBeenCalled()
  })
})

describe('actual native composer geometry validation', () => {
  it('requires the released entry immediately after the native Cache hit group on the same row', () => {
    expect(() => { assertNativeComposerGeometry(wide, true) }).not.toThrow()
  })

  it('accepts bounded non-overlapping wrapped rows on narrow viewports', () => {
    expect(() => { assertNativeComposerGeometry({
      ...wide, viewportWidth: 400, dock: { x: 24, y: 600, width: 352, height: 100 },
      time: { x: 100, y: 604, width: 100, height: 22 },
      usage: { x: 100, y: 638, width: 180, height: 22 },
      copilot: { x: 100, y: 672, width: 150, height: 22 },
    }, false) }).not.toThrow()
  })

  it.each([
    { name: 'old stacked placement', copilot: { ...wide.copilot, y: 638 } },
    { name: 'reversed order', copilot: { ...wide.copilot, x: 200, width: 90 } },
    { name: 'overlap', copilot: { ...wide.copilot, x: 500 } },
    { name: 'dock overflow', copilot: { ...wide.copilot, x: 950 } },
    { name: 'missing control', copilot: { ...wide.copilot, width: 0 } },
  ])('rejects $name', ({ copilot }) => {
    expect(() => { assertNativeComposerGeometry({ ...wide, copilot }, true) }).toThrow()
  })

  it.each(['fontSize', 'lineHeight', 'color'] as const)('rejects matching geometry with mismatched %s', (field) => {
    const copilotStyle = { ...wide.copilotStyle, [field]: field === 'color' ? 'rgb(0, 0, 0)' : '11px' }
    expect(() => { assertNativeComposerGeometry({ ...wide, copilotStyle }, true) }).toThrow('native statistics typography')
  })

  it('does not treat narrow wrapping as permission to overflow the viewport', () => {
    expect(() => { assertNativeComposerGeometry({ ...wide, viewportWidth: 500 }, false) }).toThrow()
  })
})
