/** Acceptance-only browser code, type-stripped from source rather than serialized through tsx. */
import type { PositiveCopilotUsageEvidence } from './copilot-usage-positive-smoke.ts'

// Public structural views keep Client declaration merges out of the Host-runner program.
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
  apply: (context: FixtureContext) => unknown
}
interface FixtureObservable {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}
interface FixtureBinding {
  key: string | undefined
  ctx?: FixtureContext
  hooks: Record<string, FixtureObservable | undefined>
  keyedHooks: Record<string, ((key: string) => FixtureObservable | undefined) | undefined>
  props: Record<string, unknown>
}
interface FixtureAreaProps {
  children?: unknown
  empty?: () => unknown
}
interface FixtureScope {
  current: FixtureObservable
  bindingSource(target: unknown): FixtureObservable
  renderArea(binding: FixtureBinding, props: FixtureAreaProps): unknown
}
interface FixtureSlots {
  installScope(name: string, adapter: FixtureScope): void
  register(
    definition: { name: string; children: Record<string, { kind: string; scope: string }> },
    component: (props: { renderSlot: (name: string, props: object) => unknown; SessionProvider: unknown }) => unknown,
  ): unknown
  entries(name: string): readonly unknown[]
}
interface FixtureReact {
  createElement(type: unknown, props: object, ...children: unknown[]): unknown
}

type AcceptanceWindow = Window & {
  __desktopUsageModules?: FixtureModules
  __desktopUsageRestore?: () => void
}

/** Capture a fresh public bootstrap call without leaving a replaced facade or fixture globals behind. */
export function captureUsageModulesInBrowser(): void {
  const target = window as AcceptanceWindow
  if (Object.hasOwn(target, '__ModuleLoader__') || Object.hasOwn(target, '__desktopUsageRestore')
    || Object.hasOwn(target, '__desktopUsageModules')) throw new Error('Usage capture must precede a fresh application bootstrap')
  let facade: FixtureFacade | undefined
  let originalCreate: FixtureFacade['create'] | undefined
  let createDescriptor: PropertyDescriptor | undefined
  const restoreCreate = (): void => {
    if (facade !== undefined && originalCreate !== undefined) {
      if (createDescriptor === undefined) {
        if (!Reflect.deleteProperty(facade, 'create')) throw new Error('Usage capture could not restore the inherited bootstrap method')
      } else Object.defineProperty(facade, 'create', createDescriptor)
      originalCreate = undefined
    }
  }
  const restoreFacade = (): void => {
    if (facade === undefined) {
      if (!Reflect.deleteProperty(target, '__ModuleLoader__')) throw new Error('Usage capture could not restore the bootstrap global')
    } else Object.defineProperty(target, '__ModuleLoader__', { configurable: true, enumerable: true, writable: true, value: facade })
  }
  Object.defineProperty(target, '__desktopUsageRestore', {
    configurable: true,
    value() {
      let failed = false
      let failure: unknown
      for (const restore of [restoreCreate, restoreFacade,
        () => { if (!Reflect.deleteProperty(target, '__desktopUsageModules')) throw new Error('Usage module capture could not be removed') },
        () => { if (!Reflect.deleteProperty(target, '__desktopUsageRestore')) throw new Error('Usage capture disposer could not be removed') },
      ]) {
        try { restore() } catch (error) { if (!failed) { failed = true; failure = error } }
      }
      if (failed) throw failure
    },
  })
  Object.defineProperty(target, '__ModuleLoader__', {
    configurable: true, enumerable: true,
    get: () => facade,
    set(value: FixtureFacade) {
      facade = value
      const create = value.create
      originalCreate = create
      createDescriptor = Object.getOwnPropertyDescriptor(value, 'create')
      value.create = function (options) {
        let modules: FixtureModules | undefined
        let failed = false
        let failure: unknown
        try {
          modules = create.call(this, options)
          target.__desktopUsageModules = modules
        } catch (error) { failed = true; failure = error }
        finally {
          for (const restore of [restoreCreate, restoreFacade]) {
            try { restore() } catch (error) { if (!failed) { failed = true; failure = error } }
          }
        }
        if (failed) throw failure
        if (modules === undefined) throw new Error('Bootstrap did not provide its module loader')
        return modules
      }
    },
  })
}

/** Remove only this capture's globals, retaining the normal boot-installed module facade. */
export function restoreUsageModulesInBrowser(): void {
  const target = window as AcceptanceWindow
  target.__desktopUsageRestore?.()
  if (Object.hasOwn(target, '__desktopUsageModules') || Object.hasOwn(target, '__desktopUsageRestore')) {
    throw new Error('Usage capture restoration is incomplete')
  }
}

/**
 * Exercise released modules inside a fixture-owned Cordis context with no Host transport.
 * @param route - Synthetic eligible provider selection; no model request is made.
 * @returns Positive DOM and lifecycle observations only after all owned cleanup succeeds.
 */
export async function runPositiveUsageInBrowser(route: string): Promise<PositiveCopilotUsageEvidence> {
  if (!['github-copilot', 'github-copilot-preview'].includes(route)) throw new Error('Unsupported positive usage route')
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
  let context: FixtureContext | undefined
  const container = document.createElement('section')
  container.setAttribute('data-desktop-usage-acceptance', route)
  const source = <T>(initial: T) => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      set(next: T) { value = next; for (const listener of [...listeners]) listener() },
      subscribers: () => listeners.size,
    }
  }
  let quotaReads = 0
  let forbiddenRemoteCalls = 0
  const errors: unknown[][] = []
  const originalError = console.error
  const onError = (event: Event): void => { errors.push([event.type]) }
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
  const absentBinding: FixtureBinding = {
    key: undefined, hooks: { session: undefined }, keyedHooks: { projection: undefined }, props: { sessionId: undefined },
  }
  const absent = source<FixtureBinding>(absentBinding)
  const current = source<FixtureBinding>(absentBinding)
  let unmount = () => {}
  let disposeClient: (() => Promise<void>) | undefined
  let slots: FixtureSlots | undefined
  let evidence: Omit<PositiveCopilotUsageEvidence, 'subscriptionsReleased' | 'syntheticContextDisposed'> | undefined
  let subscriptionsReleased = false
  let syntheticContextDisposed = false
  let failed = false
  let failure: unknown
  const retain = (error: unknown): void => { if (!failed) { failed = true; failure = error } }
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 10_000
    while (!predicate()) {
      if (errors.length > 0) throw new Error('Packaged usage fixture reported renderer errors')
      if (performance.now() >= deadline) throw new Error('Packaged usage fixture timed out')
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
    }
  }
  const frame = async (): Promise<void> => {
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
  }
  const trigger = () => container.querySelector('[data-fixture-inherited] [data-copilot-usage-trigger]')
  const dock = 'conversation.composer.dock'
  try {
    context = new Context()
    const binding: FixtureBinding = {
      key: 'desktop-usage-fixture', ctx: context,
      hooks: { session }, keyedHooks: { projection: key => key === 'modelSelection' ? projection : undefined },
      props: { sessionId: 'desktop-usage-fixture' },
    }
    document.body.append(container)
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args) }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onError)
    await context.plugin({ inject: renderer.inject, apply: renderer.apply })
    await context.plugin({ apply(ctx) { new RemoteRoot(ctx); new AccountNamespace(ctx); new UsageRemote(ctx) } })
    const slotService = context.get('slots')
    requireMethods(slotService, ['installScope', 'register', 'entries'], 'SlotRegistry')
    slots = slotService as FixtureSlots
    const adapter: FixtureScope = {
      current,
      bindingSource(target) {
        if (target !== undefined) throw new Error('Unsupported explicit fixture Session reference')
        return absent
      },
      renderArea: (value, props) => value.key === undefined ? props.empty?.() ?? null : props.children,
    }
    slots.installScope('session', adapter)
    slots.register({ name: 'root', children: { [dock]: { kind: 'list', scope: 'session' } } },
      ({ renderSlot, SessionProvider }) => React.createElement('div', {},
        React.createElement('div', { 'data-fixture-inherited': true },
          React.createElement(SessionProvider, { empty: () => React.createElement('span', { 'data-fixture-current-absent': true }, '') },
            renderSlot(dock, {}))),
        React.createElement('div', { 'data-fixture-explicit-absence': true },
          React.createElement(SessionProvider, { session: undefined, empty: () => React.createElement('span', { 'data-fixture-absent': true }, '') },
            renderSlot(dock, {}))),
        React.createElement('span', { 'data-fixture-sibling': true }, 'Synthetic sibling')))
    const fiber = context.plugin(client)
    disposeClient = async () => { await fiber.dispose() }
    await fiber
    const uiRenderer = context.get('uiRenderer')
    requireMethods(uiRenderer, ['mount'], 'UiRenderer service')
    unmount = (uiRenderer as { mount(container: HTMLElement): () => void }).mount(container)
    await frame()
    if (container.querySelector('[data-fixture-current-absent]') === null || trigger() !== null || quotaReads !== 0) {
      throw new Error('Absent current binding must not expose usage or read quota')
    }
    current.set(binding)
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true && quotaReads === 1)
    const usageText = trigger()!.textContent
    const sibling = container.querySelector('[data-fixture-sibling]')
    const sessionSubscribed = session.subscribers() > 0 && projection.subscribers() > 0
      && current.subscribers() > 0 && absent.subscribers() > 0
    if (container.querySelector('[data-fixture-absent]') === null
      || container.querySelector('[data-fixture-explicit-absence] [data-copilot-usage-trigger]') !== null) {
      throw new Error('Explicit absence must not inherit the current live Session')
    }
    session.set({ sessionId: 'desktop-usage-fixture', removed: true, openState: 'open' })
    await waitFor(() => trigger() === null)
    session.set({ sessionId: 'desktop-usage-fixture', removed: false, openState: 'open' })
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true && quotaReads === 2)
    session.set({ sessionId: 'desktop-usage-fixture', removed: false, openState: 'closed' })
    await waitFor(() => trigger() === null)
    session.set({ sessionId: 'desktop-usage-fixture', removed: false, openState: 'open' })
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true && quotaReads === 3)
    projection.set({ lastUsed: selection(route), next: selection('other-provider') })
    await waitFor(() => trigger() === null)
    projection.set({ lastUsed: selection('other-provider'), next: selection(route) })
    await waitFor(() => trigger()?.textContent?.includes('7 used') === true && quotaReads === 4)
    await disposeClient()
    disposeClient = undefined
    await waitFor(() => trigger() === null && session.subscribers() === 0 && projection.subscribers() === 0)
    if (slots.entries(dock).length !== 0) throw new Error('Disposed Client left a raw Slot registration')
    evidence = {
      scope: 'packaged-renderer-released-client-synthetic-session-and-quota',
      provider: route, usageText, quotaReads, sessionSubscribed,
      removedSessionHidesUsage: true, otherProviderHidesUsage: true, clientDisposalRemovesUsage: true,
      selectorErrors: errors.length, forbiddenRemoteCalls,
      hostTransport: 'not-provided-to-isolated-fixture',
      applicationMountPreserved: document.getElementById('root') === application && application.isConnected,
      syntheticSiblingPreserved: sibling !== null && container.querySelector('[data-fixture-sibling]') === sibling,
      inheritedSessionScopeVerified: true, explicitUndefinedSessionScopeAbsent: true,
      removedSessionRestoresUsage: true, closedSessionHidesUsage: true, closedSessionRestoresUsage: true,
      restoredProviderShowsUsage: true,
    }
  } catch (error) {
    retain(error)
  } finally {
    try { unmount() } catch (error) { retain(error) }
    try { await disposeClient?.() } catch (error) { retain(error) }
    try { await context?.fiber.dispose(); syntheticContextDisposed = context !== undefined } catch (error) { retain(error) }
    try {
      if ([session, projection, current, absent].some(observable => observable.subscribers() !== 0)) {
        throw new Error('Usage fixture left a source subscription')
      }
      if (slots !== undefined && slots.entries(dock).length !== 0) throw new Error('Usage fixture left raw Slot registrations')
      subscriptionsReleased = true
    } catch (error) { retain(error) }
    try { window.removeEventListener('error', onError) } catch (error) { retain(error) }
    try { window.removeEventListener('unhandledrejection', onError) } catch (error) { retain(error) }
    try { console.error = originalError } catch (error) { retain(error) }
    try { container.remove() } catch (error) { retain(error) }
    if (container.isConnected || document.getElementById('root') !== application || !application.isConnected) {
      retain(new Error('Usage fixture did not restore its original application mount'))
    }
    if (errors.length > 0) retain(new Error('Usage fixture observed renderer errors'))
  }
  if (failed) throw failure
  if (evidence === undefined || !subscriptionsReleased || !syntheticContextDisposed) {
    throw new Error('Positive usage evidence or cleanup is incomplete')
  }
  return { ...evidence, subscriptionsReleased, syntheticContextDisposed }
}
