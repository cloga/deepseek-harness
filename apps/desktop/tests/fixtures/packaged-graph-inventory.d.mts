/** Type declarations for the real read-only packaged graph acceptance implementation. */
import type { createProfileResolutionGeneration, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import type { DesktopRuntimeDescriptor } from '../../src/runtime-tree.ts'

/** Caller-owned locations and genuine official profile inspection helpers. */
export interface PackagedGraphInventoryInput {
  readonly profile: string
  readonly runtimeRoot: string
  readonly runtime: DesktopRuntimeDescriptor
  readonly plugins: readonly string[]
  readonly loadProfileDirectory: typeof loadProfileDirectory
  readonly createProfileResolutionGeneration: typeof createProfileResolutionGeneration
}

/**
 * Resolve app-boot without executing an ancestor or runner-provided implementation.
 * @param runtimeRoot - Verified ASAR-backed runtime root.
 * @returns Canonical entry confined to the runtime's app-boot package.
 */
export function resolvePackagedAppBoot(runtimeRoot: string): string

/**
 * Check owned package identities and declared semver requirements without activating a graph.
 * @param input - Exact profile, descriptor, plugin roots and real app-boot helpers.
 * @returns Resolves when the scoped inventory satisfies ownership and declared semver ranges.
 */
export function assertPackagedGraphInventory(input: PackagedGraphInventoryInput): Promise<void>
