/** Read-only acceptance assertions over the official profile generation and owned package manifests. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { satisfies, validRange } from 'semver'

const NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/

function inside(root, path) {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function metadata(directory) {
  const path = join(directory, 'package.json')
  const stat = lstatSync(path)
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Package manifest must be a regular file')
  assert(inside(realpathSync(directory), realpathSync(path)), 'Package manifest escapes its package directory')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  assert(record(value), 'Invalid package manifest')
  return value
}

function dependencyMap(manifest, field) {
  const value = manifest[field]
  if (value === undefined) return {}
  assert(record(value), `${manifest.name} has an invalid ${field} map`)
  for (const [name, range] of Object.entries(value)) {
    assert.match(name, NAME)
    assert(typeof range === 'string' && range.length > 0, `${manifest.name} has an invalid ${field} selector`)
  }
  return value
}

function physicalPackage(anchor, name, profileRoot) {
  for (const search of createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []) {
    // Ancestor and NODE_PATH positions cannot precede the launcher's selected fallback.
    if (!inside(profileRoot, search)) break
    const candidate = join(search, name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  return undefined
}

/**
 * Resolve app-boot without executing an ancestor or runner-provided implementation.
 * @param {string} runtimeRoot - Verified ASAR-backed runtime root.
 * @returns {string} Canonical entry confined to the runtime's app-boot package.
 */
export function resolvePackagedAppBoot(runtimeRoot) {
  const root = realpathSync(runtimeRoot)
  const packageRoot = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))
  assert(inside(root, packageRoot), 'Packaged app-boot escapes the runtime')
  assert.equal(metadata(packageRoot).name, '@deepseek-ai/dsh-app-boot')
  const anchor = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const entry = realpathSync(createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot'))
  assert(inside(packageRoot, entry), 'Resolved app-boot entry escapes its packaged provider')
  return entry
}

/**
 * Check owned identities and semver requirements using the Host's read-only generation constructor.
 * Tag and transport selectors are not re-resolved; package loading and lock integrity have separate acceptance.
 * @param {object} input - Exact profile, runtime descriptor, plugin roots, and real app-boot helpers.
 * @returns {Promise<void>} Resolves when the scoped inventory satisfies ownership and declared semver ranges.
 */
export async function assertPackagedGraphInventory({ profile, runtimeRoot, runtime, plugins, loadProfileDirectory, createProfileResolutionGeneration }) {
  const profileRoot = realpathSync(profile)
  const installationRoot = realpathSync(runtimeRoot)
  assert(plugins.length > 0, 'Active plugin names are required')
  const roots = plugins.map(name => {
    assert.match(name, NAME)
    const path = join(profileRoot, 'node_modules', name)
    assert(existsSync(join(path, 'package.json')), `missing local plugin ${name}`)
    const canonical = realpathSync(path)
    assert(inside(profileRoot, canonical), `active plugin ${name} is outside its owned packages`)
    assert.equal(metadata(canonical).name, name, `active plugin ${name} has a different package identity`)
    return canonical
  })
  const installAnchor = join(installationRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const loaded = loadProfileDirectory('packaged graph acceptance', profileRoot, installAnchor)
  const generation = await createProfileResolutionGeneration({ installAnchor, profile: loaded })
  const shared = new Map(runtime.sharedPackages.map(entry => [entry.name, entry]))
  const installation = new Map()
  const profileFallback = new Map()
  for (const entry of generation.entries) {
    const path = realpathSync(entry.packageDir)
    if (entry.scope === 'installation') {
      assert(inside(installationRoot, entry.packageDir) && inside(installationRoot, path), `runtime package ${entry.name} is outside its sealed runtime`)
      assert.equal(metadata(path).version, entry.version, `runtime package ${entry.name} differs from its generation`)
      installation.set(entry.name, path)
    } else if (entry.scope === 'profile' && inside(profileRoot, entry.packageDir) && inside(profileRoot, path)) {
      profileFallback.set(entry.name, path)
    }
  }
  for (const [name, entry] of shared) {
    const path = installation.get(name)
    assert(path !== undefined, `runtime generation is missing shared package ${name}`)
    assert(typeof entry.path === 'string' && !isAbsolute(entry.path) && !entry.path.includes('\\') && !entry.path.includes(':')
      && entry.path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Invalid shared provider path')
    const expected = realpathSync(join(installationRoot, ...entry.path.split('/')))
    assert(inside(installationRoot, expected), `shared provider ${name} escapes its runtime`)
    assert.equal(path, expected, `runtime shared package ${name} differs from its descriptor provider`)
    const manifest = metadata(path)
    assert.equal(manifest.name, name)
    assert.equal(manifest.version, entry.version, `runtime shared package ${name} differs from its descriptor`)
  }
  const queue = [...roots]
  const visited = new Set()
  while (queue.length > 0) {
    const directory = queue.shift()
    if (visited.has(directory)) continue
    visited.add(directory)
    assert(visited.size <= 10000, 'Profile graph exceeds the acceptance inventory bound')
    const manifest = metadata(directory)
    assert(!shared.has(manifest.name), 'Profile graph contains a private duplicate of a runtime shared package')
    const dependencies = dependencyMap(manifest, 'dependencies')
    const optional = dependencyMap(manifest, 'optionalDependencies')
    const peers = dependencyMap(manifest, 'peerDependencies')
    assert(manifest.peerDependenciesMeta === undefined || record(manifest.peerDependenciesMeta), 'Invalid peer metadata map')
    const edges = [
      ...Object.entries(dependencies).filter(([name]) => !Object.hasOwn(optional, name)).map(([name, range]) => ({ name, range, peer: false, optional: false })),
      ...Object.entries(optional).map(([name, range]) => ({ name, range, peer: false, optional: true })),
      ...Object.entries(peers).map(([name, range]) => ({ name, range, peer: true, optional: manifest.peerDependenciesMeta?.[name]?.optional === true })),
    ]
    for (const edge of edges) {
      const sharedPeer = shared.get(edge.name)
      if (edge.peer && sharedPeer !== undefined) {
        assert(satisfies(sharedPeer.version, edge.range), `${manifest.name} requires ${edge.name}@${edge.range}, found ${sharedPeer.version}`)
      }
      const physical = physicalPackage(directory, edge.name, profileRoot)
      let target
      if (physical !== undefined && !inside(profileRoot, physical) && !inside(installationRoot, physical)) {
        if (edge.optional) continue
        assert.fail(`${manifest.name} resolves ${edge.name} outside its owned packages`)
      }
      if (physical !== undefined && inside(profileRoot, physical)) {
        assert(!shared.has(edge.name), `private duplicate of runtime shared package ${edge.name}`)
        target = physical
      } else if (physical !== undefined && inside(installationRoot, physical)) {
        assert.equal(physical, installation.get(edge.name), `unselected runtime package ${edge.name}`)
        target = physical
      } else if (installation.has(edge.name)) {
        target = installation.get(edge.name)
      } else if (profileFallback.has(edge.name)) {
        assert(!shared.has(edge.name), `private duplicate of runtime shared package ${edge.name}`)
        target = profileFallback.get(edge.name)
      } else {
        if (edge.optional) continue
        assert.fail(`${manifest.name} resolves ${edge.name} outside its owned packages`)
      }
      let expectedName = edge.name
      let range = edge.range
      if (!edge.peer && range.startsWith('npm:')) {
        const alias = /^npm:((?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9][A-Za-z0-9._~-]*)(?:@(.+))?$/.exec(range)
        assert(alias !== null, `Invalid npm alias ${range}`)
        expectedName = alias[1]
        range = alias[2] ?? 'latest'
      }
      const targetManifest = metadata(target)
      assert.equal(targetManifest.name, expectedName, `${manifest.name} resolves ${edge.name} to a different package identity`)
      if (edge.peer || validRange(range) !== null) {
        assert(typeof targetManifest.version === 'string' && satisfies(targetManifest.version, range),
          `${manifest.name} requires ${edge.name}@${range}, found ${String(targetManifest.version)}`)
      }
      if (inside(profileRoot, target)) queue.push(target)
    }
  }
}
