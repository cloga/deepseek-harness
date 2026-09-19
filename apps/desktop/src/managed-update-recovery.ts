/** Packaged entry point for rechecking managed-update evidence without resetting the profile. */

/** Command-line switch routed to the owning Electron instance. */
export const MANAGED_UPDATE_RECOVERY_ARGUMENT = '--recover-managed-update'

/**
 * Build a PowerShell command for the installed executable, not an unshipped recovery script.
 * @param executable - Absolute path of the running installed Desktop executable.
 * @returns Command that opens the native recovery flow in the owning instance.
 */
export function managedUpdateRecoveryCommand(executable: string): string {
  return `& '${executable.replaceAll("'", "''")}' ${MANAGED_UPDATE_RECOVERY_ARGUMENT}`
}
