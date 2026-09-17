import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { observeFixturePnpm } from './pnpm-fixture-observer.ts'

it('records synthetic root lock leaves before process exit without logging unrelated values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pnpm-observer-'))
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const name = 'fixture-plugin'
    const specifier = 'file:.desktop-plugin-artifacts/test.tgz'
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: specifier, unrelated: 'DO_NOT_REPORT' } }))
    writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify({
      importers: { '.': { dependencies: { [name]: { specifier, version: specifier }, unrelated: { version: 'DO_NOT_REPORT' } } } },
      packages: {
        [`${name}@${specifier}`]: { version: '1.0.0', resolution: { tarball: specifier, integrity: 'fixture-integrity' } },
        unrelated: { private: 'DO_NOT_REPORT' },
      },
      unused: 'DO_NOT_REPORT',
    }))
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'dist'))
    const fake = join(root, 'bin', 'pnpm.mjs')
    const entrySource = "await import('../dist/pnpm.mjs')\n"
    const distSource = 'process.exitCode = 1\n'
    writeFileSync(fake, entrySource)
    writeFileSync(join(root, 'dist', 'pnpm.mjs'), distSource)
    const observer = observeFixturePnpm(root, fake, name)
    const code = await new Promise<string | number | null | undefined>((resolve) => {
      execFile(process.execPath, [observer.entry, 'install'], { cwd: root }, (error) => { resolve(error?.code) })
    })
    expect(code).toBe(1)
    expect(report).not.toHaveBeenCalled()
    observer.reportFailure()
    expect(report).toHaveBeenCalledOnce()
    const text = String(report.mock.calls[0]?.[0])
    const software: unknown = JSON.parse(text.split('\n')[1] ?? 'null')
    expect(software).toMatchObject({
      kind: 'software', node: process.version,
      pnpmEntrySha256: createHash('sha256').update(entrySource).digest('hex'),
      pnpmDistSha256: createHash('sha256').update(distSource).digest('hex'),
    })
    expect(software).toHaveProperty('nodeExecutable')
    expect(software).toHaveProperty('pnpmEntry')
    expect(software).toHaveProperty('pnpmDist')
    expect(text).toContain('"cwd":"<fixture>"')
    expect(text).toContain('"command":"install"')
    expect(text).toContain('"specifier":"file:.desktop-plugin-artifacts/test.tgz"')
    expect(text).toContain('"integrity":"fixture-integrity"')
    expect(text).not.toContain('DO_NOT_REPORT')
    expect(text).not.toContain(root)
  } finally {
    report.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
