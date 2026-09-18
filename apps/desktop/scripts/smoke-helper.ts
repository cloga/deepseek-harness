/** Copied-byte helper bootstrap and synthetic ACK acceptance, without an installer or live handoff. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { launchDesktopManagedUpdate } from '../src/managed-update-launcher.ts'
import { parseDesktopManagedUpdateCapability, managedUpdateJsonSha256 } from '../src/managed-update-protocol.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY } from '../src/plugin-source.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { desktopSmokeEnvironment } from './smoke-environment.ts'
import { assertStandaloneDesktopHelper } from './helper-standalone.ts'

/**
 * Validate the packaged helper's isolated startup and ACK with a synthetic manifest transport.
 * @param node - Packaged upstream Node executable.
 * @param helper - Exact packaged helper bytes copied by the application.
 * @param capabilityPath - Packaged capability used by the actual parser.
 * @param output - Evidence directory; never a user profile.
 * @returns Nothing; any bootstrap, parse, ACK, or cancellation failure rejects the release.
 */
export async function smokeDesktopManagedHelper(
  node: string, helper: string, capabilityPath: string, output: string,
): Promise<void> {
  const bytes = readFileSync(helper)
  assertStandaloneDesktopHelper(bytes.toString('utf8'))
  const capability = parseDesktopManagedUpdateCapability(JSON.parse(readFileSync(capabilityPath, 'utf8')))
  const root = mkdtempSync(join(tmpdir(), 'dsh-helper-acceptance-'))
  let acknowledgement: Awaited<ReturnType<typeof launchDesktopManagedUpdate>> | undefined
  try {
    const isolatedNode = join(root, 'node.exe')
    const isolatedHelper = join(root, 'helper.mjs')
    copyFileSync(node, isolatedNode)
    copyFileSync(helper, isolatedHelper)
    assert.deepEqual(readFileSync(isolatedHelper), bytes)
    const environment = desktopSmokeEnvironment(root)
    const bootstrap = spawnSync(isolatedNode, [isolatedHelper], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 15_000,
    })
    if (bootstrap.error !== undefined) throw bootstrap.error
    assert.equal(bootstrap.signal, null)
    assert.equal(bootstrap.status, 1)
    assert.match(bootstrap.stderr, /helper expects one absolute handoff.json path/u)
    assert.doesNotMatch(bootstrap.stderr, /ERR_MODULE_NOT_FOUND/u)

    const version = '9999.0.0-helper-fixture'
    const payload = {
      schemaVersion: 3, owner: capability.owner, mode: 'interactive-windows-installer',
      channel: 'cloga-windows-x64', version, upstreamVersion: '0.1.5-rc.2',
      sequence: capability.currentSequence + 1,
      source: { repository: capability.owner, commit: 'a'.repeat(40), tree: 'b'.repeat(40), tag: `${capability.tagPrefix}${version}` },
      build: {
        workflow: '.github/workflows/desktop-fork-release.yml', lockfileSha256: 'c'.repeat(64),
        planSha256: 'd'.repeat(64), nodeVersion: 'v24.13.0', pnpmVersion: '11.7.0', packageRegistry: 'https://registry.npmjs.org/',
      },
      identity: {
        appId: 'io.github.cloga.deepseek-harness.desktop', productName: 'DeepSeek Harness (cloga)',
        packageName: 'cloga-deepseek-harness-desktop', executableName: 'cloga-deepseek-harness',
      },
      installer: { file: 'never-run.exe', bytes: 1, sha256: 'e'.repeat(64), sha512: `${'A'.repeat(86)}==`, signature: 'NotSigned' },
      buildReceipt: { file: 'build-receipt.json', sha256: 'f'.repeat(64), receiptSha256: 'a'.repeat(64) },
      installedEvidence: { executableSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64) },
      pluginCompatibility: { capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, automaticProvisioning: false },
      network: {
        manifestOrigin: 'https://github.com', apiOrigin: 'https://api.github.com',
        allowedRedirectHosts: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
      },
      installation: { interaction: 'required', installerArguments: [], uac: 'installer-controlled', completion: 'post-restart-installed-evidence' },
    }
    const manifest = { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
    const body = JSON.stringify(manifest)
    const url = `https://github.com/${capability.owner}/releases/download/${capability.tagPrefix}${version}/release.json`
    const transport = join(root, 'fixture-network.mjs')
    writeFileSync(transport, `globalThis.fetch = async url => {
      if (String(url) !== ${JSON.stringify(url)}) throw new Error('Helper smoke forbids receipt or installer acquisition');
      return new Response(${JSON.stringify(body)});
    };\n`)
    acknowledgement = await launchDesktopManagedUpdate({
      operationsRoot: join(root, 'operations'), nodeExecutable: isolatedNode, helperBundle: isolatedHelper,
      nodeSha256: createHash('sha256').update(readFileSync(isolatedNode)).digest('hex'),
      capability, selection: {
        kind: 'source', manifestUrl: url, manifestSha256: manifest.manifestSha256,
        assetSha256: createHash('sha256').update(body).digest('hex'),
      },
      installedSequence: capability.currentSequence, waitPids: [process.pid],
    }, {
      platform: 'win32', now: () => Date.now(),
      sleep: milliseconds => new Promise(accept => setTimeout(accept, milliseconds)),
      spawn(command, args, options) {
        return spawn(command, ['--import', pathToFileURL(transport).href, ...args], {
          ...options, env: environment,
        })
      },
      waitForExit(child, timeout) {
        if (child.exitCode !== null) return Promise.resolve(true)
        return new Promise((accept) => {
          const timer = setTimeout(() => { child.removeListener('exit', exited); accept(false) }, timeout)
          function exited() { clearTimeout(timer); accept(true) }
          child.once('exit', exited)
        })
      },
    })
    const ack = JSON.parse(readFileSync(join(acknowledgement.operationRoot, 'ack.json'), 'utf8')) as { manifestSha256: string }
    assert.equal(ack.manifestSha256, manifest.manifestSha256)
    await acknowledgement.abandon()
    assert.equal(existsSync(join(acknowledgement.operationRoot, 'stage')), false)
    assert.equal(existsSync(join(acknowledgement.operationRoot, 'cancelled.json')), true)
    acknowledgement = undefined
    assert.deepEqual(readFileSync(helper), bytes)
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'helper-acceptance.json'), JSON.stringify({
      helperSha256: createHash('sha256').update(bytes).digest('hex'),
      isolatedBootstrap: 'passed', validSyntheticHandoffAcknowledged: true,
      cancellationCompleted: true, nodePath: null, nodeOptions: null,
      manifestTransport: 'synthetic fetch only; receipt and installer requests forbidden',
      liveHandoff: false, installerStarted: false,
    }, undefined, 2) + '\n')
  } finally {
    await acknowledgement?.abandon()
    removeOwnedDirectory(root)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    node: { type: 'string' }, helper: { type: 'string' }, capability: { type: 'string' }, output: { type: 'string' },
  } })
  assert(values.node && values.helper && values.capability && values.output, 'Packaged paths and evidence output are required')
  await smokeDesktopManagedHelper(resolve(values.node), resolve(values.helper), resolve(values.capability), resolve(values.output))
}
