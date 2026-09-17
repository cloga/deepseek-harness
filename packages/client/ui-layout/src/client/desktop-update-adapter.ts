/** Fiber-owned projection of Desktop update IPC into a registrant-private observable. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Update fields displayed by the layout, without installer diagnostics. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
}

/** Optional preload methods needed by the update notice. */
export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdateState>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
  review(): Promise<void>
}

/** Cached notice projection, including the outstanding explicit review request. */
export interface DesktopUpdateSnapshot {
  readonly state: DesktopUpdateState | null
  readonly reviewing: boolean
  readonly reviewFailed: boolean
}

/** Private root-entry injection; the renderer binds its source to useDesktopUpdate. */
export interface DesktopUpdateInject {
  readonly hooks: { readonly desktopUpdate: HostObservable<DesktopUpdateSnapshot> }
  readonly reviewDesktopUpdate: () => Promise<void>
}

/**
 * Select the supported preload without changing ordinary Web or older Desktop clients.
 * @param browser - Browser global read only by the plugin's apply closure.
 * @returns Complete update bridge, or undefined when its methods are unavailable.
 */
export function desktopUpdateBridge(browser: Window): DesktopUpdateBridge | undefined {
  const desktop = (browser as Window & {
    readonly dshDesktop?: { readonly protocolVersion?: number; readonly updates?: Partial<DesktopUpdateBridge> }
  }).dshDesktop
  const updates = desktop?.updates
  if (desktop?.protocolVersion !== 2 || updates === undefined
    || typeof updates.status !== 'function' || typeof updates.subscribe !== 'function'
    || typeof updates.review !== 'function') return undefined
  return updates as DesktopUpdateBridge
}

/** One apply-owned subscription and review operation, independent of React mounts. */
export class DesktopUpdateAdapter implements HostObservable<DesktopUpdateSnapshot> {
  private snapshot: DesktopUpdateSnapshot = { state: null, reviewing: false, reviewFailed: false }
  private readonly listeners = new Set<() => void>()
  private active = false

  /** @param bridge - Supported preload, or undefined on ordinary Web. */
  constructor(private readonly bridge: DesktopUpdateBridge | undefined) {}

  /** @returns The same snapshot reference until displayed state changes. */
  readonly getSnapshot = (): DesktopUpdateSnapshot => this.snapshot

  /** @param listener - Framework invalidation callback. @returns Subscription cleanup. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Subscribe once for the owning Fiber's lifetime.
   * @returns Cleanup that prevents late IPC responses and queued events from publishing.
   */
  connect(): () => void {
    const bridge = this.bridge
    if (bridge === undefined) return () => { this.listeners.clear() }
    this.active = true
    let receivedEvent = false
    const off = bridge.subscribe((state) => {
      if (!this.active) return
      receivedEvent = true
      this.publish({ ...this.snapshot, state, reviewFailed: false })
    })
    void bridge.status().then((state) => {
      // A later event wins over a delayed initial IPC snapshot.
      if (this.active && !receivedEvent) this.publish({ ...this.snapshot, state })
    }).catch(() => {
      // Snapshot errors do not create an update claim; a later event can recover.
    })
    return () => {
      this.active = false
      this.listeners.clear()
      off()
    }
  }

  /** Open only an explicit review, coalescing requests until its IPC promise settles. */
  readonly review = async (): Promise<void> => {
    const state = this.snapshot.state
    if (this.bridge === undefined || !this.active || this.snapshot.reviewing || state?.version === undefined
      || state.phase === 'idle' || state.phase === 'checking' || state.phase === 'installing' || state.phase === 'ready') return
    this.publish({ ...this.snapshot, reviewing: true, reviewFailed: false })
    let reviewFailed = false
    try {
      await this.bridge.review()
    } catch {
      reviewFailed = true
    } finally {
      this.publish({ ...this.snapshot, reviewing: false, reviewFailed })
    }
  }

  private publish(next: DesktopUpdateSnapshot): void {
    if (!this.active) return
    const previous = this.snapshot
    if (previous.state?.phase === next.state?.phase && previous.state?.version === next.state?.version
      && previous.reviewing === next.reviewing && previous.reviewFailed === next.reviewFailed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
