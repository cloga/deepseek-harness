import { managedUpdateJsonSha256 } from '../src/managed-update-protocol.ts'
import { DesktopManagedUpdateCoordinator } from '../src/managed-update-coordinator.ts'
import { describe, expect, it, vi } from 'vitest'

function release() {
  const payload = {
    schemaVersion: 2,
    owner: 'cloga/deepseek-harness',
    mode: 'interactive-windows-installer',
    version: '1.2.3',
    sequence: 2,
    source: { repository: 'cloga/deepseek-harness', commit: 'a'.repeat(40), tag: 'dsh-v1.2.3' },
    installer: {
      file: 'installer.exe',
      bytes: 1,
      sha256: 'b'.repeat(64),
      sha512: 'YQ'.padEnd(86, 'A') + '==',
      signature: 'NotSigned',
    },
    buildReceipt: { file: 'build-receipt.json', sha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64) },
    installedEvidence: { executableSha256: 'e'.repeat(64), runtimeSha256: 'f'.repeat(64) },
    pluginProvisioning: {
      capability: 'verified-github-release',
      source: {
        schemaVersion: 1,
        type: 'githubRelease',
        owner: 'cloga',
        repo: 'dsh-github-copilot',
        tag: 'v0.4.0-alpha.18',
        asset: 'dsh-github-copilot-0.4.0-alpha.18.tgz',
        packageName: 'dsh-github-copilot',
        version: '0.4.0-alpha.18',
        size: 1,
        sha256: '2'.repeat(64),
        integrity: `sha512-${'A'.repeat(86)}==`,
        targetCommit: '3'.repeat(40),
      },
      receiptSha256: '1'.repeat(64),
    },
  }
  return { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
}

describe('DesktopManagedUpdateCoordinator', () => {
  it('publishes a managed interactive release and shares repeated install clicks', async () => {
    const manifest = release()
    const states: unknown[] = []
    let releaseLaunch!: () => void
    const launch = vi.fn(() => new Promise<void>((resolve) => { releaseLaunch = resolve }))
    const coordinator = new DesktopManagedUpdateCoordinator({
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: manifest.manifestSha256,
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'a'.repeat(40) },
    }, () => 1, (state) => {
      states.push(state)
      return state
    }, launch, {
      fetch: vi.fn(async () => new Response(JSON.stringify(manifest))),
    })
    await expect(coordinator.check()).resolves.toMatchObject({
      phase: 'available',
      mode: 'windows-ops-managed',
      interactiveInstaller: true,
    })
    const first = coordinator.install()
    const second = coordinator.install()
    expect(first).toBe(second)
    await vi.waitFor(() =>{  expect(launch).toHaveBeenCalledOnce() })
    releaseLaunch()
    await expect(first).resolves.toMatchObject({ phase: 'installing' })
    expect(states).toContainEqual(expect.objectContaining({ phase: 'installing' }))
  })

  it('does not fall back to migration after a non-404 source failure', async () => {
    const manifest = release()
    const fetch = vi.fn(async () => new Response('unavailable', { status: 500 }))
    const coordinator = new DesktopManagedUpdateCoordinator({
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: manifest.manifestSha256,
      minimumSequence: 1,
      expectedSource: { version: '1.2.3', commit: 'a'.repeat(40) },
      migration: {
        owner: 'cloga/dsh-windows-ops',
        manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/legacy/release.json',
        manifestSha256: '2'.repeat(64),
        maximumSequence: 1,
        expectedSource: { version: '0.1.5-rc.2', commit: '3'.repeat(40) },
      },
    }, () => 0, state => state, async () => {}, { fetch })
    const state = await coordinator.check()
    expect(state.phase).toBe('error')
    expect(state.message).toMatch(/500/u)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('treats the completed managed sequence as current', async () => {
    const manifest = release()
    let installedSequence = 1
    const coordinator = new DesktopManagedUpdateCoordinator({
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: manifest.manifestSha256,
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'a'.repeat(40) },
    }, () => installedSequence, state => state, async () => {}, {
      fetch: vi.fn(async () => new Response(JSON.stringify(manifest))),
    })
    await expect(coordinator.check()).resolves.toMatchObject({ phase: 'available' })
    installedSequence = 2
    await expect(coordinator.check()).resolves.toEqual({
      phase: 'idle',
      mode: 'windows-ops-managed',
    })
  })
})
