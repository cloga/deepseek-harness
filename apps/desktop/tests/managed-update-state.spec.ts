import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDesktopManagedUpdateConfiguration } from '../src/managed-update-state.ts'
import { completeDesktopManagedUpdate } from '../src/managed-update-completion.ts'
import { managedCapability } from './managed-update-fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ resources: string; userData: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-state-'))
  roots.push(root)
  const resources = join(root, 'resources')
  const userData = join(root, 'user-data')
  await mkdir(join(resources, 'managed-update'), { recursive: true })
  await writeFile(join(resources, 'managed-update', 'capability.json'), JSON.stringify(managedCapability()))
  await writeFile(join(resources, 'managed-update', 'helper.mjs'), 'export {}\n')
  return { resources, userData }
}

describe('managed update configuration', () => {
  it('selects the packaged Windows capability without claiming a fresh installation was completed', async () => {
    const { resources, userData } = await fixture()
    const configuration = await loadDesktopManagedUpdateConfiguration(resources, userData, 'win32')
    expect(configuration).toMatchObject({
      installedSequence: 2,
      completedSequence: 0,
      capability: { mode: 'github-release-managed' },
    })
    if (configuration === undefined) throw new Error('Fixture must select managed updates')
    await expect(completeDesktopManagedUpdate(
      configuration.operationsRoot, configuration.completionPath, configuration.capability, configuration.completedSequence,
      join(resources, 'unused.exe'), join(resources, 'unused-runtime.json'),
      join(resources, 'unused-plan.json'), join(userData, 'unused-profile'),
    )).resolves.toEqual({ status: 'none' })
    await expect(readFile(configuration.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('advances beyond the packaged sequence only after durable completion', async () => {
    const { resources, userData } = await fixture()
    await mkdir(join(userData, 'managed-update'), { recursive: true })
    await writeFile(join(userData, 'managed-update', 'completion.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      sequence: 3,
      manifestSha256: 'a'.repeat(64),
    }))
    await expect(loadDesktopManagedUpdateConfiguration(resources, userData, 'win32')).resolves.toMatchObject({
      installedSequence: 3,
      completedSequence: 3,
    })
  })

  it('rejects simultaneous native and managed updater configuration', async () => {
    const { resources, userData } = await fixture()
    await writeFile(join(resources, 'app-update.yml'), 'provider: generic\n')
    await expect(loadDesktopManagedUpdateConfiguration(resources, userData, 'win32'))
      .rejects.toThrow(/cannot both be enabled/u)
  })
})
