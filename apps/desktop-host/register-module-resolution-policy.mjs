/** Restrict bare package resolution initiated by Desktop-managed plugin modules. */

import { existsSync, realpathSync } from 'node:fs'
import { isBuiltin, registerHooks } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeDir = process.argv[2]
const profileDir = process.argv[3]
if (runtimeDir === undefined || profileDir === undefined) {
  throw new Error('dsh desktop: module resolution policy requires runtime and profile directories')
}

const runtimeRoot = realpathSync.native(runtimeDir)
const profileRoot = realpathSync.native(profileDir)
const profileModules = join(profileRoot, 'node_modules')

function inside(root, path) {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function filePath(url) {
  if (!url.startsWith('file:')) return undefined
  return realpathSync.native(fileURLToPath(url))
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

function linkedRuntimeTarget(specifier, target) {
  const name = packageName(specifier)
  if (name === undefined) return false
  const link = join(profileModules, name)
  if (!existsSync(link)) return false
  const packageRoot = realpathSync.native(link)
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
    if (parent === undefined || !inside(profileModules, parent) || !packageRequest(specifier)) {
      return nextResolve(specifier, context)
    }
    const result = nextResolve(specifier, context)
    const target = filePath(result.url)
    if (target === undefined || inside(profileRoot, target) || linkedRuntimeTarget(specifier, target)) return result
    throw moduleNotFound(specifier, parent, context.conditions.includes('require'))
  },
})
