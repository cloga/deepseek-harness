/** Require the vendor modification log beside staged or explicit PR source changes. */
import { execFileSync } from 'node:child_process'

function diffArguments(args) {
  if (args.length === 0) return ['--cached']
  const refs = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if ((flag !== '--base' && flag !== '--head') || refs.has(flag)
      || typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
      throw new Error('expected --base <full commit SHA> --head <full commit SHA>, or no arguments for staged changes')
    }
    refs.set(flag, value)
  }
  if (refs.size !== 2) throw new Error('--base and --head must be supplied together')
  const revisions = [refs.get('--base'), refs.get('--head')]
  for (const revision of revisions) {
    git(['cat-file', '-e', `${revision}^{commit}`])
  }
  return revisions
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

try {
  const range = diffArguments(process.argv.slice(2))
  // Disable rename folding so moved-away and deleted vendor sources remain visible.
  const changed = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', ...range, '--'])
    .split('\0').filter(Boolean)
  const sources = changed.filter(path => /^vendor\/[^/]+\/(src\/|bin\.js)/.test(path))
  if (sources.length > 0 && !changed.includes('vendor/README.md')) {
    throw new Error(`vendored SOURCE changed without updating vendor/README.md:\n${sources.map(path => `  ${path}`).join('\n')}\nLog the modification in vendor/README.md ("Local modifications") in the same change.`)
  }
  if (sources.length > 0) {
    const staged = range[0] === '--cached'
    const manifest = staged
      ? git(['ls-files', '--stage', '-z', '--', 'vendor/README.md'])
      : git(['ls-tree', '-z', range[1], '--', 'vendor/README.md'])
    const regularFile = staged
      ? /^100(?:644|755) [a-f0-9]{40} 0\tvendor\/README\.md\0$/
      : /^100(?:644|755) blob [a-f0-9]{40}\tvendor\/README\.md\0$/
    if (!regularFile.test(manifest)) {
      throw new Error('vendor/README.md must remain a regular file in the checked index or PR head')
    }
  }
  console.log(`vendor manifest guard: checked ${changed.length} ${range[0] === '--cached' ? 'staged' : 'PR'} paths`)
} catch (error) {
  console.error(`vendor manifest guard: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
