/** Source-locked Windows managed update checks and detached-helper handoff. */

import {
  assertManagedUpdateRedirect,
  parseDesktopManagedUpdateManifest,
  type DesktopAcceptedManagedUpdateManifest,
  type DesktopManagedUpdateCapability,
} from './managed-update-protocol.ts'
import type { DesktopUpdateState } from './ipc.ts'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_MANIFEST_BYTES = 1024 * 1024

class ManifestHttpError extends Error {
  constructor(readonly status: number) {
    super(`desktop managed update: manifest returned HTTP ${String(status)}`)
  }
}

/** Immutable release selected by one managed check. */
export interface DesktopManagedUpdateSelection {
  readonly kind: 'source' | 'migration'
  readonly manifest: DesktopAcceptedManagedUpdateManifest
}

interface ManagedUpdateOperations {
  fetch(url: string, init: RequestInit): Promise<Response>
}

const defaultOperations: ManagedUpdateOperations = {
  fetch: (url, init) => fetch(url, init),
}

async function fetchManifest(url: string, operations: ManagedUpdateOperations): Promise<unknown> {
  let current = url
  for (let count = 0; count <= 5; count++) {
    const response = await operations.fetch(current, { method: 'GET', redirect: 'manual', credentials: 'omit' })
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new Error('desktop managed update: redirect omitted Location')
      const target = new URL(location, current).href
      assertManagedUpdateRedirect(current, target)
      current = target
      continue
    }
    if (!response.ok) throw new ManifestHttpError(response.status)
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_MANIFEST_BYTES)) {
      throw new Error('desktop managed update: manifest exceeds the allowed size')
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > MAX_MANIFEST_BYTES) throw new Error('desktop managed update: manifest exceeds the allowed size')
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error('desktop managed update: manifest is not JSON')
    }
  }
  throw new Error('desktop managed update: redirect limit exceeded')
}

/** Managed check/install state owner; install delegates only a validated immutable selection. */
export class DesktopManagedUpdateCoordinator {
  private selection: DesktopManagedUpdateSelection | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  constructor(
    private readonly capability: DesktopManagedUpdateCapability,
    private readonly installedSequence: () => number,
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly launch: (selection: DesktopManagedUpdateSelection) => Promise<void>,
    private readonly operations: ManagedUpdateOperations = defaultOperations,
  ) {}

  /** Check the exact source-owned manifest, falling back only to an explicit unconsumed migration. */
  check(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    if (this.checkOperation !== undefined) return this.checkOperation
    this.checkOperation = this.doCheck().finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  /** Launch one detached helper for the retained selection; repeated clicks share one operation. */
  install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      const selection = this.selection
      if (selection === undefined) throw new Error('desktop managed update: no verified update is available')
      this.publish({
        phase: 'installing',
        version: selection.manifest.owner === 'cloga/deepseek-harness'
          ? selection.manifest.version : selection.manifest.channelVersion,
        mode: 'windows-ops-managed',
        interactiveInstaller: true,
      })
      try {
        await this.launch(selection)
        this.selection = undefined
        return this.publish({
          phase: 'installing',
          version: selection.manifest.owner === 'cloga/deepseek-harness'
            ? selection.manifest.version : selection.manifest.channelVersion,
          mode: 'windows-ops-managed',
          interactiveInstaller: true,
        })
      } catch (error) {
        return this.publish({
          phase: 'error',
          mode: 'windows-ops-managed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    this.publish({ phase: 'checking', mode: 'windows-ops-managed' })
    try {
      const installedSequence = this.installedSequence()
      let kind: DesktopManagedUpdateSelection['kind'] = 'source'
      let value: unknown
      try {
        value = await fetchManifest(this.capability.manifestUrl, this.operations)
      } catch (error) {
        if (!(error instanceof ManifestHttpError) || error.status !== 404
          || this.capability.migration === undefined || installedSequence !== 0) throw error
        kind = 'migration'
        value = await fetchManifest(this.capability.migration.manifestUrl, this.operations)
      }
      const manifest = parseDesktopManagedUpdateManifest(value, this.capability, installedSequence, true)
      if ((kind === 'source') !== (manifest.owner === 'cloga/deepseek-harness')) {
        throw new Error('desktop managed update: fetched manifest does not match its selected channel')
      }
      if (manifest.sequence === installedSequence) {
        this.selection = undefined
        return this.publish({ phase: 'idle', mode: 'windows-ops-managed' })
      }
      this.selection = { kind, manifest }
      const version = manifest.owner === 'cloga/deepseek-harness' ? manifest.version : manifest.channelVersion
      return this.publish({
        phase: 'available',
        version,
        mode: 'windows-ops-managed',
        interactiveInstaller: true,
      })
    } catch (error) {
      this.selection = undefined
      return this.publish({
        phase: 'error',
        mode: 'windows-ops-managed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
