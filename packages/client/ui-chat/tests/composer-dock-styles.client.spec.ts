import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stats = readFileSync(new URL('../src/client/chat/StatsPills.module.css', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../../ui-conversation/src/client/skeleton/InputBar.module.css', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('shared composer dock layout ownership', () => {
  it('keeps native pills intrinsic and wrappable without removing their root box', () => {
    const root = rule(stats, '.root')
    expect(root).toContain('display: flex;')
    expect(root).toContain('flex-wrap: wrap;')
    expect(root).toContain('min-width: 0;')
    expect(root).toContain('max-width: 100%;')
    expect(root).not.toMatch(/(?:^|\n)\s*(?:width|padding|margin):/u)
    expect(root).toContain('var(--dsh-content-font-size-secondary, 13px)')
  })

  it('owns shared spacing once and removes an empty dock from layout', () => {
    const dock = rule(composer, '.dock')
    expect(dock).toContain('display: flex;')
    expect(dock).toContain('flex-wrap: wrap;')
    expect(dock).toContain('gap: 12px;')
    expect(dock).toContain('padding: 4px calc(var(--dsh-composer-side-clearance) + 16px) 0;')
    expect(rule(composer, '.dock:empty,\n.dock:has(> [data-slot="conversation.composer.dock"]:only-child:empty)'))
      .toContain('display: none;')
    // Alpha2 owns a permanent dock for ContextMeter too; retain its official bottom clearance.
    expect(rule(composer, '.root')).toContain('padding: 0 var(--dsh-composer-side-clearance) 4px;')
    expect(rule(composer, '.hero')).toContain('padding: 0 var(--dsh-composer-side-clearance);')
  })
})
