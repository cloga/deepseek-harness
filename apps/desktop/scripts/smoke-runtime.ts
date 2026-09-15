/** Boot the materialized target runtime without access to a user's Harness profile. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/**
 * Prove the final resource tree boots and serves its matching Web frontend.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Node executable.
 * @param runtime - Verified resource descriptor.
 */
export async function smokeDesktopRuntime(root: string, node: string, runtime: DesktopRuntimeDescriptor): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const host = new DesktopHostProcess(node, root, profile, undefined, { ...process.env, DSH_HOME: home })
  try {
    createPluginProfile(profile)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(profile, 'node_modules', pluginName)
    mkdirSync(plugin, { recursive: true })
    const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
    if (cordis === undefined) throw new Error('desktop runtime: missing shared Cordis package')
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js', './client': './client.js' },
      peerDependencies: { '@deepseek-ai/cordis': cordis.version },
      dsh: {
        bundle: { patch: './bundle.yml' },
        client: { platform: 'web' },
      },
    }))
    writeFileSync(join(plugin, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
}
`)
    writeFileSync(join(plugin, 'client.js'), `
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginName)},
  factory() {
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
          { name: 'settings.models.provider-card', key: 'neutral-auth-provider' },
          () => 'device-code authentication',
        ))
      },
    }
  },
})
`)
    writeFileSync(join(plugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-smoke-plugin\n      name: desktop-runtime-smoke-plugin\n')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[pluginName] = '1.0.0'
    manifest.dsh.profile.bundles.push(pluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    linkDesktopHostPackages(profile, root, runtime)
    validateDesktopPluginGraph(profile, root, runtime, [pluginName])
    const ready = await host.start()
    if (ready.dshVersion !== runtime.release.version) throw new Error('desktop runtime: Host reported another dsh release')
    const response = await host.fetch(new Request('dsh-app://app/'))
    const index = await response.text()
    if (response.status !== 200 || !index.includes('<html') || !index.includes(pluginName)) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const pluginUrl = [...index.matchAll(/"(\/plugins\/\?\?[^"]+)"/gu)]
      .map(match => match[1]?.replaceAll('\\u0026', '&'))
      .find(url => url?.includes(`${pluginName}/client.js`))
    if (pluginUrl === undefined) throw new Error('desktop runtime: external client plugin was not composed')
    const client = await host.fetch(new Request(`dsh-app://app${pluginUrl}`))
    const clientSource = await client.text()
    if (client.status !== 200 || !clientSource.includes('settings.models.provider-card')
      || !clientSource.includes('device-code authentication')) {
      throw new Error('desktop runtime: external provider settings client bundle was not served')
    }
  } finally {
    await host.stop()
    rmSync(home, { recursive: true, force: true })
  }
}
