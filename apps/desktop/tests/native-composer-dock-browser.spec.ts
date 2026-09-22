// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { Locator } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeRetiredCopilotSections } from './fixtures/native-composer-geometry.ts'
import { measureNativeComposerDock } from './fixtures/native-composer-dock-browser.ts'

const ownedRoots: HTMLElement[] = []
afterEach(() => {
  for (const root of ownedRoots.splice(0)) root.remove()
  vi.restoreAllMocks()
})

/** Actual DOM selectors with inert rectangle observations; not a rendered StatsPills or native-window proof. */
function dockFixture(neutralAncestors = 0) {
  const owner = document.createElement('div')
  owner.style.display = 'flex'
  const anchor = document.createElement('div')
  anchor.dataset.slot = 'conversation.composer.dock'
  anchor.style.display = 'contents'
  ownedRoots.push(owner, anchor)
  document.body.append(owner)
  let parent = owner
  for (let index = 0; index < neutralAncestors; index++) {
    const neutral = document.createElement('div')
    neutral.style.display = 'contents'
    parent.append(neutral)
    parent = neutral
  }
  parent.append(anchor)
  const group = document.createElement('div')
  anchor.append(group)
  const button = (label: string, x: number, width: number) => {
    const element = document.createElement('button')
    element.setAttribute('aria-label', label)
    element.textContent = 'Visible content is not the selector'
    element.style.cssText = 'visibility:visible;font-size:13px;line-height:20px;color:rgb(100, 100, 100)'
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, 604, width, 22))
    return element
  }
  const time = button('1 turns 1 steps', 300, 100)
  const usage = button('105 tok · Cache hit 90%', 412, 180)
  const copilot = button('Copilot account usage', 604, 150)
  copilot.dataset.copilotUsageTrigger = ''
  group.append(time, usage)
  anchor.append(copilot)
  vi.spyOn(owner, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 600, 800, 26))
  return { owner, anchor, group, time, usage, copilot }
}

function dialog(labels: readonly string[]): Locator {
  // Counter validation only; actual renderer DOM and boxes are exercised by packaged acceptance.
  return {
    getByText: (pattern: RegExp) => ({ count: async () => labels.filter(label => pattern.test(label)).length }),
  } as unknown as Locator
}

describe('public semantic dock measurement with actual DOM queries', () => {
  it.each([0, 1, 4])('measures marker-free semantic buttons through %s layout-neutral ancestors', (wrappers) => {
    const fixture = dockFixture(wrappers)
    expect(fixture.anchor.querySelector('[data-composer-stats]')).toBeNull()
    const observed = measureNativeComposerDock(fixture.anchor)
    expect(observed).toEqual({
      viewportWidth: window.innerWidth,
      dock: { x: 200, y: 600, width: 800, height: 26 },
      time: { x: 300, y: 604, width: 100, height: 22 },
      usage: { x: 412, y: 604, width: 180, height: 22 },
      copilot: { x: 604, y: 604, width: 150, height: 22 },
      nativeStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
      copilotStyle: { fontSize: '13px', lineHeight: '20px', color: 'rgb(100, 100, 100)' },
    })
  })

  it.each(['time', 'usage', 'copilot'] as const)('rejects duplicate semantic %s buttons', (kind) => {
    const fixture = dockFixture()
    fixture.anchor.append(fixture[kind].cloneNode(true))
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow('ambiguous')
  })

  it.each(['time', 'usage', 'copilot'] as const)('does not adopt a %s button outside the public outlet', (kind) => {
    const fixture = dockFixture()
    fixture.owner.append(fixture[kind])
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it.each(['time', 'usage'] as const)('requires the exact %s accessible label instead of text or a prefix', (kind) => {
    const fixture = dockFixture()
    const control = fixture[kind]
    control.textContent = control.getAttribute('aria-label')
    control.setAttribute('aria-label', `${control.getAttribute('aria-label')} extra`)
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
    control.removeAttribute('aria-label')
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it.each(['time', 'usage', 'copilot'] as const)('does not measure a text span masquerading as %s', (kind) => {
    const fixture = dockFixture()
    const span = document.createElement('span')
    for (const attribute of fixture[kind].attributes) span.setAttribute(attribute.name, attribute.value)
    span.textContent = fixture[kind].getAttribute('aria-label')
    fixture[kind].replaceWith(span)
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it('ignores obsolete markers and unrelated buttons rather than counting a synthetic stats group', () => {
    const fixture = dockFixture()
    fixture.group.dataset.composerStats = ''
    const other = document.createElement('button')
    other.textContent = 'Other public dock action'
    fixture.group.append(other)
    expect(measureNativeComposerDock(fixture.anchor)?.time.width).toBe(100)
    fixture.time.remove()
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it.each(['time', 'usage', 'copilot'] as const)('waits for visible %s geometry without accepting hidden controls', (kind) => {
    const fixture = dockFixture()
    fixture[kind].style.visibility = 'hidden'
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it.each(['owner', 'time', 'usage', 'copilot'] as const)('waits for a nonzero %s rectangle', (kind) => {
    const fixture = dockFixture()
    const rectangle = vi.spyOn(fixture[kind], 'getBoundingClientRect')
    rectangle.mockReturnValue(new DOMRect(200, 600, 0, 22))
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
    rectangle.mockReturnValue(new DOMRect(200, 600, 100, 0))
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
  })

  it('rejects the wrong outlet or a layout-owning outlet', () => {
    const fixture = dockFixture()
    fixture.anchor.dataset.slot = 'different.slot'
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow('public display:contents')
    fixture.anchor.dataset.slot = 'conversation.composer.dock'
    fixture.anchor.style.display = 'flex'
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow('public display:contents')
  })

  it.each(['missing', 'body', 'document', 'too-many'] as const)('rejects an unbounded %s physical owner', (kind) => {
    const fixture = dockFixture(kind === 'too-many' ? 5 : 0)
    if (kind === 'missing') fixture.anchor.remove()
    else if (kind === 'body') document.body.append(fixture.anchor)
    else if (kind === 'document') document.documentElement.append(fixture.anchor)
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow(kind === 'too-many' ? 'too many' : 'bounded physical owner')
  })

  it('rejects a contradictory physical-owner containment observation', () => {
    const fixture = dockFixture()
    vi.spyOn(fixture.owner, 'contains').mockReturnValue(false)
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow('contain every actual statistics control')
  })

  it('distinguishes an unlaid physical owner from an invalid non-flex owner', () => {
    const fixture = dockFixture()
    fixture.owner.style.display = 'none'
    expect(measureNativeComposerDock(fixture.anchor)).toBeNull()
    fixture.owner.style.display = 'block'
    expect(() => measureNativeComposerDock(fixture.anchor)).toThrow('shared flex layout')
    fixture.owner.style.display = 'inline-flex'
    expect(measureNativeComposerDock(fixture.anchor)?.dock.width).toBe(800)
  })
})

describe('packaged native composer browser observation', () => {
  it('serializes the actual DOM measurement under the declared source launcher without module helpers', () => {
    const moduleUrl = new NodeURL('./fixtures/native-composer-dock-browser.ts', import.meta.url).href
    const source = `import { measureNativeComposerDock } from ${JSON.stringify(moduleUrl)}; process.stdout.write(measureNativeComposerDock.toString())`
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
      cwd: fileURLToPath(new NodeURL('../../../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('__name')
    const standalone = runInNewContext(`(${result.stdout})`) as (anchor: { getAttribute(name: string): string }) => unknown
    expect(() => standalone({ getAttribute: () => 'wrong-slot' })).toThrow('public display:contents composer dock outlet')
  })

  it('records actual zero counts without a retired placeholder or unavailable reset', async () => {
    await expect(observeRetiredCopilotSections(dialog(['Copilot usage', 'Account-wide · across Copilot apps'])))
      .resolves.toEqual({ sessionCreditsCount: 0, resetCount: 0, epochTextCount: 0 })
  })

  it.each(['This session', '本会话', 'Session credits', '会话额度'])('rejects the retired %s placeholder caption', async (label) => {
    await expect(observeRetiredCopilotSections(dialog([label, 'Not available']))).rejects.toThrow('Session credits section')
  })

  it.each(['Resets: Not available', '重置时间: 暂不可用', 'Jan 1, 1970'])('rejects unavailable or epoch reset text: %s', async (label) => {
    await expect(observeRetiredCopilotSections(dialog([label]))).rejects.toThrow()
  })
})
