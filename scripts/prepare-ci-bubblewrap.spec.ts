import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./prepare-ci-bubblewrap.sh', import.meta.url), 'utf8')

describe('CI bubblewrap payload', () => {
  it('downloads the pinned Ubuntu version from its official archival location', () => {
    expect(source).toContain("readonly BUBBLEWRAP_VERSION='0.9.0-1ubuntu0.1'")
    expect(source).toContain('readonly BUBBLEWRAP_URL="https://launchpad.net/ubuntu/+archive/primary/+files/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"')
    expect(source).not.toContain('https://archive.ubuntu.com/')
  })

  it('fails closed on download or integrity failure before extracting the unchanged payload', () => {
    expect(source).toContain('set -euo pipefail')
    expect(source).toContain("readonly BUBBLEWRAP_SHA256='1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a'")
    const download = source.indexOf('curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$BUBBLEWRAP_URL"')
    const checksum = source.indexOf('printf \'%s  %s\\n\' "$BUBBLEWRAP_SHA256" "$archive" | sha256sum --check --status')
    const extraction = source.indexOf('dpkg-deb --extract "$archive" "$root"')
    expect(download).toBeGreaterThanOrEqual(0)
    expect(checksum).toBeGreaterThan(download)
    expect(extraction).toBeGreaterThan(checksum)
  })

  it('retains the Linux architecture guard and required confinement probe', () => {
    expect(source).toContain('if [[ "$(uname -s)" != \'Linux\' || "$(uname -m)" != \'x86_64\' ]]; then')
    expect(source).toContain('"$root/usr/bin/bwrap" --version')
    expect(source).toContain('"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true')
    expect(source).not.toContain('apt-get')
    expect(source).not.toMatch(/--insecure|--no-check-certificate/)
  })
})
