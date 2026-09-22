/** Seed one synthetic, settled Session through the actual packaged persistence API; never call a model. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [runtimeRoot, home, ownershipToken] = process.argv.slice(2)
assert(runtimeRoot && home && isAbsolute(runtimeRoot) && isAbsolute(home), 'Explicit isolated runtime/home required')
assert(ownershipToken, 'The acceptance owner must authorize this exact temporary home')
assert.deepEqual(JSON.parse(readFileSync(join(home, 'native-composer-owner.json'), 'utf8')), {
  kind: 'desktop-native-composer-smoke', home, token: ownershipToken,
})
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
assert(process.versions.electron, 'Seed must use the packaged Electron filesystem')
const require = createRequire(join(runtimeRoot, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { Session, SessionId, SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session')
const { createSystemMessage, createUserMessage, createAssistantMessage } = await load('@deepseek-ai/dsh-llm')
const { default: JsonlSessionPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: Storage } = await load('@deepseek-ai/dsh-storage')
const StorageJson = await load('@deepseek-ai/dsh-storage-json')
const StorageDomain = await load('@deepseek-ai/dsh-storage-domain')
const { default: WorkspaceRegistry } = await load('@deepseek-ai/dsh-workspace')
const id = SessionId('desktop-inline-composer-synthetic')
const workspace = join(home, 'synthetic-composer-workspace')
mkdirSync(workspace, { recursive: true })
const createdAt = Date.now() - 60_000
const header = { version: SESSION_FORMAT_VERSION, id, createdAt, cwd: workspace, isSeeded: false, delegationDepth: 0 }
const session = Session.create(id, undefined, header)
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
session.append('system/message', {
  turn: 1, step: 1, message: createSystemMessage('Synthetic layout acceptance; no model request.', '@deepseek-ai/dsh-system-prompt'),
}, { surfaceOp: 'append' })
const user = session.append('user/message', createUserMessage({
  content: [{ type: 'text', text: 'Synthetic native composer layout fixture' }], source: { kind: 'user' },
}), { surfaceOp: 'append' })
session.append('session/title', { title: 'DESKTOP_INLINE_STATS_SYNTHETIC', messageSeqs: [user.seq], source: { kind: 'fallback' } })
session.append('request/header', {
  header: { config: { provider: 'github-copilot', model: 'synthetic-layout-model' } }, reason: 'initial',
})
session.append('assistant/message', {
  stream: [], turn: 1, step: 1,
  message: createAssistantMessage({ content: [{ type: 'text', text: 'Synthetic settled reply; no inference occurred.' }],
    source: { provider: 'github-copilot', model: 'synthetic-layout-model' } }),
  usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 },
}, { surfaceOp: 'append' })
session.append('step/end', { turn: 1, step: 1 })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
const events = session.snapshotEvents().map((event, index) => ({ ...event, time: createdAt + index * 100 }))
const ctx = new Context()
let failed = false
let failure
const retain = error => { if (!failed) { failed = true; failure = error } }
try {
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  const persistence = ctx.get('sessionPersistence')
  assert(persistence)
  const handle = await persistence.create(header)
  try { await handle.append(events) } catch (error) { retain(error) }
  finally { try { await handle.close() } catch (error) { retain(error) } }
  if (failed) throw failure
  // The earlier empty-app phases already initialized the registry, so a new log
  // needs explicit public workspace membership rather than bootstrap discovery.
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.get('workspaceRegistry')
  assert(registry)
  const owner = await registry.create(workspace)
  await owner.attachSession(id)
  assert(owner.sessionIds.includes(id))
} catch (error) { retain(error) }
finally {
  try { await ctx.fiber.dispose() } catch (error) { retain(error) }
}
if (failed) throw failure
console.log(JSON.stringify({ sessionId: id, scope: 'test-owned-persisted-session-with-synthetic-history-and-token-counts',
  workspaceRegistered: true, provider: 'github-copilot', seederModelCalls: 0, liveAccountQuota: false }))
