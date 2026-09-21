import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { Locator } from 'playwright'
import { describe, expect, it } from 'vitest'
import { observeRetiredCopilotSections } from './fixtures/native-composer-geometry.ts'

function dialog(labels: readonly string[]): Locator {
  // Counter validation only; actual renderer DOM and boxes are exercised by packaged acceptance.
  return {
    getByText: (pattern: RegExp) => ({ count: async () => labels.filter(label => pattern.test(label)).length }),
  } as unknown as Locator
}

describe('packaged native composer browser observation', () => {
  it('serializes the actual DOM measurement under the declared source launcher without module helpers', () => {
    const moduleUrl = new URL('./fixtures/native-composer-dock-browser.ts', import.meta.url).href
    const source = `import { measureNativeComposerDock } from ${JSON.stringify(moduleUrl)}; process.stdout.write(measureNativeComposerDock.toString())`
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
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
