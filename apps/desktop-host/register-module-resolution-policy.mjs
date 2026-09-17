/** Restrict bare package resolution initiated by Desktop-managed plugin modules. */

import { existsSync, realpathSync } from 'node:fs'
import { isBuiltin, registerHooks } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEnvironmentData, isMainThread, setEnvironmentData } from 'node:worker_threads'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const ROOTS_KEY = '@deepseek-ai/dsh-desktop-host/module-resolution-policy'

function launchRoots() {
  const runtimeDir = process.argv[2]
  const profileDir = process.argv[3]
  if (runtimeDir === undefined || profileDir === undefined) {
    throw new Error('dsh desktop: module resolution policy requires runtime and profile directories')
  }
  return { schemaVersion: 1, runtimeDir: resolve(runtimeDir), profileDir: resolve(profileDir), home: resolveDshHome() }
}

const inherited = isMainThread ? launchRoots() : getEnvironmentData(ROOTS_KEY)
if (typeof inherited !== 'object' || inherited === null || Object.getPrototypeOf(inherited) !== Object.prototype
  || Object.keys(inherited).sort().join(',') !== 'home,profileDir,runtimeDir,schemaVersion'
  || inherited.schemaVersion !== 1
  || !['runtimeDir', 'profileDir', 'home'].every(key => typeof inherited[key] === 'string' && isAbsolute(inherited[key]))) {
  throw new Error('dsh desktop: module resolution policy requires valid inherited Worker roots')
}
// Workers inherit the launching Host's roots, not Worker task argv or environment overrides.
const roots = Object.freeze(inherited)
const { runtimeDir, profileDir, home } = roots
const runtimeRoot = realpathSync(runtimeDir)
const profileRoot = realpathSync(profileDir)
const profileModules = join(profileRoot, 'node_modules')

function inside(root, path) {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function canonicalScope(path) {
  try { return realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

// DSH 0.1.6 routes misses from the matched profilesDir, or the external profileDir,
// through dirname(scope)/package.json. DSH_HOME is bootstrap-only: .env cannot change it.
const profilesDir = join(home, 'profiles')
const profileScopes = [resolve(profilesDir), canonicalScope(profilesDir)]
const afterFallbackParents = new Set(profileScopes.map(scope => join(dirname(scope), 'package.json')))
for (const scope of [resolve(profileDir), profileRoot]) {
  if (!profileScopes.some(profiles => inside(profiles, scope))) {
    afterFallbackParents.add(join(dirname(scope), 'package.json'))
  }
}
// Default Worker execArgv inherits this preload; environment data also reaches nested Workers.
if (isMainThread) setEnvironmentData(ROOTS_KEY, roots)

function filePath(url) {
  if (!url.startsWith('file:')) return undefined
  const path = fileURLToPath(url)
  // A synthetic resolver anchor need not have a physical manifest. Genuine callers
  // using this exact URL receive the same fail-closed policy; the hook cannot distinguish them.
  return afterFallbackParents.has(path) ? path : realpathSync(path)
}

function packageRequest(specifier) {
  return !isBuiltin(specifier)
    && !specifier.startsWith('.')
    && !isAbsolute(specifier)
    && !URL.canParse(specifier)
}

function packageName(specifier) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length < 2 ? undefined : `${parts[0]}/${parts[1]}`
  return specifier.startsWith('#') ? undefined : parts[0]
}

function runtimeTarget(specifier, target) {
  const name = packageName(specifier)
  if (name === undefined) return false
  const directory = join(runtimeRoot, 'node_modules', name)
  if (!existsSync(directory)) return false
  const packageRoot = realpathSync(directory)
  // The generation selects the package; the policy confines its result to that
  // named runtime package, without requiring a legacy profile link.
  return inside(runtimeRoot, packageRoot) && inside(packageRoot, target)
}

function moduleNotFound(specifier, parent, requireRequest) {
  const error = new Error(requireRequest
    ? `Cannot find module '${specifier}'`
    : `Cannot find package '${specifier}' imported from ${parent}`)
  error.code = requireRequest ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND'
  return error
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL === undefined ? undefined : filePath(context.parentURL)
    if (parent === undefined || (!inside(profileModules, parent) && !afterFallbackParents.has(parent)) || !packageRequest(specifier)) {
      return nextResolve(specifier, context)
    }
    const result = nextResolve(specifier, context)
    const target = filePath(result.url)
    if (target === undefined || inside(profileRoot, target) || runtimeTarget(specifier, target)) return result
    throw moduleNotFound(specifier, parent, context.conditions.includes('require'))
  },
})
