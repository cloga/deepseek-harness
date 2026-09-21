/** Admit only independently reviewed Copilot source/Client pairs, including retained alpha.33 history. */
import assert from 'node:assert/strict'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'

const reviewedCopilot33: DesktopGithubReleasePluginSource = {
  schemaVersion: 1,
  type: 'githubRelease',
  owner: 'cloga',
  repo: 'dsh-github-copilot',
  tag: 'v0.4.0-alpha.33',
  asset: 'dsh-github-copilot-0.4.0-alpha.33.tgz',
  assetId: 578199183,
  packageName: 'dsh-github-copilot',
  version: '0.4.0-alpha.33',
  size: 724820,
  sha256: 'b293d40351f2e732969bac88c3906280b50c47a011bbeac1dc68bc4a8b0de480',
  integrity: 'sha512-fMONh2Thsu3YTv26DnGWFDlNg2vx3tYE6Cqm4/Aq5LmLwJo71weRZHTkJpRnenDbWkzcu4yNmk7u+GUJxb0bQw==',
  targetCommit: 'aa90fe434da8b2172faa1446afa0a0fd006afe00',
  dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
  checksumManifest: {
    format: 'sha256sums',
    asset: 'SHA256SUMS',
    assetId: 578199206,
    url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.33/SHA256SUMS',
    size: 104,
    sha256: 'f81df10b7fd6e40b2319a42de1f04c3b7f7eccc57809b51623c9145f2a3df076',
    integrity: 'sha512-KFNap+UgDynhZycHuHOdd/hbPL/0VR+AdKPP6cebS5IENSJG+g4zo4NtGoCpWMTrTEgqvrlyWCK4MZkzjtzeDQ==',
  },
}

const reviewedCopilot35: DesktopGithubReleasePluginSource = {
  schemaVersion: 1, type: 'githubRelease', owner: 'cloga', repo: 'dsh-github-copilot',
  tag: 'v0.4.0-alpha.35', asset: 'dsh-github-copilot-0.4.0-alpha.35.tgz', assetId: 579078676,
  packageName: 'dsh-github-copilot', version: '0.4.0-alpha.35', size: 705000,
  sha256: 'ec4f0fa24b45d94686a396b2558ef6b7fc5d521b9d94e65dcff9f772421f496d',
  integrity: 'sha512-WCKmOsgXN1z/UuxJqKPp42VbCR9z/nPAWVvIReB0jjtU0144xu1nSn8toDxJ9q9Ij656vxLV35pPHbFwbo1qeA==',
  targetCommit: '6554417dc9a7544865e6c1bbdebf8b9a10e0a7af', dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
  checksumManifest: {
    format: 'sha256sums', asset: 'SHA256SUMS', assetId: 579078699,
    url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.35/SHA256SUMS', size: 104,
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
  const reviewed = source.version === '0.4.0-alpha.35' ? reviewedCopilot35 : reviewedCopilot33
  const clientSha256 = source.version === '0.4.0-alpha.35'
    ? '7b4566ef30e1c3c11e64aee527cea8bc5adbf0f22ca356cc8bd3ab07661fd368'
    : '6d6a7df36c377b7485b31d45511a8b582f5b745a1030a7f6e4c35a181ad52435'
  assert.deepEqual(source, reviewed, 'Positive usage requires an exact reviewed Copilot source')
  assert.equal(installedClientSha256, clientSha256, 'Positive usage requires the original reviewed Copilot Client bytes')
}
