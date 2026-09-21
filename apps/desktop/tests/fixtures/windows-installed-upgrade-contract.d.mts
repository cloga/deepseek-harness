/** Read-only finalized installer verification shared with the CI qualification verifier. */

/**
 * Verify original installer and receipt bytes against reviewed source identity and canonical self-hashes.
 * @param directory - Acquired release directory; this operation never executes the installer.
 * @param expected - Reviewed source, versions and optional independently pinned raw manifest digest.
 * @param jsonHash - Maintained canonical JSON hash function, distinct from raw file hashing.
 * @returns Verified file locations and original manifest JSON; callers still parse the complete manifest schema.
 */
export function verifyUpgradeRelease(
  directory: string,
  expected: { commit: string; version: string; upstreamVersion: string; manifestSha256?: string },
  jsonHash: (value: unknown) => string,
): { manifest: Record<string, unknown>; installer: string; manifestPath: string; manifestFileSha256: string }
