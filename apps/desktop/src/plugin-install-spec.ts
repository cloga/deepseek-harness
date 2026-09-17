/** Pure parsing of the explicitly supported Desktop plugin installation inputs. */

import { posix, win32 } from 'node:path'
import { validRange } from 'semver'

/** Requested source spelling and parsed acquisition fields; parsing does not establish trust or existence. */
export type DesktopPluginInstallSpec =
  | { readonly kind: 'registry'; readonly spec: string; readonly name: string }
  | { readonly kind: 'github'; readonly spec: string; readonly owner: string; readonly repo: string; readonly ref?: string }
  | { readonly kind: 'directory'; readonly spec: string; readonly path: string }
  | { readonly kind: 'tarball'; readonly spec: string; readonly path: string }
  | { readonly kind: 'remoteTarball'; readonly spec: string; readonly url: string }

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u
const EXPLICIT_RELATIVE = /^\.\.?[\\/]/u
const TARBALL = /\.(?:tgz|tar\.gz)$/iu
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

function invalid(reason: string): never {
  throw new Error(`desktop plugin install: ${reason}`)
}

function github(spec: string, source: string): DesktopPluginInstallSpec {
  const match = /^([^/#]+)\/([^/#]+)(?:#(.+))?$/u.exec(source)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return invalid('expected GitHub owner/repo with an optional #ref')
  }
  const owner = match[1]
  const repo = match[2].replace(/\.git$/u, '')
  const ref = match[3]
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) || owner.includes('--')) {
    return invalid('invalid GitHub owner')
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(repo) || repo === '.' || repo === '..') {
    return invalid('invalid GitHub repository name')
  }
  if (ref !== undefined) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/u.test(ref)
      || ref.includes('..')
      || ref.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
      return invalid('unsupported GitHub ref: use a branch, tag, or commit without Git revision operators')
    }
  }
  return ref === undefined ? { kind: 'github', spec, owner, repo } : { kind: 'github', spec, owner, repo, ref }
}

function local(spec: string, input: string, cwd: string, directoryOnly: boolean): DesktopPluginInstallSpec {
  if (input === '' || CONTROL.test(cwd)) return invalid('local path and working directory must be nonempty and contain no control characters')
  if (/^[/\\]{2}[?.][\\/]/u.test(input) || /^[A-Za-z]:[^\\/]/u.test(input) || /^[A-Za-z]:$/u.test(input)) {
    return invalid('Windows device paths and drive-relative paths are unsupported')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(input) && !WINDOWS_ABSOLUTE.test(input)) {
    return invalid('file: and link: accept filesystem paths, not nested protocols')
  }
  let path: string
  if (WINDOWS_ABSOLUTE.test(input)) {
    if (input.startsWith('\\\\') && !/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(input)) {
      return invalid('UNC paths require both a server and a share')
    }
    path = win32.normalize(input)
  } else if (posix.isAbsolute(input)) {
    path = posix.normalize(input)
  } else {
    if (!WINDOWS_ABSOLUTE.test(cwd) && !posix.isAbsolute(cwd)) return invalid('relative local paths require an absolute working directory')
    if (input.startsWith('\\')) return invalid('Windows root-relative paths require an explicit drive')
    if (input.includes('\\') && !WINDOWS_ABSOLUTE.test(cwd)) return invalid('Windows relative paths require a Windows working directory')
    path = WINDOWS_ABSOLUTE.test(cwd) ? win32.resolve(cwd, input) : posix.resolve(cwd, input)
  }
  return { kind: !directoryOnly && TARBALL.test(path) ? 'tarball' : 'directory', spec, path }
}

function httpsSource(spec: string): DesktopPluginInstallSpec {
  const input = spec.startsWith('git+') ? spec.slice(4) : spec
  if (!input.startsWith('https://') || /[\\\s]/u.test(input)) return invalid('expected an HTTPS URL without whitespace or backslashes')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return invalid('invalid HTTPS URL')
  }
  const authority = /^https:\/\/([^/]+)/u.exec(input)?.[1] ?? ''
  if (authority.includes('@') || url.username !== '' || url.password !== '' || input.includes('?') || url.port !== '') {
    return invalid('URL credentials, query strings, and custom ports are unsupported')
  }
  // Parse GitHub paths before URL normalization can erase dot segments or decode a different source.
  const githubMatch = /^https:\/\/github\.com\/([^?#]+)(?:#(.*))?$/u.exec(input)
  if (githubMatch !== null && githubMatch[1] !== undefined) {
    const source = githubMatch[1] + (githubMatch[2] === undefined ? '' : `#${githubMatch[2]}`)
    if (!TARBALL.test(url.pathname)) return github(spec, source)
  }
  if (spec.startsWith('git+')) return invalid('git+https is supported only for GitHub repositories')
  if (input.includes('#') || !TARBALL.test(url.pathname)) return invalid('remote archives must be HTTPS .tgz or .tar.gz URLs without a fragment')
  if (url.hostname === '' || !/^https:\/\/[^/]+\//u.test(input)) return invalid('HTTPS archive URLs require a host and an absolute path')
  return { kind: 'remoteTarball', spec, url: input }
}

/**
 * Parse one supported registry, GitHub, local snapshot, or HTTPS archive source without IO.
 * @param spec User input; surrounding whitespace is removed, but the requested spelling is otherwise retained in `spec`.
 * @param cwd Absolute working directory for relative local paths; Windows semantics are detected independently of the OS.
 * @returns A source discriminant and acquisition fields. Local `link:` inputs describe snapshots, never durable symlinks.
 * Throws for unsupported or malformed input.
 */
export function parseDesktopPluginInstallSpec(spec: string, cwd: string): DesktopPluginInstallSpec {
  if (CONTROL.test(spec)) return invalid('input must not contain control characters')
  const requested = spec.trim()
  if (requested === '') return invalid('source must not be empty')
  if (requested.startsWith('file:') || requested.startsWith('link:')) {
    const path = requested.slice(5)
    if (path.startsWith('//')) return invalid('file: and link: accept paths, not file URLs; use an absolute path directly')
    return local(requested, path, cwd, requested.startsWith('link:'))
  }
  if (WINDOWS_ABSOLUTE.test(requested) || posix.isAbsolute(requested) || EXPLICIT_RELATIVE.test(requested)) {
    return local(requested, requested, cwd, false)
  }
  if (requested.startsWith('github:')) return github(requested, requested.slice(7))
  if (requested.startsWith('https:') || requested.startsWith('git+https:')) return httpsSource(requested)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(requested) || requested.startsWith('-')) {
    return invalid('unsupported source protocol or option; use registry, GitHub, an explicit local path, or an HTTPS archive')
  }
  if (!requested.startsWith('@') && requested.includes('/')) return github(requested, requested)
  const separator = requested.indexOf('@', requested.startsWith('@') ? 1 : 0)
  const name = separator === -1 ? requested : requested.slice(0, separator)
  if (name.length > 214 || !PACKAGE_NAME.test(name)) return invalid('invalid registry package name; local paths must be explicit')
  if (separator !== -1) {
    const selector = requested.slice(separator + 1)
    if (selector.trim() === '' || (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(selector) && validRange(selector) === null)) {
      return invalid('registry selector must be an exact version, dist tag, or valid semver range')
    }
  }
  return { kind: 'registry', spec: requested, name }
}
