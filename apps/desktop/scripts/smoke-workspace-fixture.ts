/** Run offline browser acceptance against built workspace packages in a disposable Desktop runtime. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import type { DesktopRuntimeDescriptor, DesktopSharedPackage } from '../src/runtime-tree.ts'
import { prepareDevelopmentProject } from './development-project.ts'
import { smokeDesktopRuntime } from './smoke-runtime.ts'

function sharedWorkspacePackages(root: string): DesktopSharedPackage[] {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  return readdirSync(scope).map((directory) => {
    const manifest = JSON.parse(readFileSync(join(scope, directory, 'package.json'), 'utf8')) as {
      name: string
      version: string
    }
    return { name: manifest.name, version: manifest.version, path: `node_modules/${manifest.name}` }
  })
}

/**
 * Exercise the built loader and Models page without an installed Desktop or real authentication service.
 * @param repository - Workspace containing the completed source build.
 * @returns Directory containing this run's successful screenshots and provenance.
 */
export async function runDesktopWorkspaceFixture(repository: string): Promise<string> {
  const repo = resolve(repository)
  for (const artifact of [
    join('apps', 'web', 'dist', 'index.html'),
    join('apps', 'desktop-host', 'lib', 'index.js'),
    join('packages', 'client', 'ui-settings-models', 'lib', 'client.js'),
  ]) {
    if (!existsSync(join(repo, artifact))) {
      throw new Error(`desktop fixture: missing ${artifact}; run node node_modules\\tsx\\dist\\cli.mjs scripts\\build.ts`)
    }
  }
  const scratch = join(repo, '.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const owned = mkdtempSync(join(scratch, 'workspace-'))
  const root = join(owned, 'runtime')
  const outputRoot = join(repo, 'output', 'desktop-provisioning-fixes')
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(join(outputRoot, 'neutral-fixture-'))
  let succeeded = false
  try {
    const { version } = JSON.parse(readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string }
    const { version: pnpmVersion } = JSON.parse(readFileSync(
      join(repo, 'apps', 'desktop', 'node_modules', 'pnpm', 'package.json'), 'utf8',
    )) as { version: string }
    const release = {
      schemaVersion: 1 as const,
      version,
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: process.versions.node,
      pnpmVersion,
    }
    prepareDevelopmentProject({
      projectDir: root,
      cliDir: join(repo, 'apps', 'cli'),
      hostDir: join(repo, 'apps', 'desktop-host'),
      dependencyDir: join(repo, 'node_modules', '.pnpm', 'node_modules'),
      release,
    })
    const runtime: DesktopRuntimeDescriptor = {
      schemaVersion: 1,
      release,
      platform: process.platform,
      arch: process.arch,
      sharedPackages: sharedWorkspacePackages(root),
      files: [],
    }
    await smokeDesktopRuntime(root, process.execPath, runtime, 'msedge', output, 'workspace-linked')
    writeFileSync(join(output, 'workspace-provenance.json'), JSON.stringify({
      repository: repo,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      dirtyWorktree: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() !== '',
      runtimeKind: 'workspace-linked',
      browser: 'isolated headless msedge',
      inspector: 'OS-assigned loopback port; no existing debugger attached',
      immutableAlpha19Gate: false,
      installedUnified016Gate: false,
      realAuthenticationService: false,
      realModelRound: false,
    }, undefined, 2) + '\n')
    succeeded = true
    return output
  } finally {
    removeOwnedDirectory(owned)
    if (!succeeded) removeOwnedDirectory(output)
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runDesktopWorkspaceFixture(resolve(import.meta.dirname, '..', '..', '..')).then(
    (output) => { console.log(`Neutral fixture browser acceptance passed: ${output}`) },
    (error: unknown) => { console.error(error); process.exitCode = 1 },
  )
}
