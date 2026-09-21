/** Synthetic inert records matching the released alpha1 journal shapes; not operator captures or inventory proofs. */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** @returns Source-faithful schema/phase fields with deliberately synthetic inventory digests. */
export function legacyActivationFixture(schemaVersion: 1 | 2, phase: 'activating' | 'committed'): string {
  const common = { schemaVersion, transaction: '.desktop-transaction-Ab12Cd', phase }
  return JSON.stringify(schemaVersion === 1 ? common : {
    ...common, operation: 'plugin-update', target: 'kept-plugin',
    before: { sha256: 'a'.repeat(64), names: ['kept-plugin'] },
    after: { sha256: 'b'.repeat(64), names: ['kept-plugin'] },
  }) + '\n'
}

/** Read only the disposable test tree, recording links without following their targets. */
export function retainedTree(root: string): readonly string[] {
  const result: string[] = []
  const visit = (path: string, name: string): void => {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) result.push(`link:${name}:${readlinkSync(path)}`)
    else if (entry.isDirectory()) {
      result.push(`directory:${name}`)
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`)
    } else if (entry.isFile()) result.push(`file:${name}:${readFileSync(path).toString('base64')}`)
    else result.push(`special:${name}`)
  }
  visit(root, '')
  return result
}
