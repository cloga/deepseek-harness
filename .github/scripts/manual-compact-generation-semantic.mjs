/** Temporary CI-only Session semantic check; decoding belongs to the source's official reader. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(), { auditCode: code }) }

/** Validate normalized Session events, not guessed packed JSONL fields. */
export function verifyNormalizedSession(seed, events) {
  const of = (rows, type) => rows.filter(event => event.type === type)
  const headers = of(events, 'request/header')
  check(headers.length === 1 && headers[0].data.header.config.provider === 'deepseek-official'
    && headers[0].data.header.config.model === 'deepseek-v4-flash', 'CONVERSATION_ROUTE')
  check(of(events, 'step/start').length === 2 && of(events, 'turn/start').length === 2
    && of(events, 'assistant/attempt').length === 0, 'EXTRA_NORMAL_REQUEST')
  const replies = rows => of(rows, 'assistant/message').map(event => event.data.message)
  check(replies(events).length === 2 && replies(events).every(message => message.source.provider === 'deepseek-official'
    && message.source.model === 'deepseek-v4-flash')
    && same(replies(events).map(message => message.content), replies(seed).map(message => message.content)), 'MODEL_OUTPUT_CHANGED')
  const summaries = of(events, 'compaction/summary'), baseline = of(seed, 'compaction/summary')
  check(summaries.length === 1 && baseline.length === 1, 'SUMMARY_COUNT')
  const event = summaries[0], summary = event.data
  check(summary.provider === 'deepseek-official' && summary.model === 'deepseek-v4-pro'
    && summary.maxTokens === 256 && summary.llmStreamCall === true, 'SUMMARY_ROUTE_OR_BUDGET')
  check(same(summary.summary, baseline[0].data.summary) && same(summary.rawOutput, baseline[0].data.rawOutput), 'MODEL_OUTPUT_CHANGED')
  const starts = of(events, 'compaction/start'), ends = of(events, 'compaction/end')
  const commands = of(events, 'command/run'), done = of(events, 'command/done')
  check(starts.length === 1 && ends.length === 1 && commands.length === 1 && done.length === 1
    && typeof summary.compactionId === 'string' && typeof summary.sourceCommandId === 'string'
    && starts[0].data.turn === null && ends[0].data.turn === null && ends[0].data.error === undefined
    && starts[0].data.compactionId === summary.compactionId && ends[0].data.compactionId === summary.compactionId
    && starts[0].data.sourceCommandId === summary.sourceCommandId && ends[0].data.sourceCommandId === summary.sourceCommandId
    && commands[0].data.name === 'compact' && commands[0].data.args === ''
    && commands[0].data.commandId === summary.sourceCommandId && done[0].data.commandId === summary.sourceCommandId
    && done[0].data.kind === 'success' && done[0].data.sourceEventSeq === event.seq
    && commands[0].seq < starts[0].seq && starts[0].seq < event.seq && event.seq < ends[0].seq && ends[0].seq < done[0].seq, 'MANUAL_LIFECYCLE')
  return { normalRequests: 2, headers: 1, summaries: 1, summaryModel: 'deepseek-v4-pro', maxTokens: 256 }
}

function noLinks(path, isFile = false) {
  const parent = dirname(path)
  if (parent !== path) noLinks(parent)
  const stat = lstatSync(path)
  check(!stat.isSymbolicLink() && (isFile ? stat.isFile() : stat.isDirectory()), 'UNSAFE_FILE')
  check(realpathSync(path) === resolve(path), 'UNSAFE_FILE')
}
async function main() {
  const root = process.env.GITHUB_WORKSPACE, evidence = process.env.SNAPSHOT_EVIDENCE
  check(isAbsolute(root ?? '') && isAbsolute(evidence ?? '') && /^[0-9a-f]{40}$/u.test(process.env.EXPECTED_HEAD_SHA ?? ''), 'ENVIRONMENT')
  const seedPath = join(evidence, 'private-seed.jsonl')
  const resultPath = join(root, 'snapshots/web/manual-compact-model-selection/session.v3.jsonl')
  noLinks(seedPath, true); noLinks(resultPath, true)
  const seed = readFileSync(seedPath), result = readFileSync(resultPath)
  const { parseSessionLog } = await import(pathToFileURL(join(root, 'packages/test-support/llm-replay/src/index.ts')).href)
  const checks = verifyNormalizedSession(parseSessionLog(seed.toString('utf8')), parseSessionLog(result.toString('utf8')))
  const receipt = Buffer.from(`${JSON.stringify({ schemaVersion: 1, sourceSha: process.env.EXPECTED_HEAD_SHA,
    seedSha256: digest(seed), sessionSha256: digest(result), checks }, null, 2)}\n`)
  noLinks(evidence)
  writeFileSync(join(evidence, 'private-semantic.json'), receipt, { flag: 'wx', mode: 0o600 })
  console.log(`semantic_sha=${digest(receipt)}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) {
    const code = /^[A-Z_]+$/u.test(error?.auditCode ?? '') ? error.auditCode : 'CHECK_FAILED'
    console.error(`MANUAL_COMPACT_SEMANTIC_REJECTED:${code}`)
    process.exitCode = 1
  }
}
