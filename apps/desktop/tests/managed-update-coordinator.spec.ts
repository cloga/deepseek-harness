import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { zh } from '../src/locale.ts'
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
  it.each([
    ['/releases?', '读取发布列表', 1],
    ['/git/ref/tags/', '校验发布标签', 2],
    ['/releases/download/', '下载更新清单', 3],
  ] as const)('localizes network failure at %s without changing requests or retrying', async (failedPath, stage, calls) => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, _init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.includes(failedPath)) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private signed URL'), { code: 'ECONNRESET' }) })
      return normal(input)
    })
    const launch = vi.fn(async () => {})
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, state => state, launch, { fetch }, zh)
    await expect(coordinator.check()).resolves.toEqual({
      phase: 'error', mode: 'github-release-managed',
      message: `${stage}时连接被重置（ECONNRESET）。\n请检查网络连接后重试。`,
    })
    expect(fetch).toHaveBeenCalledTimes(calls)
    const urls = fetch.mock.calls.map(([input]) => input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
    expect(urls).toEqual([
      'https://api.github.com/repos/cloga/deepseek-harness/releases?per_page=100',
      `https://api.github.com/repos/cloga/deepseek-harness/git/ref/tags/${MANAGED_TAG}`,
      `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/release.json`,
    ].slice(0, calls))
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      accept: 'application/vnd.github+json', 'user-agent': 'deepseek-harness-desktop', 'x-github-api-version': '2026-03-10',
    })
    expect(launch).not.toHaveBeenCalled()
    await expect(coordinator.install()).rejects.toThrow('no verified update is available')
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('describes a body-stream reset as a manifest download failure', async () => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (!url.includes('/releases/download/')) return normal(input)
      return new Response(new ReadableStream({ start(controller) {
        controller.error(Object.assign(new Error('private stream details'), { code: 'ECONNRESET' }))
      } }))
    })
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, state => state, async () => {}, { fetch }, zh)
    const state = await coordinator.check()
    expect(state).toMatchObject({ phase: 'error', message: '下载更新清单时连接被重置（ECONNRESET）。\n请检查网络连接后重试。' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retains the integrity error instead of reporting a network problem', async () => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      return url.includes('/releases/download/') ? new Response('{}') : normal(input)
    })
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, state => state, async () => {}, { fetch }, zh)
    const state = await coordinator.check()
    expect(state).toMatchObject({ phase: 'error', message: 'desktop managed update: manifest asset digest does not match GitHub' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

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
          expectedSource: { version: '0.1.5-rc.2', tag: 'dsh-v0.1.5-rc.2' },
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
