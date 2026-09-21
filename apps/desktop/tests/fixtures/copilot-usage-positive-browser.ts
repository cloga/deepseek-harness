/** Acceptance-only browser code, type-stripped from source rather than serialized through tsx. */
import type { PositiveCopilotUsageEvidence } from './copilot-usage-positive-smoke.ts'

// This Host-runner fixture loads browser exports at runtime. Local structural views
// keep React/JSX and Client project declarations out of the Host compiler program.
// They describe public calls only; all renderer, selector, and Slot code stays shipped code.
interface FixtureModules {
  import(id: string, parent: string, attributes: Record<string, unknown>): Promise<unknown>
}
interface FixtureFacade {
  create: (this: FixtureFacade, options: unknown) => FixtureModules
}
interface FixtureFiber extends PromiseLike<void> {
  dispose(): Promise<void>
}
interface FixtureContext {
  plugin(plugin: FixturePlugin): FixtureFiber
  get(name: string): unknown
  fiber: { dispose(): Promise<void> }
}
interface FixturePlugin {
  inject?: unknown
  apply: (this: void, context: FixtureContext) => unknown
}
interface FixtureObservable {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}
interface FixtureBinding {
  key: string
  ctx: FixtureContext
  hooks: Record<string, FixtureObservable>
  keyedHooks: Record<string, (key: string) => FixtureObservable | undefined>
  props: Record<string, unknown>
}
interface FixtureScope {
  current: FixtureObservable
  resolve(key: string): FixtureBinding | undefined
  renderArea(binding: FixtureBinding, props: { children?: unknown }): unknown
}
interface FixtureSlots {
  installScope(name: string, adapter: FixtureScope): unknown
  register(
    definition: { name: string; children: Record<string, { kind: string; scope: string }> },
    component: (props: { renderSlot: (this: void, name: string, props: object) => unknown; SessionProvider: unknown }) => unknown,
  ): unknown
  entriesOfSlot(name: string): readonly unknown[]
}
interface FixtureReact {
  createElement(type: unknown, props: object, ...children: unknown[]): unknown
}

type AcceptanceWindow = Window & {
  __desktopUsageModules?: FixtureModules
}

/** Capture one public bootstrap call and restore the original facade even when boot fails. */
export function captureUsageModulesInBrowser(): void {
  const target = window as AcceptanceWindow
  let facade: FixtureFacade | undefined
  Object.defineProperty(target, '__ModuleLoader__', {
    configurable: true,
    get: () => facade,
    set(value: FixtureFacade) {
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
  const requireMethods = (value: unknown, names: readonly string[], label: string): void => {
    if (typeof value !== 'object' || value === null
      || names.some(name => typeof Reflect.get(value, name) !== 'function')) {
      throw new Error(`Packaged ${label} public methods are unavailable`)
    }
  }
  const cordis = await load('@deepseek-ai/cordis')
  requireMethods(cordis, ['Context', 'Service'], 'Cordis')
  const { Context, Service } = cordis as {
    Context: new () => FixtureContext
    Service: new (context: FixtureContext, name: string) => object
  }
  const react = await load('react')
  requireMethods(react, ['createElement'], 'React')
  const React = react as FixtureReact
  const rendererModule = await load('@deepseek-ai/dsh-client-ui-renderer')
  requireMethods(rendererModule, ['apply'], 'UiRenderer')
  const renderer = rendererModule as FixturePlugin
  const clientModule = await load('dsh-github-copilot')
  requireMethods(clientModule, ['apply'], 'Copilot Client')
  const client = clientModule as FixturePlugin
  const application = document.getElementById('root')
  if (application === null) throw new Error('Packaged application mount is missing')
  const context = new Context()
  const container = document.createElement('section')
  container.setAttribute('data-desktop-usage-acceptance', route)
  document.body.append(container)
  const source = <T>(initial: T) => {
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
    constructor(ctx: FixtureContext) { super(ctx, 'remote') }
    async $mount() { return async () => {} }
    $on() { return () => {} }
  }
  class AccountNamespace extends Service {
    constructor(ctx: FixtureContext) { super(ctx, 'remote.githubCopilot') }
  }
  class UsageRemote extends Service {
    constructor(ctx: FixtureContext) { super(ctx, 'remote.githubCopilotUsage') }
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
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
    }
  }
  const trigger = () => container.querySelector('[data-copilot-usage-trigger]')
  try {
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args) }
    await context.plugin({ inject: renderer.inject, apply: renderer.apply })
    await context.plugin({ apply(ctx) { new RemoteRoot(ctx); new AccountNamespace(ctx); new UsageRemote(ctx) } })
    const slotService = context.get('slots')
    requireMethods(slotService, ['installScope', 'register', 'entriesOfSlot'], 'SlotRegistry')
    const slots = slotService as FixtureSlots
    const binding: FixtureBinding = {
      key: 'desktop-usage-fixture', ctx: context,
      hooks: { session }, keyedHooks: { projection: key => key === 'modelSelection' ? projection : undefined },
      props: { sessionId: 'desktop-usage-fixture' },
    }
    const current = source(binding)
    const adapter: FixtureScope = {
      current, resolve: key => key === binding.key ? binding : undefined,
      renderArea: (_binding, props) => props.children,
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
    const uiRenderer = context.get('uiRenderer')
    requireMethods(uiRenderer, ['mount'], 'UiRenderer service')
    unmount = (uiRenderer as { mount(container: HTMLElement): () => void }).mount(container)
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true)
    const usageText = trigger()!.textContent
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
