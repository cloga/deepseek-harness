/** Packaged Electron Node-mode graph acceptance; requires Desktop's built lib/types validators. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

function lookup(anchor: string | undefined, name: string) {
  if (anchor === undefined) return undefined
  const paths = createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []
  const candidate = paths.map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')))
  return { paths, target: candidate === undefined ? undefined : realpathSync.native(candidate) }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadata(directory: string | undefined): Record<string, unknown> | undefined {
  if (directory === undefined) return undefined
  const value: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  assert(record(value), 'Package metadata must be an object')
  return value
}

/**
 * Collect resolver observations, not an alternative graph acceptance decision.
 * @param profile - Exact active profile passed to the production validator.
 * @returns Runtime, search paths, optional peer declaration, and physical SDK target.
 */
export function inspectPackagedGraphResolution(profile: string) {
  const plugin = lookup(profile, 'dsh-github-copilot')
  const adapter = lookup(plugin?.target, '@earendil-works/pi-ai')
  const google = lookup(adapter?.target, '@google/genai')
  const sdk = lookup(google?.target, '@modelcontextprotocol/sdk')
  const googleMetadata = metadata(google?.target)
  const peers = googleMetadata?.peerDependencies
  const peerMetadata = googleMetadata?.peerDependenciesMeta
  const sdkPeerMetadata = record(peerMetadata) ? peerMetadata['@modelcontextprotocol/sdk'] : undefined
  return {
    executable: process.execPath,
    nodeVersion: process.versions.node,
    nodePath: process.env.NODE_PATH ?? null,
    nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
    cwd: process.cwd(),
    profile,
    google: {
      ...google,
      version: googleMetadata?.version,
      sdkPeerRange: record(peers) ? peers['@modelcontextprotocol/sdk'] : undefined,
      sdkPeerOptional: record(sdkPeerMetadata) && sdkPeerMetadata.optional === true,
    },
    sdk: { ...sdk, version: metadata(sdk?.target)?.version },
  }
}

/**
 * Launch the built production graph validator without TypeScript hooks or runner module overrides.
 * This checks the graph inventory, not module loading; the real Host acceptance owns that evidence.
 * @param profile - Absolute active Desktop profile.
 * @param runtimeRoot - Absolute ASAR-backed dsh directory visible to Electron's patched filesystem.
 * @param plugins - Active release-owned plugin names.
 * @returns Arguments for the packaged Electron executable with ELECTRON_RUN_AS_NODE=1.
 */
export function packagedGraphCheckArguments(profile: string, runtimeRoot: string, plugins: readonly string[]): string[] {
  assert(isAbsolute(profile) && isAbsolute(runtimeRoot), 'Profile and runtime must be absolute')
  assert(plugins.length > 0, 'Active plugin names are required')
  const validator = new URL('../../lib/types/profile-packages.js', import.meta.url).href
  const reader = new URL('../../lib/types/runtime-tree.js', import.meta.url).href
  const script = `
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateDesktopPluginGraph } from ${JSON.stringify(validator)}
import { readDesktopRuntime } from ${JSON.stringify(reader)}
const [profile, runtimeRoot, ...plugins] = process.argv.slice(1)
const observation = {
  executable: process.execPath,
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron ?? null,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  nodePath: process.env.NODE_PATH ?? null,
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
  electronNoAsarPresent: Boolean(process.env.ELECTRON_NO_ASAR),
  cwd: process.cwd(), profile, runtimeRoot, resolutionMode: 'runtime',
}
try {
  const runtimeSha256 = createHash('sha256').update(readFileSync(join(runtimeRoot, 'desktop-runtime.json'))).digest('hex')
  validateDesktopPluginGraph(profile, runtimeRoot, readDesktopRuntime(runtimeRoot), plugins, 'runtime')
  console.log(JSON.stringify({ valid: true, runtimeSha256, ...observation }))
} catch (error) {
  console.log(JSON.stringify({ valid: false, ...observation, error: String(error) }))
  process.exitCode = 1
}
`
  return ['--input-type=module', '--eval', script, profile, runtimeRoot, ...plugins]
}
