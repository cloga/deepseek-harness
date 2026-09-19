/** Bind the official standalone primary Node payload to the sealed Desktop runtime inventory. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDesktopRuntime } from './runtime-tree.ts'

const FILE = 'managed-update-node.json'
const NODE_PARTS = ['dependencies', 'node', 'bin', 'node.exe'] as const

interface NodeAttestation {
  readonly schemaVersion: 1
  readonly platform: 'win32'
  readonly arch: 'x64'
  readonly nodeVersion: string
  readonly bytes: number
  readonly sha256: string
}

function regularBytes(path: string, limit: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) {
    throw new Error('desktop managed update: invalid standalone Node resource')
  }
  return readFileSync(path)
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

/**
 * Record the existing official Node payload before sealing desktop-runtime.json.
 * @param runtime - Unsealed materialized dsh tree owned by packaging.
 * @param primaryRuntime - Official prepared primary runtime; never a user-managed interpreter.
 */
export function writeDesktopManagedNodeAttestation(runtime: string, primaryRuntime: string): void {
  const manifest = JSON.parse(regularBytes(join(primaryRuntime, 'runtime.json'), 1024 * 1024).toString('utf8')) as Record<string, unknown>
  const components = manifest.components as Record<string, unknown> | undefined
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || typeof components?.node !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(components.node)) throw new Error('desktop managed update: unsupported standalone Node target')
  const bytes = regularBytes(join(primaryRuntime, ...NODE_PARTS), 256 * 1024 * 1024)
  const record: NodeAttestation = { schemaVersion: 1, platform: 'win32', arch: 'x64', nodeVersion: components.node,
    bytes: bytes.byteLength, sha256: digest(bytes) }
  writeFileSync(join(runtime, FILE), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
}

/**
 * Validate both the sealed attestation and the standalone executable's actual bytes.
 * @param runtime - ASAR-backed dsh tree whose descriptor is bound by installed release evidence.
 * @param primaryRuntime - Fixed installed primary runtime path owned by the shell.
 * @returns Verified standalone Node path and expected hash for post-copy validation; never Electron.
 */
export function resolveDesktopManagedNode(runtime: string, primaryRuntime: string): { readonly path: string; readonly sha256: string } {
  const descriptor = readDesktopRuntime(runtime)
  if (descriptor.platform !== 'win32' || descriptor.arch !== 'x64') throw new Error('desktop managed update: Windows x64 is required')
  const content = regularBytes(join(runtime, FILE), 4096)
  const sealed = descriptor.files.filter(file => file.path === FILE)
  if (sealed.length !== 1 || sealed[0]?.bytes !== content.byteLength || sealed[0].sha256 !== digest(content)) {
    throw new Error('desktop managed update: standalone Node attestation is not sealed by the runtime')
  }
  const item = JSON.parse(content.toString('utf8')) as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'arch,bytes,nodeVersion,platform,schemaVersion,sha256'
    || item.schemaVersion !== 1 || item.platform !== 'win32' || item.arch !== 'x64'
    || typeof item.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(item.nodeVersion)
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
    || !Number.isSafeInteger(item.bytes)) throw new Error('desktop managed update: invalid standalone Node attestation')
  const node = join(primaryRuntime, ...NODE_PARTS)
  const bytes = regularBytes(node, 256 * 1024 * 1024)
  if (bytes.byteLength !== item.bytes || digest(bytes) !== item.sha256) {
    throw new Error('desktop managed update: standalone Node payload does not match the installed release')
  }
  return { path: node, sha256: item.sha256 }
}
