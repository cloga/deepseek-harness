import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { en, zh } from '../src/locale.ts'
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

function sourceFetch(manifest: unknown = managedManifest(), immutable = true) {
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

function fixture(fetch = sourceFetch()) {
  const states: DesktopUpdateState[] = []
  const launch = vi.fn(async (_selection: DesktopManagedUpdateSelection) => true)
  const installedSequence = vi.fn(() => 1)
  const coordinator = new DesktopManagedUpdateCoordinator(
    managedCapability(), installedSequence,
    (state) => { states.push(state); return state },
    launch, { fetch },
  )
  return { coordinator, states, launch, installedSequence, fetch }
}

describe('DesktopManagedUpdateCoordinator', () => {
  it('pins selection without acquiring installer bytes or launching a helper during download', async () => {
    const f = fixture()
    expect(f.coordinator.state).toEqual({ phase: 'idle', mode: 'github-release-managed' })
    await f.coordinator.check()
    const requests = f.fetch.mock.calls.length
    await expect(f.coordinator.install(MANAGED_VERSION)).rejects.toThrow(/not ready/u)
    await expect(f.coordinator.download('9.9.9')).rejects.toThrow(/stale/u)
    await expect(f.coordinator.download(MANAGED_VERSION)).resolves.toMatchObject({ phase: 'ready', version: MANAGED_VERSION })
    expect(f.fetch).toHaveBeenCalledTimes(requests)
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.states.map(state => state.phase)).toEqual(['available', 'ready'])
    await f.coordinator.check(true)
    expect(f.fetch).toHaveBeenCalledTimes(requests)
    await expect(f.coordinator.download('9.9.9')).rejects.toThrow(/stale/u)
    await expect(f.coordinator.install('9.9.9')).rejects.toThrow(/not ready/u)
  })

  it('joins a pending check without allowing confirmation to retarget its immutable selection', async () => {
    const f = fixture()
    const response = Promise.withResolvers<Response>()
    const source = sourceFetch()
    f.fetch.mockImplementationOnce(() => response.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const downloading = f.coordinator.download(MANAGED_VERSION)
    const repeated = f.coordinator.download(MANAGED_VERSION)
    const stale = f.coordinator.download('9.9.9')
    const staleRejected = expect(stale).rejects.toThrow(/stale/u)
    response.resolve(await source('https://api.github.com/repos/cloga/deepseek-harness/releases?per_page=100'))
    await Promise.all([checking, manual, downloading, repeated, staleRejected])
    expect(f.fetch).toHaveBeenCalledTimes(3)
    expect(f.states.map(state => state.phase)).toEqual(['available', 'ready'])
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('keeps automatic check failures silent and publishes failures to a joining manual caller', async () => {
    const f = fixture()
    f.fetch.mockRejectedValue(new Error('offline'))
    await expect(f.coordinator.check()).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    await expect(f.coordinator.download(MANAGED_VERSION)).rejects.toThrow(/no verified update/u)
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('invalidates a previously checked selection after a subsequent acquisition failure', async () => {
    const f = fixture()
    await f.coordinator.check()
    f.fetch.mockRejectedValue(new Error('offline'))
    await f.coordinator.check(true)
    await expect(f.coordinator.download(MANAGED_VERSION)).rejects.toThrow(/no verified update/u)
    expect(f.launch).not.toHaveBeenCalled()
  })

  it.each(['stop-failed', 'tasks-changed', 'tasks-unavailable', 'unsaved-input'] as const)(
    'preserves classified %s admission failure and permits a separately authorized retry', async (kind) => {
      const f = fixture()
      f.launch.mockRejectedValueOnce(new DesktopUpdatePreparationError(kind, 'Safe recovery message', 'Safe main-owned facts'))
      await f.coordinator.check()
      await f.coordinator.download(MANAGED_VERSION)
      const failed = await f.coordinator.install(MANAGED_VERSION)
      expect(failed).toEqual({
        phase: 'error', mode: 'github-release-managed', version: MANAGED_VERSION,
        failedOperation: 'install', preparationFailure: kind,
        message: 'Safe recovery message', technicalDetails: 'Safe main-owned facts',
      })
      expect(failed).toBe(f.coordinator.state)
      f.launch.mockResolvedValueOnce(false)
      await expect(f.coordinator.install(MANAGED_VERSION)).resolves.toEqual({
        phase: 'ready', version: MANAGED_VERSION, mode: 'github-release-managed',
      })
      await expect(f.coordinator.install(MANAGED_VERSION)).resolves.toMatchObject({ phase: 'installing' })
      expect(f.launch.mock.calls[0]?.[0]).toBe(f.launch.mock.calls[2]?.[0])
      await f.coordinator.install(MANAGED_VERSION)
      expect(f.launch).toHaveBeenCalledTimes(3)
    },
  )

  it('returns the actual state published by the main adapter after handoff', async () => {
    const published: DesktopUpdateState = {
      phase: 'error', mode: 'github-release-managed', failedOperation: 'install', message: 'Main-owned handoff failure',
    }
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability(), () => 1,
      state => state.phase === 'installing' ? published : state,
      async () => true, { fetch: sourceFetch() },
    )
    await coordinator.check()
    await coordinator.download(MANAGED_VERSION)
    expect(await coordinator.install(MANAGED_VERSION)).toBe(published)
    expect(coordinator.state).toBe(published)
  })

  it('retains a helper acknowledgement failure as an install error, never a successful handoff', async () => {
    const f = fixture()
    const acknowledged = Promise.withResolvers<boolean>()
    f.launch.mockImplementationOnce(() => acknowledged.promise)
    await f.coordinator.check()
    await f.coordinator.download(MANAGED_VERSION)
    const installing = f.coordinator.install(MANAGED_VERSION)
    await vi.waitFor(() => { expect(f.launch).toHaveBeenCalledOnce() })
    acknowledged.reject(new Error('helper did not acknowledge the handoff'))
    await expect(installing).resolves.toMatchObject({
      phase: 'error', failedOperation: 'install', message: 'helper did not acknowledge the handoff',
    })
    await f.coordinator.install(MANAGED_VERSION)
    expect(f.launch).toHaveBeenCalledTimes(2)
  })

  it('rechecks installed sequence before preparation and handoff', async () => {
    const f = fixture()
    await f.coordinator.check()
    f.installedSequence.mockReturnValue(MANAGED_SEQUENCE)
    await expect(f.coordinator.download(MANAGED_VERSION)).resolves.toMatchObject({ phase: 'error', failedOperation: 'download' })
    const calls = f.fetch.mock.calls.length
    await f.coordinator.check()
    expect(f.fetch).toHaveBeenCalledTimes(calls)
    await expect(f.coordinator.install(MANAGED_VERSION)).rejects.toThrow(/not ready/u)
    f.installedSequence.mockReturnValue(1)
    await f.coordinator.download(MANAGED_VERSION)
    f.installedSequence.mockReturnValue(MANAGED_SEQUENCE)
    await expect(f.coordinator.install(MANAGED_VERSION)).resolves.toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('suppresses late check results and rejects new operations after disposal', async () => {
    const f = fixture()
    const response = Promise.withResolvers<Response>()
    f.fetch.mockImplementationOnce(() => response.promise)
    const checking = f.coordinator.check(true)
    const downloading = f.coordinator.download(MANAGED_VERSION)
    const rejected = expect(downloading).rejects.toThrow(/disposed/u)
    await Promise.resolve()
    f.coordinator.dispose()
    response.resolve(new Response('[]'))
    await Promise.all([checking, rejected])
    expect(f.states).toEqual([])
    await expect(f.coordinator.check()).rejects.toThrow(/disposed/u)
    await expect(f.coordinator.download(MANAGED_VERSION)).rejects.toThrow(/disposed/u)
    await expect(f.coordinator.install(MANAGED_VERSION)).rejects.toThrow(/disposed/u)
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('does not begin a queued handoff after disposal', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download(MANAGED_VERSION)
    const installing = f.coordinator.install(MANAGED_VERSION)
    f.coordinator.dispose()
    await installing
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.states.map(state => state.phase)).toEqual(['available', 'ready'])
  })

  it('does not publish late completion of a main-owned handoff after disposal', async () => {
    const f = fixture()
    const acknowledged = Promise.withResolvers<boolean>()
    f.launch.mockImplementationOnce(() => acknowledged.promise)
    await f.coordinator.check()
    await f.coordinator.download(MANAGED_VERSION)
    const installing = f.coordinator.install(MANAGED_VERSION)
    await vi.waitFor(() => { expect(f.launch).toHaveBeenCalledOnce() })
    f.coordinator.dispose()
    acknowledged.resolve(false)
    await installing
    expect(f.states.map(state => state.phase)).toEqual(['available', 'ready', 'installing'])
  })

  it('rejects a manifest asset whose downloaded bytes disagree with GitHub', async () => {
    const fetch = sourceFetch()
    const original = sourceFetch()
    fetch.mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/releases/download/')) return new Response(JSON.stringify(managedManifest({ sequence: 3 })))
      return original(input)
    })
    const f = fixture(fetch)
    await expect(f.coordinator.check(true)).resolves.toMatchObject({
      phase: 'error', failedOperation: 'check', message: expect.stringMatching(/digest does not match/u) as unknown,
    })
    expect(f.launch).not.toHaveBeenCalled()
  })

  it.each([
    managedManifest({ source: { ...managedManifest().source, commit: 'f'.repeat(40) } }),
    managedManifest({ build: { ...managedManifest().build, packageRegistry: 'http://registry.npmjs.org/' } }),
    { ...managedManifest(), installer: { ...managedManifest().installer, signature: 'Valid' } },
    { ...managedManifest(), identity: { ...managedManifest().identity, appId: 'untrusted.app' } },
  ])('retains source identity, package registry, signature and installed identity admission', async (manifest) => {
    // These mutations model untrusted network JSON, not typed same-process inputs.
    const fetch = sourceFetch(manifest)
    const f = fixture(fetch)
    await expect(f.coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
    await expect(f.coordinator.download(MANAGED_VERSION)).rejects.toThrow(/no verified update/u)
    expect(f.launch).not.toHaveBeenCalled()
  })

  it.each([
    ['/releases?', '读取发布列表', 'read the release list', 1],
    ['/git/ref/tags/', '校验发布标签', 'verify the release tag', 3],
    ['/releases/download/', '下载更新清单', 'download the update manifest', 2],
  ] as const)('localizes only network details at %s without changing requests or retrying', async (failedPath, stage, englishStage, calls) => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, _init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (url.includes(failedPath)) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private signed URL'), { code: 'ECONNRESET' }) })
      return normal(input)
    })
    const launch = vi.fn(async () => true)
    const publish = vi.fn((state: DesktopUpdateState) => state)
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, publish, launch, { fetch }, zh)
    await expect(coordinator.check()).resolves.toEqual({
      phase: 'error', mode: 'github-release-managed', failedOperation: 'check',
      message: `Could not ${englishStage}: the connection was reset (ECONNRESET).\nCheck your network connection and try again.`,
      technicalDetails: `${stage}时连接被重置（ECONNRESET）。\n请检查网络连接后重试。`,
    })
    expect(publish).not.toHaveBeenCalled()
    expect(coordinator.state).toEqual({ phase: 'idle', mode: 'github-release-managed' })
    expect(fetch).toHaveBeenCalledTimes(calls)
    const urls = fetch.mock.calls.map(([input]) => input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
    expect(urls).toEqual([
      'https://api.github.com/repos/cloga/deepseek-harness/releases?per_page=100',
      `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/release.json`,
      `https://api.github.com/repos/cloga/deepseek-harness/git/ref/tags/${MANAGED_TAG}`,
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
    await expect(coordinator.install(MANAGED_VERSION)).rejects.toThrow('confirmed target is not ready')
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it.each([
    ['English', en, 'Could not read the release list: the connection was reset (ECONNRESET).\nCheck your network connection and try again.'],
    ['Chinese', zh, '读取发布列表时连接被重置（ECONNRESET）。\n请检查网络连接后重试。'],
  ] as const)('publishes a joined manual network failure once with %s technical details', async (_locale, messages, details) => {
    const response = Promise.withResolvers<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise)
    const publish = vi.fn((state: DesktopUpdateState) => state)
    const launch = vi.fn(async () => true)
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, publish, launch, { fetch }, messages)
    const automatic = coordinator.check()
    const manual = coordinator.check(true)
    await Promise.resolve()
    response.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('private URL'), { code: 'ECONNRESET' }) }))
    const [silent, published] = await Promise.all([automatic, manual])
    expect(published).toEqual(silent)
    expect(published).toMatchObject({ phase: 'error', failedOperation: 'check', technicalDetails: details })
    expect(published.message).toBe('Could not read the release list: the connection was reset (ECONNRESET).\nCheck your network connection and try again.')
    expect(coordinator.state).toBe(published)
    expect(publish).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(launch).not.toHaveBeenCalled()
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
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, state => state, async () => true, { fetch }, zh)
    const state = await coordinator.check()
    expect(state).toEqual({
      phase: 'error', mode: 'github-release-managed', failedOperation: 'check',
      message: 'Could not download the update manifest: the connection was reset (ECONNRESET).\nCheck your network connection and try again.',
      technicalDetails: '下载更新清单时连接被重置（ECONNRESET）。\n请检查网络连接后重试。',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retains the integrity error instead of reporting a network problem', async () => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      return url.includes('/releases/download/') ? new Response('{}') : normal(input)
    })
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability(), () => 1, state => state, async () => true, { fetch }, zh)
    const state = await coordinator.check()
    expect(state).toEqual({ phase: 'error', mode: 'github-release-managed', failedOperation: 'check',
      message: 'desktop managed update: manifest asset digest does not match GitHub' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('discovers the immutable source release and shares repeated install clicks', async () => {
    const states: unknown[] = []
    let releaseLaunch!: (accepted: boolean) => void
    const launch = vi.fn<(selection: DesktopManagedUpdateSelection) => Promise<boolean>>(
      () => new Promise<boolean>((resolve) => { releaseLaunch = resolve }),
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
      version: MANAGED_VERSION,
    })
    await coordinator.download(MANAGED_VERSION)
    const first = coordinator.install(MANAGED_VERSION)
    const second = coordinator.install(MANAGED_VERSION)
    expect(first).toBe(second)
    await vi.waitFor(() => { expect(launch).toHaveBeenCalledOnce() })
    const launched = launch.mock.calls[0]?.[0]
    expect(launched?.kind).toBe('source')
    expect(launched?.manifestSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(launched?.assetSha256).toMatch(/^[a-f0-9]{64}$/u)
    releaseLaunch(true)
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
      async () => true,
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
      async () => true,
      { fetch: sourceFetch() },
    )
    await expect(coordinator.check()).resolves.toEqual({
      phase: 'idle',
      mode: 'github-release-managed',
    })
  })

  it('rejects a source release whose tag commit differs from its target', async () => {
    const normal = sourceFetch()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      // The manifest and raw digest remain valid; this negative reaches actual eligible tag verification.
      return url.includes('/git/ref/tags/')
        ? new Response(JSON.stringify({ object: { type: 'commit', sha: 'f'.repeat(40) } }))
        : normal(input)
    })
    const coordinator = new DesktopManagedUpdateCoordinator(
      managedCapability(),
      () => 1,
      state => state,
      async () => true,
      { fetch },
    )
    const state = await coordinator.check()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('expected managed update error')
    expect(state.message).toMatch(/does not resolve/u)
  })
})
