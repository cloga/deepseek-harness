/** Boot the materialized target runtime without access to a user's Harness profile. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages, unlinkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { desktopRuntimeId, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { NEUTRAL_PLUGIN, writeNeutralProviderFixture } from './neutral-provider-fixture.ts'
import { smokeDesktopRuntimeBrowser } from './smoke-runtime-browser.ts'
import { desktopSmokeEnvironment } from './smoke-environment.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

/**
 * Prove the final resource tree boots, renders an external Models card, and commits offline authorization.
 * This neutral fixture does not validate a real provider package or authentication service.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Node executable.
 * @param runtime - Verified resource descriptor.
 * @param browserChannel - Explicit installed Chromium channel; omission requires Playwright's bundled Chromium.
 * @param evidenceDirectory - Optional destination for successful neutral-fixture screenshots and run evidence.
 * @param runtimeKind - Workspace-linked fixtures enable the Host's existing development allowance with an OS-assigned inspector port.
 */
export async function smokeDesktopRuntime(
  root: string,
  node: string,
  runtime: DesktopRuntimeDescriptor,
  browserChannel?: string,
  evidenceDirectory?: string,
  runtimeKind: 'materialized' | 'workspace-linked' = 'materialized',
): Promise<void> {
  const scratch = resolve('.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'runtime-'))
  const profile = join(home, 'profiles', 'desktop')
  const host = new DesktopHostProcess(
    node, root, profile, runtimeKind === 'workspace-linked' ? 0 : undefined, desktopSmokeEnvironment(home),
  )
  let acceptanceError: unknown
  try {
    createPluginProfile(profile)
    writeFileSync(join(home, '.env'), '')
    writeFileSync(join(profile, '.env'), '')
    const receipt = writeNeutralProviderFixture(profile, runtime)
    writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), [
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: llm-pi-ai',
      '  disabled: true',
      '- id: session-telemetry-otel',
      '  disabled: true',
      '',
    ].join('\n'))
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[NEUTRAL_PLUGIN] = '1.0.0'
    manifest.dsh.profile.bundles.push(NEUTRAL_PLUGIN)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    linkDesktopHostPackages(profile, root, runtime)
    validateDesktopPluginGraph(profile, root, runtime, [NEUTRAL_PLUGIN])
    console.log('desktop smoke: starting isolated Host')
    let readyTimeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      readyTimeout = setTimeout(() => { reject(new Error('desktop smoke: Host readiness exceeded 120 seconds')) }, 120_000)
      readyTimeout.unref()
    })
    const ready = await Promise.race([host.start(), deadline]).finally(() => { clearTimeout(readyTimeout) })
    console.log('desktop smoke: Host ready')
    if (ready.dshVersion !== runtime.release.version) throw new Error('desktop runtime: Host reported another dsh release')
    const response = await host.fetch(new Request('dsh-app://app/'))
    const index = await response.text()
    if (response.status !== 200 || !index.includes('<html') || !index.includes(NEUTRAL_PLUGIN)) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const pluginUrl = [...index.matchAll(/"(\/plugins\/\?\?[^"]+)"/gu)]
      .map(match => match[1]?.replaceAll('\\u0026', '&').replaceAll('&amp;', '&'))
      .find(url => url?.includes(`${NEUTRAL_PLUGIN}/client.js`))
    if (pluginUrl === undefined) throw new Error('desktop runtime: external client plugin was not composed')
    const client = await host.fetch(new Request(`dsh-app://app${pluginUrl}`))
    const clientSource = await client.text()
    console.log('desktop smoke: client assets received')
    if (client.status !== 200 || !clientSource.includes('settings.models.provider-card')
      || !clientSource.includes('Authorize neutral fixture')) {
      throw new Error('desktop runtime: external provider settings client bundle was not served '
        + `(HTTP ${String(client.status)}, ${pluginUrl}): ${clientSource.slice(0, 400)}`)
    }
    const captures = evidenceDirectory === undefined ? undefined : join(home, 'evidence')
    await smokeDesktopRuntimeBrowser(host, home, receipt, browserChannel, captures)
    const evidence: unknown = JSON.parse(readFileSync(join(home, 'neutral-auth-result.json'), 'utf8'))
    if (typeof evidence !== 'object' || evidence === null
      || !('receipt' in evidence) || evidence.receipt !== receipt
      || !('sharedCordis' in evidence) || evidence.sharedCordis !== true
      || !('attempts' in evidence) || evidence.attempts !== 1
      || !('status' in evidence) || evidence.status !== 'authorized') {
      throw new Error('desktop smoke: browser action did not commit exactly one neutral Host authorization')
    }
    if (evidenceDirectory !== undefined && captures !== undefined) {
      writeFileSync(join(captures, 'neutral-fixture-evidence.json'), JSON.stringify({
        fixture: 'desktop-neutral-provider',
        runtimeVersion: runtime.release.version,
        runtimeId: desktopRuntimeId(runtime),
        runtimeKind,
        artifactIntegrityVerified: runtimeKind === 'materialized',
        browserChannel: browserChannel ?? 'playwright-chromium',
        transport: 'isolated loopback test carrier to Desktop Host byte pipes',
        realAuthenticationService: false,
        realModelRound: false,
        installedReleaseAcceptance: false,
        evidence,
      }, undefined, 2) + '\n')
      cpSync(captures, resolve(evidenceDirectory), { recursive: true, errorOnExist: true, force: false })
    }
  } catch (error) {
    acceptanceError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      await host.stop()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      unlinkDesktopHostPackages(profile)
      removeOwnedDirectory(home)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([
        ...(acceptanceError === undefined ? [] : [acceptanceError]), ...cleanupErrors,
      ], 'desktop smoke: isolated resource cleanup failed')
    }
  }
}
