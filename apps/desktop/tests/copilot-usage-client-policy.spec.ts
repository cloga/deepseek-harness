import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertReviewedCopilotUsageClient } from '../scripts/copilot-usage-client-policy.ts'
import { parseDesktopForkReleasePlan } from '../scripts/fork-release.ts'

const digests = {
  33: '6d6a7df36c377b7485b31d45511a8b582f5b745a1030a7f6e4c35a181ad52435',
  35: '7b4566ef30e1c3c11e64aee527cea8bc5adbf0f22ca356cc8bd3ab07661fd368',
} as const
function reviewedSource(version: 33 | 35) {
  const value: unknown = JSON.parse(readFileSync(resolve('apps/desktop/release/cloga-windows-x64.json'), 'utf8'))
  const entry = parseDesktopForkReleasePlan(value).desktopProvisioning.plugins.find(item => item.source.packageName === 'dsh-github-copilot')
  if (entry === undefined) throw new Error('Reviewed plan must retain Copilot')
  if (version === 35) return entry.source
  // Retain the independently reviewed original alpha33 tuple as historical policy evidence, not the current plan.
  return { ...entry.source,
    tag: 'v0.4.0-alpha.33', asset: 'dsh-github-copilot-0.4.0-alpha.33.tgz', assetId: 578199183,
    version: '0.4.0-alpha.33', size: 724820, sha256: 'b293d40351f2e732969bac88c3906280b50c47a011bbeac1dc68bc4a8b0de480',
    integrity: 'sha512-fMONh2Thsu3YTv26DnGWFDlNg2vx3tYE6Cqm4/Aq5LmLwJo71weRZHTkJpRnenDbWkzcu4yNmk7u+GUJxb0bQw==',
    targetCommit: 'aa90fe434da8b2172faa1446afa0a0fd006afe00', checksumManifest: {
      format: 'sha256sums' as const, asset: 'SHA256SUMS', assetId: 578199206,
      url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.33/SHA256SUMS', size: 104,
      sha256: 'f81df10b7fd6e40b2319a42de1f04c3b7f7eccc57809b51623c9145f2a3df076',
      integrity: 'sha512-KFNap+UgDynhZycHuHOdd/hbPL/0VR+AdKPP6cebS5IENSJG+g4zo4NtGoCpWMTrTEgqvrlyWCK4MZkzjtzeDQ==',
    },
  }
}

describe.each([33, 35] as const)('independently reviewed Copilot alpha%s original-Client policy', (version) => {
  const clientSha256 = digests[version]
  it('admits only its complete reviewed tuple and original Client digest', () => {
    expect(() => { assertReviewedCopilotUsageClient(reviewedSource(version), clientSha256) }).not.toThrow()
    expect(() => { assertReviewedCopilotUsageClient(reviewedSource(version), digests[version === 35 ? 33 : 35]) }).toThrow('original reviewed')
  })
  it.each(['', '0'.repeat(64), clientSha256.toUpperCase(), clientSha256 + '\n'])('rejects an unreviewed Client digest %s', (digest) => {
    expect(() => { assertReviewedCopilotUsageClient(reviewedSource(version), digest) }).toThrow('original reviewed')
  })
  it.each([
    { schemaVersion: 2 }, { type: 'npmRegistry' }, { owner: 'other' }, { repo: 'other' },
    { tag: 'v0.4.0-alpha.32' }, { asset: 'other.tgz' }, { assetId: 1 }, { packageName: 'other' },
    { version: '0.4.0-alpha.32' }, { size: 1 }, { sha256: '0'.repeat(64) }, { integrity: 'unreviewed' },
    { targetCommit: '0'.repeat(40) }, { dependencyRegistry: 'https://registry.npmjs.org/' },
  ])('rejects a changed reviewed source leaf %j', (change) => {
    const source = Object.assign(reviewedSource(version), change)
    expect(() => { assertReviewedCopilotUsageClient(source, clientSha256) }).toThrow('exact reviewed Copilot source')
  })
  it.each([
    { format: 'other' }, { asset: 'other' }, { assetId: 1 }, { url: 'https://example.com/SHA256SUMS' },
    { size: 1 }, { sha256: '0'.repeat(64) }, { integrity: 'unreviewed' },
  ])('rejects a changed checksum attestation %j', (change) => {
    const source = reviewedSource(version)
    const changed = Object.assign({}, source, { checksumManifest: Object.assign({}, source.checksumManifest, change) })
    expect(() => { assertReviewedCopilotUsageClient(changed, clientSha256) }).toThrow('exact reviewed Copilot source')
  })
  it.each(['integrity', 'checksumManifest', 'dependencyRegistry'] as const)('rejects missing %s attestation', (field) => {
    const source = reviewedSource(version)
    Reflect.deleteProperty(source, field)
    expect(() => { assertReviewedCopilotUsageClient(source, clientSha256) }).toThrow('exact reviewed Copilot source')
  })
})
