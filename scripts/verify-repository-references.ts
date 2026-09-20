/** Reject repository commit references except the scoped Issue-policy checkout pin, and reject disallowed organization URLs. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { canonicalReferenceText } from './verify-public-repository-links.ts'

const root = resolve(import.meta.dirname, '..')
const organization = ['deepseek', 'harness'].join('-')
const organizationUrl = new RegExp(`\\bgithub\\.com/${organization}(?![a-z0-9-])`)
const commitCandidate = /(?<![a-z0-9])[\da-f]{7,40}(?![a-z0-9])/gi
const excludedPrefixes = ['vendor/', '.agents/notes/archived/']
const gitOutputLimit = 64 * 1024 * 1024

/** One prohibited reference in a maintained source file. */
export interface RepositoryReference {
  /** Repository-relative path, with forward slashes. */
  file: string
  /** One-based source line containing the reference. */
  line: number
  /** Whether the line names a repository commit or the disallowed organization URL. */
  kind: 'commit-hash' | 'organization-url'
}

interface YamlNode {
  start: number
  end: number
  kind: string
  value: unknown
  children: YamlNode[]
}

function yamlProperty(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node?.kind !== 'mapping') return undefined
  for (let index = 0; index < node.children.length; index += 2) {
    if (node.children[index]?.kind === 'scalar' && node.children[index]?.value === key) {
      return node.children[index + 1]
    }
  }
  return undefined
}

// This exception identifies one machine-consumed token, not a trusted commit.
// Maintainers separately approve its revision; every other occurrence is checked.
function policyPinRange(file: string, source: string): { start: number; end: number } | undefined {
  if (file !== '.github/workflows/issue-policy.yml') return undefined
  const parsed: { root?: YamlNode; hasReferences: boolean } = { hasReferences: false }
  const stack: YamlNode[] = []
  try {
    yaml.load(source, {
      schema: yaml.CORE_SCHEMA,
      listener(event, state) {
        if (event === 'open') {
          const node: YamlNode = { start: state.position, end: state.position, kind: '', value: undefined, children: [] }
          const parent = stack.at(-1)
          if (parent) parent.children.push(node)
          else parsed.root = node
          stack.push(node)
        } else {
          const node = stack.pop()
          if (!node) throw new Error('Unbalanced YAML parse events')
          node.end = state.position
          node.kind = state.kind
          node.value = state.result
          if (('anchor' in state && state.anchor !== null)
            || source.slice(node.start, node.end).trimStart().startsWith('*')) parsed.hasReferences = true
        }
      },
    })
  } catch (error) {
    // Ambiguous or invalid YAML never creates an exemption from reference checks.
    if (error instanceof yaml.YAMLException) return undefined
    throw error
  }
  if (parsed.hasReferences) return undefined
  const policy = yamlProperty(yamlProperty(parsed.root, 'jobs'), 'policy')
  const steps = yamlProperty(policy, 'steps')
  const checkout = steps?.kind === 'sequence' ? steps.children[0] : undefined
  if (checkout?.kind !== 'mapping' || checkout.children.length !== 6
    || yamlProperty(checkout, 'name')?.value !== 'Check out trusted policy') return undefined
  const action = yamlProperty(checkout, 'uses')?.value
  if (typeof action !== 'string' || !/^actions\/checkout@[a-f0-9]{40}$/.test(action)) return undefined
  const options = yamlProperty(checkout, 'with')
  if (options?.kind !== 'mapping' || options.children.length !== 6
    || yamlProperty(options, 'clean')?.value !== true
    || yamlProperty(options, 'persist-credentials')?.value !== false) return undefined
  const ref = yamlProperty(options, 'ref')
  if (ref?.kind !== 'scalar' || typeof ref.value !== 'string') return undefined
  const match = ref.value.match(
    /^\$\{\{ github\.repository == 'cloga\/deepseek-harness' && '([a-f0-9]{40})' \|\| github\.event\.repository\.default_branch \}\}$/,
  )
  const commit = match?.[1]
  if (commit === undefined) return undefined
  const raw = source.slice(ref.start, ref.end)
  // Require the visible, plain scalar; escapes, folded scalars and comments
  // cannot substitute another occurrence for the actual checkout pin.
  if (raw.trim() !== ref.value) return undefined
  const start = ref.start + raw.indexOf(ref.value) + ref.value.indexOf(commit)
  return { start, end: start + commit.length }
}

function isMaintained(file: string): boolean {
  return !excludedPrefixes.some(prefix => file.startsWith(prefix))
}

/**
 * Inspect a maintained source file against known commit identifiers.
 * @param file - Repository-relative path used in diagnostics and exclusions.
 * @param source - File text or a symlink's stored target.
 * @param commits - Lowercase, unambiguous full or abbreviated commit identifiers.
 * @returns One finding per line and kind; accepts digests, non-commit Git objects and the scoped machine pin.
 */
export function findRepositoryReferences(
  file: string,
  source: string,
  commits: ReadonlySet<string>,
): RepositoryReference[] {
  if (!isMaintained(file)) return []
  const references: RepositoryReference[] = []
  const pin = policyPinRange(file, source)
  let offset = 0
  for (const [index, line] of source.split('\n').entries()) {
    if (organizationUrl.test(canonicalReferenceText(line))) {
      references.push({ file, line: index + 1, kind: 'organization-url' })
    }
    if ([...line.matchAll(commitCandidate)].some(match => commits.has(match[0].toLowerCase())
      && !(pin?.start === offset + match.index && pin.end === offset + match.index + match[0].length))) {
      references.push({ file, line: index + 1, kind: 'commit-hash' })
    }
    offset += line.length + 1
  }
  return references
}

function readMaintainedFiles(repoRoot: string): Map<string, string> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: gitOutputLimit,
  }).split('\0').filter(file => file !== '' && isMaintained(file))
  const sources = new Map<string, string>()
  for (const file of files) {
    const path = resolve(repoRoot, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() === true) sources.set(file, readlinkSync(path))
    else if (stat?.isFile() === true) sources.set(file, readFileSync(path, 'utf8'))
  }
  return sources
}

function repositoryCommits(repoRoot: string, sources: Iterable<string>): Set<string> {
  const candidates = [...new Set([...sources].flatMap(source =>
    [...source.matchAll(commitCandidate)].map(match => match[0].toLowerCase())))]
  if (candidates.length === 0) return new Set()
  const results = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8',
    input: `${candidates.join('\n')}\n`,
    maxBuffer: gitOutputLimit,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd().split('\n')
  // Git resolves prefixes across all available objects, including unreachable ones.
  // Ambiguous prefixes do not identify one object and cannot establish a commit reference.
  return new Set(candidates.filter((candidate, index) => {
    const [object, type] = results[index]?.split(' ') ?? []
    return type === 'commit' && object?.startsWith(candidate) === true
  }))
}

/**
 * Scan tracked and nonignored new files using only the local Git object database.
 * @param repoRoot - Working tree whose files and Git objects are inspected.
 * @returns Prohibited references outside vendor and frozen Agent Notes; absent shallow-history objects cannot match.
 */
export function scanRepositoryReferences(repoRoot: string): RepositoryReference[] {
  const sources = readMaintainedFiles(repoRoot)
  const commits = repositoryCommits(repoRoot, sources.values())
  return [...sources].flatMap(([file, source]) => findRepositoryReferences(file, source, commits))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const references = scanRepositoryReferences(root)
  if (references.length === 0) {
    console.log('verify-repository-references: no prohibited repository commit references or organization URLs; the scoped Issue-policy machine pin is permitted.')
  } else {
    console.error('verify-repository-references: use release tags or maintained repository links:')
    for (const { file, line, kind } of references) console.error(`  ${file}:${String(line)} ${kind}`)
    process.exitCode = 1
  }
}
