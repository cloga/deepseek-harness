import { describe, expect, it } from 'vitest'
import { assertNativeComposerGeometry, type NativeComposerGeometry } from './fixtures/native-composer-geometry.ts'

const wide: NativeComposerGeometry = {
  viewportWidth: 1280,
  dock: { x: 200, y: 600, width: 800, height: 26 },
  time: { x: 300, y: 604, width: 100, height: 22 },
  usage: { x: 412, y: 604, width: 180, height: 22 },
  copilot: { x: 604, y: 604, width: 150, height: 22 },
  nativeStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
  copilotStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
}

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
