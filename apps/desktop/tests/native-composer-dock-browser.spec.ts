// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Locator } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureNativeComposerDock } from './fixtures/native-composer-dock-browser.ts'
import { observeRetiredCopilotSections } from './fixtures/native-composer-geometry.ts'

function dialog(labels: readonly string[]): Locator {
  // Counter validation only; actual renderer DOM and boxes are exercised by packaged acceptance.
  return {
    getByText: (pattern: RegExp) => ({ count: async () => labels.filter(label => pattern.test(label)).length }),
  } as unknown as Locator
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

/** Scalar DOM contract cases only; the real StatsPills/Slot test independently checks production markup. */
function dockFixture() {
  document.body.innerHTML = `<div id="physical" style="display:flex;visibility:visible">
    <span style="display:contents"><span data-slot="conversation.composer.dock" style="display:contents">
      <button id="unrelated" aria-haspopup="dialog" aria-label="Context occupancy">Context</button>
      <section><span><button id="time" aria-haspopup="dialog" aria-label="1 turns 1 steps">Counts</button></span>
      <span><button id="usage" aria-haspopup="dialog" aria-label="105 tok · Cache hit 90%">Tokens</button></span></section>
      <button id="copilot" data-copilot-usage-trigger>Copilot credits</button>
    </span></span></div>`
  const owner = document.querySelector<HTMLElement>('#physical')!
  const anchor = document.querySelector<HTMLElement>('[data-slot]')!
  const time = document.querySelector<HTMLButtonElement>('#time')!
  const usage = document.querySelector<HTMLButtonElement>('#usage')!
  const copilot = document.querySelector<HTMLButtonElement>('#copilot')!
  const boxes = [
    { x: 0, y: 0, width: 1000, height: 40 }, { x: 10, y: 4, width: 100, height: 22 },
    { x: 122, y: 4, width: 180, height: 22 }, { x: 314, y: 4, width: 140, height: 22 },
  ]
  for (const [index, element] of [owner, time, usage, copilot].entries()) {
    element.style.visibility = 'visible'; element.style.fontSize = '13px'; element.style.lineHeight = '20px'; element.style.color = 'rgb(100, 100, 100)'
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(boxes[index]!.x, boxes[index]!.y, boxes[index]!.width, boxes[index]!.height))
  }
  return { owner, anchor, time, usage, copilot }
}

describe('exact marker-free native button measurement', () => {
  it('measures the full path without the obsolete marker or positional assumptions and ignores an unrelated button', () => {
    const f = dockFixture()
    expect(f.anchor.querySelector('[data-composer-stats]')).toBeNull()
    expect(measureNativeComposerDock(f.anchor)).toMatchObject({
      time: { x: 10, width: 100 }, usage: { x: 122, width: 180 }, copilot: { x: 314, width: 140 },
    })
  })
  it.each(['time', 'usage', 'copilot'] as const)('does not accept missing %s control', (name) => {
    const f = dockFixture(); f[name].remove()
    expect(measureNativeComposerDock(f.anchor)).toBeNull()
  })
  it.each(['time', 'usage', 'copilot'] as const)('rejects duplicate %s instead of choosing first/nth', (name) => {
    const f = dockFixture(); f.anchor.append(f[name].cloneNode(true))
    expect(() => measureNativeComposerDock(f.anchor)).toThrow('ambiguous')
  })
  it.each(['hidden-owner', 'hidden-control', 'zero-box'] as const)('retains bounded unlaid readiness for %s', (damage) => {
    const f = dockFixture()
    if (damage === 'hidden-owner') f.owner.style.display = 'none'
    else if (damage === 'hidden-control') f.time.style.visibility = 'hidden'
    else vi.mocked(f.time.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 0, 0))
    expect(measureNativeComposerDock(f.anchor)).toBeNull()
  })
  it.each(['non-flex', 'too-many-ancestors', 'body-owner'] as const)('rejects structural %s instead of guessing a physical box', (damage) => {
    const f = dockFixture()
    if (damage === 'non-flex') f.owner.style.display = 'block'
    else if (damage === 'body-owner') document.body.append(f.anchor)
    else for (let index = 0; index < 4; index++) {
      const wrapper = document.createElement('span'); wrapper.style.display = 'contents'
      f.anchor.replaceWith(wrapper); wrapper.append(f.anchor)
    }
    expect(() => measureNativeComposerDock(f.anchor)).toThrow()
  })
  it.each(['wrong-label', 'text-only', 'wrong-popup', 'role-override', 'labelledby', 'shared-trigger', 'second-outlet'] as const)(
    'refuses misleading %s contract', (damage) => {
      const f = dockFixture()
      if (damage === 'wrong-label') f.time.setAttribute('aria-label', '1 turns 1 steps extra')
      else if (damage === 'text-only') f.time.outerHTML = '<span aria-label="1 turns 1 steps" aria-haspopup="dialog">1 turns 1 steps</span>'
      else if (damage === 'wrong-popup') f.time.setAttribute('aria-haspopup', 'menu')
      else if (damage === 'role-override') f.time.setAttribute('role', 'presentation')
      else if (damage === 'labelledby') f.time.setAttribute('aria-labelledby', 'unrelated')
      else if (damage === 'shared-trigger') { f.copilot.remove(); f.time.setAttribute('data-copilot-usage-trigger', '') }
      else document.body.append(f.anchor.cloneNode(false))
      if (['wrong-label', 'text-only', 'wrong-popup'].includes(damage)) expect(measureNativeComposerDock(f.anchor)).toBeNull()
      else expect(() => measureNativeComposerDock(f.anchor)).toThrow()
    },
  )
})

describe('packaged native composer browser observation', () => {
  it('serializes the actual DOM measurement under the declared source launcher without module helpers', () => {
    const moduleUrl = pathToFileURL(resolve('apps/desktop/tests/fixtures/native-composer-dock-browser.ts')).href
    const source = `import { measureNativeComposerDock } from ${JSON.stringify(moduleUrl)}; process.stdout.write(measureNativeComposerDock.toString())`
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 10_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('__name')
    const standalone = runInNewContext(`(${result.stdout})`) as (anchor: { getAttribute(name: string): string }) => unknown
    expect(() => standalone({ getAttribute: () => 'wrong-slot' })).toThrow('public display:contents composer dock outlet')
    const f = dockFixture()
    const full = runInNewContext(`(${result.stdout})`, { document, window, getComputedStyle: getComputedStyle.bind(window) }) as typeof measureNativeComposerDock
    expect(full(f.anchor)).toEqual(measureNativeComposerDock(f.anchor))
    expect(full(f.anchor)?.time.x).toBe(10)
    expect(full(f.anchor)?.usage.x).toBe(122)
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
