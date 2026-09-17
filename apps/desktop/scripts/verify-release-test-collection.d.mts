/**
 * Require disjoint discovered split collections whose union is the unchanged baseline.
 * @param baseline - Project-qualified root-configuration file identities.
 * @param ordinary - Discovered files under the release config.
 * @param transactions - Discovered exact transaction-file selection.
 */
export function assertReleaseTestCollection(baseline: string[], ordinary: string[], transactions: string[]): void
