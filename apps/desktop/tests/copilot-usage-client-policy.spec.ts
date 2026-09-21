import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertReviewedCopilotUsageClient } from '../scripts/copilot-usage-client-policy.ts'
import { parseDesktopForkReleasePlan } from '../scripts/fork-release.ts'

const clientSha256 = '7b4566ef30e1c3c11e64aee527cea8bc5adbf0f22ca356cc8bd3ab07661fd368'
function reviewedSource() {
  const value: unknown = JSON.parse(readFileSync(resolve('apps/desktop/release/cloga-windows-x64.json'), 'utf8'))
  const entry = parseDesktopForkReleasePlan(value).desktopProvisioning.plugins.find(item => item.source.packageName === 'dsh-github-copilot')
  if (entry === undefined) throw new Error('Reviewed plan must retain Copilot')
  return entry.source
}

describe('independently reviewed Copilot positive-usage Client policy', () => {
  it('admits the reviewed source only with the original alpha.35 Client digest', () => {
    expect(() => { assertReviewedCopilotUsageClient(reviewedSource(), clientSha256) }).not.toThrow()
  })

  it.each(['', '0'.repeat(64), '6d6a7df36c377b7485b31d45511a8b582f5b745a1030a7f6e4c35a181ad52435', clientSha256.toUpperCase(), clientSha256 + '\n'])('rejects an unreviewed Client digest %s', (digest) => {
    expect(() => { assertReviewedCopilotUsageClient(reviewedSource(), digest) }).toThrow('original reviewed')
  })

  it.each([
    { schemaVersion: 2 }, { type: 'npmRegistry' }, { owner: 'other' }, { repo: 'other' },
    { tag: 'v0.4.0-alpha.32' }, { asset: 'other.tgz' }, { assetId: 1 }, { packageName: 'other' },
    { version: '0.4.0-alpha.32' }, { size: 1 }, { sha256: '0'.repeat(64) }, { integrity: 'unreviewed' },
    { targetCommit: '0'.repeat(40) }, { dependencyRegistry: 'https://registry.npmjs.org/' },
  ])('rejects a changed reviewed source leaf %j', (change) => {
    // Object.assign deliberately supplies invalid durable data to the same typed policy; no success override exists.
    const source = Object.assign(reviewedSource(), change)
    expect(() => { assertReviewedCopilotUsageClient(source, clientSha256) }).toThrow('reviewed Copilot alpha.35 source')
  })

  it.each([
    { format: 'other' }, { asset: 'other' }, { assetId: 1 }, { url: 'https://example.com/SHA256SUMS' },
    { size: 1 }, { sha256: '0'.repeat(64) }, { integrity: 'unreviewed' },
  ])('rejects a changed checksum attestation %j', (change) => {
    const source = reviewedSource()
    const changed = Object.assign({}, source, { checksumManifest: Object.assign({}, source.checksumManifest, change) })
    expect(() => { assertReviewedCopilotUsageClient(changed, clientSha256) }).toThrow('reviewed Copilot alpha.35 source')
  })

  it.each(['integrity', 'checksumManifest', 'dependencyRegistry'] as const)('rejects missing %s attestation', (field) => {
    const source = reviewedSource()
    Reflect.deleteProperty(source, field)
    expect(() => { assertReviewedCopilotUsageClient(source, clientSha256) }).toThrow('reviewed Copilot alpha.35 source')
  })
})
