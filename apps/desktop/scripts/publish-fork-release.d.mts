/**
 * Publish a newly owned fork release bound to this checkout's fixed reviewed release plan.
 * Verify the exact version, channel, upstream, sequence and plan-byte digests before any remote request.
 * Local bytes, owned draft, tag and every remote asset are verified before publication and again afterward.
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
