import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopManagedUpdateCoordinator,
  type DesktopManagedUpdateSelection,
} from '../src/managed-update-coordinator.ts'
import {
  MANAGED_COMMIT,
  MANAGED_SEQUENCE,
  MANAGED_TAG,
  MANAGED_VERSION,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'

function sourceFetch(manifest = managedManifest(), immutable = true) {
  const body = JSON.stringify(manifest)
  const digest = createHash('sha256').update(body).digest('hex')
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/releases?')) {
      return new Response(JSON.stringify([{
        tag_name: MANAGED_TAG,
        target_commitish: MANAGED_COMMIT,
        draft: false,
        immutable,
        assets: [{
          name: 'release.json',
          state: 'uploaded',
          digest: `sha256:${digest}`,
        }],
      }]))
    }
    if (url.includes('/git/ref/tags/')) {
      return new Response(JSON.stringify({ object: { type: 'commit', sha: MANAGED_COMMIT } }))
    }
    if (url.includes('/releases/download/')) return new Response(body)
    throw new Error(`unexpected URL ${url}`)
  })
}

describe('DesktopManagedUpdateCoordinator', () => {
  it('discovers the immutable source release and shares repeated install clicks', async () => {
    const states: unknown[] = []
    let releaseLaunch!: () => void
    const launch = vi.fn<(selection: DesktopManagedUpdateSelection) => Promise<void>>(
      () => new Promise<void>((resolve) => { releaseLaunch = resolve }),
    )
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability(),
      () => 1,
      (state) => {
        states.push(state)
        return state
      },
      launch,
      { fetch: sourceFetch() },
    )
    await expect(coordinator.check()).resolves.toMatchObject({
      phase: 'available',
      mode: 'github-release-managed',
      interactiveInstaller: true,
      version: MANAGED_VERSION,
    })
    const first = coordinator.install()
    const second = coordinator.install()
    expect(first).toBe(second)
    await vi.waitFor(() => { expect(launch).toHaveBeenCalledOnce() })
    const launched = launch.mock.calls[0]?.[0]
    expect(launched?.kind).toBe('source')
    expect(launched?.manifestSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(launched?.assetSha256).toMatch(/^[a-f0-9]{64}$/u)
    releaseLaunch()
    await expect(first).resolves.toMatchObject({ phase: 'installing' })
    expect(states).toContainEqual(expect.objectContaining({ phase: 'installing' }))
  })

  it('fails closed on a mutable source release instead of falling back to Windows Ops', async () => {
    const fetch = sourceFetch(managedManifest(), false)
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability({
        migration: {
          owner: 'cloga/dsh-windows-ops',
          manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/legacy/release.json',
          manifestSha256: '2'.repeat(64),
          assetSha256: '3'.repeat(64),
          maximumSequence: 1,
          expectedSource: { version: '0.1.5-rc.2', commit: '4'.repeat(40) },
        },
      }),
      () => 0,
      state => state,
      async () => {},
      { fetch },
    )
    const state = await coordinator.check()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('expected managed update error')
    expect(state.message).toMatch(/not immutable/u)
    expect(fetch.mock.calls.some(([input]) => (
      (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        .includes('dsh-windows-ops')
    ))).toBe(false)
  })

  it('treats the packaged release sequence as current', async () => {
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability(),
      () => MANAGED_SEQUENCE,
      state => state,
      async () => {},
      { fetch: sourceFetch() },
    )
    await expect(coordinator.check()).resolves.toEqual({
      phase: 'idle',
      mode: 'github-release-managed',
    })
  })

  it('rejects a source release whose tag commit differs from its target', async () => {
    const fetch = sourceFetch()
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify([{
      tag_name: MANAGED_TAG,
      target_commitish: MANAGED_COMMIT,
      draft: false,
      immutable: true,
      assets: [{ name: 'release.json', state: 'uploaded', digest: `sha256:${'1'.repeat(64)}` }],
    }])))
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({
      object: { type: 'commit', sha: 'f'.repeat(40) },
    })))
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability(),
      () => 1,
      state => state,
      async () => {},
      { fetch },
    )
    const state = await coordinator.check()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('expected managed update error')
    expect(state.message).toMatch(/does not resolve/u)
  })
})
