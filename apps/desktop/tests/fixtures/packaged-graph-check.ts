/** Read-only graph verification under the packaged Node, without source-runner module paths. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { validateDesktopPluginGraph } from '../../src/profile-packages.ts'
import { readDesktopRuntime } from '../../src/runtime-tree.ts'

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

if (import.meta.main) {
  const [profile, runtimeRoot, ...plugins] = process.argv.slice(2)
  assert(profile && runtimeRoot && plugins.length > 0, 'Profile, runtime and plugin names are required')
  assert(isAbsolute(profile) && isAbsolute(runtimeRoot), 'Profile and runtime must be absolute')
  const observation = inspectPackagedGraphResolution(profile)
  const runtimeSha256 = createHash('sha256')
    .update(readFileSync(join(runtimeRoot, 'desktop-runtime.json'))).digest('hex')
  try {
    validateDesktopPluginGraph(profile, runtimeRoot, readDesktopRuntime(runtimeRoot), plugins)
    console.log(JSON.stringify({ valid: true, runtimeSha256, ...observation }))
  } catch (error) {
    console.log(JSON.stringify({ valid: false, runtimeSha256, ...observation, error: String(error) }))
    process.exitCode = 1
  }
}
