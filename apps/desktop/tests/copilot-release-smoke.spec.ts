import { expect, it, vi } from 'vitest'

const effects = vi.hoisted(() => ({
  parseArgs: vi.fn(() => { throw new Error('Import must not parse CLI arguments') }),
  launch: vi.fn(() => { throw new Error('Import must not launch Electron') }),
  inspectRuntime: vi.fn(() => { throw new Error('Import must not inspect an application') }),
}))
vi.mock('node:util', async importOriginal => ({
  ...await importOriginal<typeof import('node:util')>(), parseArgs: effects.parseArgs,
}))
vi.mock('playwright', () => ({ _electron: { launch: effects.launch } }))
vi.mock('../scripts/packaged-runtime.mjs', () => ({
  packagedDesktopRuntimeEnvironment: effects.inspectRuntime,
  packagedDesktopRuntimeRoot: effects.inspectRuntime,
  readPackagedDesktopRuntimeDescriptor: effects.inspectRuntime,
  verifyPackagedDesktopRuntime: effects.inspectRuntime,
}))

it('imports the reusable acceptance without parsing CLI arguments or starting runtime work', async () => {
  const fixture = await import('./fixtures/copilot-release-smoke.ts')
  expect(typeof fixture.runPackagedCopilotAcceptance).toBe('function')
  expect(effects.parseArgs).not.toHaveBeenCalled()
  expect(effects.launch).not.toHaveBeenCalled()
  expect(effects.inspectRuntime).not.toHaveBeenCalled()
})
