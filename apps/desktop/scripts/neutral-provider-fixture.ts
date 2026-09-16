/** Materialize an offline external plugin inside a smoke-owned Desktop profile. */
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/** Package identifier shared by the neutral Host and lazy-CJS client fixtures. */
export const NEUTRAL_PLUGIN = 'desktop-runtime-smoke-plugin'

/**
 * Install the fixture without a package manager or access to another profile.
 * @param profile - Newly created, smoke-owned profile directory.
 * @param runtime - Packages shared by the immutable runtime.
 * @returns Unique receipt that only this fixture's Host action commits.
 */
export function writeNeutralProviderFixture(profile: string, runtime: DesktopRuntimeDescriptor): string {
  const receipt = randomUUID()
  const plugin = join(profile, 'node_modules', NEUTRAL_PLUGIN)
  mkdirSync(plugin, { recursive: true })
  const peerDependencies = Object.fromEntries([
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-credentials',
  ].map((name) => {
    const shared = runtime.sharedPackages.find(entry => entry.name === name)
    if (shared === undefined) throw new Error(`desktop runtime: missing shared fixture dependency ${name}`)
    return [name, shared.version]
  }))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: NEUTRAL_PLUGIN,
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.mjs', './client': './client.js' },
    peerDependencies,
    dsh: {
      bundle: { patch: './bundle.yml' },
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-client-ui-settings-models'],
        external: ['react'],
      },
    },
  }))
  const fixtures = fileURLToPath(new URL('../tests/fixtures/neutral-provider/', import.meta.url))
  copyFileSync(join(fixtures, 'client.js'), join(plugin, 'client.js'))
  writeFileSync(join(plugin, 'index.mjs'), transpileModule(readFileSync(join(fixtures, 'index.ts'), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText)
  writeFileSync(join(plugin, 'bundle.yml'), [
    '- insert:',
    `    - id: ${NEUTRAL_PLUGIN}`,
    `      name: ${NEUTRAL_PLUGIN}`,
    '      config:',
    `        receipt: ${JSON.stringify(receipt)}`,
    '',
  ].join('\n'))
  return receipt
}
