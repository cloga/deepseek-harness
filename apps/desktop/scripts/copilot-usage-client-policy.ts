/** Admit only the independently reviewed Copilot alpha.35 source and original Client bytes. */
import assert from 'node:assert/strict'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'

const reviewedCopilot35: DesktopGithubReleasePluginSource = {
  schemaVersion: 1,
  type: 'githubRelease',
  owner: 'cloga',
  repo: 'dsh-github-copilot',
  tag: 'v0.4.0-alpha.35',
  asset: 'dsh-github-copilot-0.4.0-alpha.35.tgz',
  assetId: 579078676,
  packageName: 'dsh-github-copilot',
  version: '0.4.0-alpha.35',
  size: 705000,
  sha256: 'ec4f0fa24b45d94686a396b2558ef6b7fc5d521b9d94e65dcff9f772421f496d',
  integrity: 'sha512-WCKmOsgXN1z/UuxJqKPp42VbCR9z/nPAWVvIReB0jjtU0144xu1nSn8toDxJ9q9Ij656vxLV35pPHbFwbo1qeA==',
  targetCommit: '6554417dc9a7544865e6c1bbdebf8b9a10e0a7af',
  dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
  checksumManifest: {
    format: 'sha256sums',
    asset: 'SHA256SUMS',
    assetId: 579078699,
    url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.35/SHA256SUMS',
    size: 104,
    sha256: '51930bf90fd22b04813494b301951b681a1b82a622351e93152f06ad8d3b93ab',
    integrity: 'sha512-X41UN3az6uzTTWAC1q9kZJ9XGTKdBulYuStmzW4GaCIYt9+5MGAcp+D0hyvOJ8pZkdrdetFI9fzPB1nrbIzysA==',
  },
}

/**
 * Require the reviewed immutable source tuple and original lib/client.js digest, not merely a valid hash string.
 * @param source - Validated release-owned package source, including its checksum and registry locks.
 * @param installedClientSha256 - SHA-256 measured from the original installed Client file bytes.
 */
export function assertReviewedCopilotUsageClient(source: DesktopGithubReleasePluginSource, installedClientSha256: string): void {
  assert.deepEqual(source, reviewedCopilot35, 'Positive usage requires the reviewed Copilot alpha.35 source')
  assert.equal(installedClientSha256, '7b4566ef30e1c3c11e64aee527cea8bc5adbf0f22ca356cc8bd3ab07661fd368',
    'Positive usage requires the original reviewed Copilot alpha.35 Client bytes')
}
