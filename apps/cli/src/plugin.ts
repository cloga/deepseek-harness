/** dsh plugin forwards pnpm through the shared profile package operations. */
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { INSTALL_ANCHOR } from './profile-boot.ts'
import { resolveCliPluginDirectory } from './profile-ownership.ts'
import { join } from 'node:path'

/** Run package management after rejecting Desktop-owned or unresolved profile targets.
 * @param profile Profile name.
 * @param args Pnpm arguments relative to the invoking directory.
 * @param home Explicit Harness home; defaults to the public home resolver.
 * @returns Pnpm exit code.
 */
export async function runPlugin(profile: string, args: readonly string[], home?: string): Promise<number> {
  const dir = resolveCliPluginDirectory(profile, home)
  const result = await runPluginCommand({ profile, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }, args, {
    execution: 'cli',
    outputBytes: 16384,
    lockWaitMs: 120000,
    onOutput: (text, stream) => { process[stream].write(text) },
  })
  if (result.exitCode === 127) process.stderr.write('dsh: pnpm was not found; install pnpm and make it available on PATH.\n')
  if (result.exitCode !== 0) process.stderr.write(`dsh: pnpm failed; diagnostics: ${result.logPath}\n`)
  if (result.exitCode !== 0 && args.some(argument => /^git\+|^github:|\.git(?:#|$)/.test(argument))) {
    process.stderr.write(`dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`)
  }
  return result.exitCode
}
