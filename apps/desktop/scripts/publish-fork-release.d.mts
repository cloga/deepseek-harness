/**
 * Publish a newly owned fork release after verifying local bytes, draft identity, tag and every remote asset.
 * Failed or uncertain writes stop without retrying, deleting remote objects or moving tags.
 * @param options - Reviewed workflow inputs, passed token and optional offline fetch implementation.
 * @returns Verified immutable release and manifest URLs; no output is returned on partial publication.
 */
export function publishForkRelease(options: {
  repository: string
  sourceSha: string
  tag: string
  version: string
  assetsDirectory: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<{ release_url: string; manifest_url: string }>
