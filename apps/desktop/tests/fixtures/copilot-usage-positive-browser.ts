/** Acceptance-only browser code, type-stripped from source rather than serialized through tsx. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ClientModuleLoader, ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import type { ScopedStandardSourceBinding, SlotScopeAdapter } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PositiveCopilotUsageEvidence } from './copilot-usage-positive-smoke.ts'

type AcceptanceWindow = Window & {
  __desktopUsageModules?: ClientModuleLoader
}

/** Capture one public bootstrap call and restore the original facade even when boot fails. */
export function captureUsageModulesInBrowser(): void {
  const target = window as AcceptanceWindow
  let facade: ClientModuleLoaderTarget | undefined
  Object.defineProperty(target, '__ModuleLoader__', {
    configurable: true,
    get: () => facade,
    set(value: ClientModuleLoaderTarget) {
      const create = value.create
      value.create = function (options) {
        try {
          const modules = create.call(this, options)
          target.__desktopUsageModules = modules
          return modules
        } finally {
          value.create = create
          Object.defineProperty(target, '__ModuleLoader__', { configurable: true, writable: true, value })
        }
      }
      facade = value
    },
  })
}

/**
 * Exercise released modules inside a fixture-owned Cordis context with no Host transport.
 * @param route - Synthetic eligible provider selection; no model request is made.
 * @returns Positive DOM and lifecycle observations, not live account evidence.
 */
export async function runPositiveUsageInBrowser(route: string): Promise<PositiveCopilotUsageEvidence> {
  const modules = (window as AcceptanceWindow).__desktopUsageModules
  if (modules === undefined) throw new Error('Packaged module loader was not captured')
  const load = (id: string) => modules.import(id, '', {})
  const { Context, Service } = await load('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
  const React = await load('react') as typeof import('react')
  const renderer = await load('@deepseek-ai/dsh-client-ui-renderer') as typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
  const client = await load('dsh-github-copilot') as Plugin<undefined>
  const application = document.getElementById('root')
  if (application === null) throw new Error('Packaged application mount is missing')
  const context = new Context()
  const container = document.createElement('section')
  container.setAttribute('data-desktop-usage-acceptance', route)
  document.body.append(container)
  const source = <T,>(initial: T) => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      set(next: T) { value = next; for (const listener of listeners) listener() },
      subscribers: () => listeners.size,
    }
  }
  let quotaReads = 0
  let forbiddenRemoteCalls = 0
  const errors: unknown[][] = []
  const originalError = console.error
  class RemoteRoot extends Service {
    constructor(ctx: Context) { super(ctx, 'remote') }
    async $mount() { return async () => {} }
    $on() { return () => {} }
  }
  class AccountNamespace extends Service {
    constructor(ctx: Context) { super(ctx, 'remote.githubCopilot') }
  }
  class UsageRemote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote.githubCopilotUsage') }
    async get() {
      quotaReads++
      return { ok: true, value: {
        state: 'ready', billing: 'credits', budget: 'individual', used: 7, remaining: 13, limit: 20, observedAt: 1,
      } }
    }
    refresh(): never {
      forbiddenRemoteCalls++
      throw new Error('Synthetic usage fixture forbids refresh')
    }
  }
  const session = source({ sessionId: 'desktop-usage-fixture', removed: false, openState: 'open' })
  const selection = (provider: string) => ({ provider, model: 'synthetic-account-model' })
  const projection = source({ lastUsed: selection('other-provider'), next: selection(route) })
  let unmount = () => {}
  let disposeClient: (() => Promise<void>) | undefined
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 10_000
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error('Packaged usage fixture timed out')
      await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
    }
  }
  const trigger = () => container.querySelector('[data-copilot-usage-trigger]')
  try {
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args) }
    await context.plugin({ inject: renderer.inject, apply: renderer.apply })
    await context.plugin({ apply(ctx) { new RemoteRoot(ctx); new AccountNamespace(ctx); new UsageRemote(ctx) } })
    const slots = context.get('slots')!
    const binding: ScopedStandardSourceBinding = {
      key: 'desktop-usage-fixture', ctx: context,
      hooks: { session }, keyedHooks: { projection: key => key === 'modelSelection' ? projection : undefined },
      props: { sessionId: 'desktop-usage-fixture' },
    }
    const current = source(binding)
    const adapter: SlotScopeAdapter = {
      current, resolve: key => key === binding.key ? binding : undefined,
      renderArea: (_binding, props) => props.children as import('react').ReactNode,
    }
    slots.installScope('session', adapter)
    const dock = 'conversation.composer.dock'
    slots.register({ name: 'root', children: { [dock]: { kind: 'list', scope: 'session' } } },
      ({ renderSlot, SessionProvider }) => React.createElement(SessionProvider, {},
        React.createElement('div', {}, renderSlot(dock, {}),
          React.createElement('span', { 'data-fixture-sibling': true }, 'Synthetic sibling'))))
    const fiber = context.plugin(client)
    await fiber
    disposeClient = async () => { await fiber.dispose() }
    unmount = context.get('uiRenderer')!.mount(container)
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true)
    const usageText = trigger()!.textContent!
    const sibling = container.querySelector('[data-fixture-sibling]')
    const sessionSubscribed = session.subscribers() > 0 && projection.subscribers() > 0
    session.set({ sessionId: 'desktop-usage-fixture', removed: true, openState: 'open' })
    await waitFor(() => trigger() === null)
    session.set({ sessionId: 'desktop-usage-fixture', removed: false, openState: 'open' })
    await waitFor(() => trigger() !== null && quotaReads === 2)
    projection.set({ lastUsed: selection(route), next: selection('other-provider') })
    await waitFor(() => trigger() === null)
    await disposeClient()
    disposeClient = undefined
    await waitFor(() => session.subscribers() === 0 && projection.subscribers() === 0)
    return {
      scope: 'packaged-renderer-released-client-synthetic-session-and-quota',
      provider: route, usageText, quotaReads, sessionSubscribed,
      removedSessionHidesUsage: true, otherProviderHidesUsage: true,
      clientDisposalRemovesUsage: slots.entriesOfSlot(dock).length === 0,
      selectorErrors: errors.length, forbiddenRemoteCalls,
      hostTransport: 'not-provided-to-isolated-fixture',
      applicationMountPreserved: document.getElementById('root') === application && application.isConnected,
      syntheticSiblingPreserved: sibling !== null && container.querySelector('[data-fixture-sibling]') === sibling,
    }
  } finally {
    try {
      unmount()
    } finally {
      try { await disposeClient?.() } finally {
        try { await context.fiber.dispose() } finally {
          console.error = originalError
          container.remove()
        }
      }
    }
  }
}
