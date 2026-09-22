/** Narrow shell-owned authorization for the fixed packaged baseline before any Host spawn. */
export interface DesktopStartupPackageConsent {
  readonly transactionId: string
  readonly startupTransactionId?: string
  readonly initialRecovery: boolean
  readonly everStartedHost: boolean
  readonly hostPresent: boolean
  readonly recoveryTransactionIds: readonly string[]
  readonly privateProvisioning: boolean
  readonly preparedPlanSha256?: string
  readonly packagedPlanSha256?: string
}

/**
 * Decide whether ordinary native confirmation may be omitted for initial provisioning.
 * The backend already binds the private purpose, immutable source and raw plan resource;
 * this helper grants no staging authority and is not available through Host IPC.
 * @param input - Shell lifecycle facts and validated backend-private plan identity.
 * @returns True only for the exact startup transaction before the first attempted spawn.
 */
export function mayAuthorizeDesktopStartupPackage(input: DesktopStartupPackageConsent): boolean {
  return input.initialRecovery && !input.everStartedHost && !input.hostPresent
    && input.startupTransactionId === input.transactionId
    && input.recoveryTransactionIds.length === 0
    && input.privateProvisioning
    && input.packagedPlanSha256 !== undefined
    && /^[a-f0-9]{64}$/u.test(input.packagedPlanSha256)
    && input.preparedPlanSha256 === input.packagedPlanSha256
}
