/** Serializable launcher-owned package records shared by Host and Client consumers. */

/** Exact immutable GitHub Release identity verified by the acquisition backend. */
export interface ProfileVerifiedReleaseSource {
  readonly schemaVersion: 1
  readonly type: 'githubRelease'
  readonly owner: string
  readonly repo: string
  readonly tag: string
  readonly asset: string
  readonly assetId: number
  readonly packageName: string
  readonly version: string
  readonly size: number
  readonly sha256: string
  readonly integrity?: string
  readonly targetCommit: string
  readonly dependencyRegistry?: string
  readonly checksumManifest?: {
    readonly format: 'sha256sums'
    readonly asset: string
    readonly assetId: number
    readonly url: string
    readonly size: number
    readonly sha256: string
    readonly integrity?: string
  }
}

/** Durable staging outcome, not an active receipt or proof of runtime health. */
export interface ProfilePreparedPackageChange {
  readonly transactionId: string
  readonly state: 'prepared'
  readonly packageName: string
  readonly baseFingerprint: string
  readonly health: 'pending' | 'passed'
}

/** Versioned pending selection of installed bundles; no package acquisition or activation is implied. */
export interface ProfilePreparedBundleSelection {
  readonly schemaVersion: 2
  readonly kind: 'selection'
  readonly transactionId: string
  readonly state: 'prepared'
  readonly packageNames: readonly string[]
  readonly baseFingerprint: string
  readonly health: 'pending' | 'passed'
}

/** Read-only pending inventory preserves legacy package preparations and explicit multi-bundle selections. */
export type ProfilePendingPackageChange = ProfilePreparedPackageChange | ProfilePreparedBundleSelection
