/** Lossy git listings must never be treated as a complete workspace classification. */
import { expect, it, vi } from 'vitest'
import { GitRunner, gitlinkPaths, ignoredPaths, type GitRunResult, type GitWorkspace } from '../src/git.ts'

const workspace: GitWorkspace = {
  root: '/workspace', gitDir: '/workspace/.git', scratch: '/workspace/.scratch', env: {}, excludes: [],
}
const signal = new AbortController().signal
const runner = (result: GitRunResult): GitRunner => ({ run: vi.fn(async () => result) }) as unknown as GitRunner

it('rejects a truncated gitlink listing before trusting a complete-looking first entry', async () => {
  const git = runner({ exitCode: 0, stdout: `160000 ${'a'.repeat(40)} 0\tchild\0`, stderr: '', truncated: true })
  await expect(gitlinkPaths(git, workspace, signal)).rejects.toThrow('git ls-files output exceeded the configured cap')
})

it.each([0, 1])('rejects truncated ignore listings even with git exit %i', async (exitCode) => {
  const git = runner({ exitCode, stdout: exitCode === 0 ? 'secret\0' : '', stderr: '', truncated: true })
  await expect(ignoredPaths(git, workspace, ['secret', 'other'], signal))
    .rejects.toThrow('git check-ignore output exceeded the configured cap')
})
