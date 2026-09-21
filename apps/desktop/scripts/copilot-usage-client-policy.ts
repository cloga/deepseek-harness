/** Admit only the independently reviewed Copilot alpha.33 source and original Client bytes. */
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

/**
 * Require the reviewed immutable source tuple and original lib/client.js digest, not merely a valid hash string.
 * @param source - Validated release-owned package source, including its checksum and registry locks.
 * @param installedClientSha256 - SHA-256 measured from the original installed Client file bytes.
 */
export function assertReviewedCopilotUsageClient(source: DesktopGithubReleasePluginSource, installedClientSha256: string): void {
  assert.deepEqual(source, reviewedCopilot33, 'Positive usage requires the reviewed Copilot alpha.33 source')
  assert.equal(installedClientSha256, '6d6a7df36c377b7485b31d45511a8b582f5b745a1030a7f6e4c35a181ad52435',
    'Positive usage requires the original reviewed Copilot alpha.33 Client bytes')
}
