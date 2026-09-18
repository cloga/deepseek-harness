/** Exercise the wheel's external Office package from a shipped dsh profile. */
import { appendFileSync, writeSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

export const name = 'python-sdk-office-smoke'

export async function apply(_ctx, config) {
  const started = performance.now()
  let records = 0
  function record(phase, state) {
    if (records++ >= 10) return
    const elapsedMs = Math.min(2_147_483_647, Math.max(0, Math.round(performance.now() - started)))
    const line = JSON.stringify({ phase, state, elapsedMs }) + '\n'
    try {
      writeSync(2, `python-sdk-office: ${line}`)
    } catch (error) {
      // A closed diagnostic stream must not change the conversion outcome.
    }
    try {
      appendFileSync(config.diagnostics, line, 'utf8')
    } catch (error) {
      // The bounded stderr markers remain useful when the owned record cannot be written.
    }
  }
  async function phase(name, operation) {
    record(name, 'start')
    try {
      const result = await operation()
      record(name, 'done')
      return result
    } catch (error) {
      record(name, 'fail')
      throw error
    }
  }

  const { createConverter } = await phase('import', () => import('@deepseek-ai/libreoffice-kit'))
  const converter = await phase('create', () => createConverter({ timeoutMs: 120_000 }))
  try {
    const result = await phase('render', () => converter.render({ inputPath: config.input, outputPath: config.output }))
    await phase('result-write', () => writeFile(config.result, JSON.stringify({ ...result, moduleUrl: import.meta.resolve('@deepseek-ai/libreoffice-kit') })))
  } finally {
    await phase('dispose', () => converter.dispose())
  }
}
