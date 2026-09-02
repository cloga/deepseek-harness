import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Credential } from '@earendil-works/pi-ai'
import { authContextFrom, credentialStoreFrom, normalizeGrantPayload, recordKeyFor } from '../src/auth.ts'

const dirs: string[] = []

/** A context whose credential records live in a throwaway `$DSH_HOME`. */
async function stored(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  return ctx
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai credential store over harness records', () => {
  it('reads nothing for a provider with no record', async () => {
    const store = credentialStoreFrom(await stored())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('round-trips an api-key credential field by field', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)

    await store.modify('cloudflare', () =>
      Promise.resolve({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } }))

    await expect(store.read('cloudflare'))
      .resolves.toEqual({ type: 'api_key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
    await expect(ctx.credentials.readRecord(recordKeyFor('cloudflare')))
      .resolves.toEqual({ kind: 'api-key', key: 'sk-live', env: { ACCOUNT_ID: 'acct-1' } })
  })

  it('stores an api-key credential carrying neither a key nor env', async () => {
    const store = credentialStoreFrom(await stored())

    await store.modify('bedrock', () => Promise.resolve({ type: 'api_key' }))

    await expect(store.read('bedrock')).resolves.toEqual({ type: 'api_key' })
  })

  it('normalizes an OAuth credential to detached strict JSON, preserving extension fields', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    const granted = {
      type: 'oauth' as const,
      access: 'at',
      refresh: 'rt',
      expires: 42,
      enterpriseUrl: undefined,
      availableModelIds: ['gpt-5', undefined, 'gpt-4.1'],
      extension: { accountId: 'acc', absent: undefined, nested: [{ enabled: true }, undefined] },
    }

    await store.modify('github-copilot', () => Promise.resolve(granted as Credential))

    const expected = {
      type: 'oauth',
      access: 'at',
      refresh: 'rt',
      expires: 42,
      availableModelIds: ['gpt-5', null, 'gpt-4.1'],
      extension: { accountId: 'acc', nested: [{ enabled: true }, null] },
    }
    await expect(store.read('github-copilot')).resolves.toEqual(expected)
    await expect(ctx.credentials.readRecord(recordKeyFor('github-copilot')))
      .resolves.toEqual({ kind: 'grant', payload: expected })
  })

  it('accepts same-realm, null-prototype, and cross-realm plain grant records', () => {
    const sameRealm = { type: 'oauth', extension: { enabled: true } }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, sameRealm)
    const crossRealm = runInNewContext('({ type: "oauth", extension: { enabled: true } })') as unknown

    for (const source of [sameRealm, nullPrototype, crossRealm]) {
      const clone = normalizeGrantPayload(source) as { extension: { enabled: boolean } }
      expect(clone).toEqual(sameRealm)
      expect(Object.getPrototypeOf(clone)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(clone.extension)).toBe(Object.prototype)
    }
  })

  it('detaches every retained object and array from the provider grant', () => {
    const granted = { type: 'oauth', extension: { labels: ['one'], state: { enabled: true } } }
    const clone = normalizeGrantPayload(granted) as typeof granted

    granted.extension.labels[0] = 'changed'
    granted.extension.state.enabled = false

    expect(clone).toEqual({ type: 'oauth', extension: { labels: ['one'], state: { enabled: true } } })
    expect(clone).not.toBe(granted)
    expect(clone.extension).not.toBe(granted.extension)
    expect(clone.extension.labels).not.toBe(granted.extension.labels)
  })

  it.each([
    ['a non-finite number', { type: 'oauth', nested: { value: Number.NaN } }, /\$\.nested\.value contains a non-finite number/],
    ['a bigint', { type: 'oauth', nested: { value: 1n } }, /\$\.nested\.value contains a bigint/],
    ['a function', { type: 'oauth', nested: { value: () => true } }, /\$\.nested\.value contains a function/],
    ['a symbol', { type: 'oauth', nested: { value: Symbol('secret') } }, /\$\.nested\.value contains a symbol/],
    ['a Date', { type: 'oauth', nested: { value: new Date(0) } }, /\$\.nested\.value contains a non-plain object/],
    ['a class instance', { type: 'oauth', nested: { value: new (class GrantExtension { marker = true })() } }, /\$\.nested\.value contains a non-plain object/],
  ])('rejects grant payload containing %s without rendering its value', (_label, granted, diagnostic) => {
    expect(() => normalizeGrantPayload(granted)).toThrow(diagnostic)
  })

  it('rejects cycles and symbol-keyed data by structural path and category', () => {
    const cyclic: Record<string, unknown> = { type: 'oauth' }
    cyclic['nested'] = { parent: cyclic }
    const symbolKeyed = { type: 'oauth', nested: { visible: true } }
    Object.defineProperty(symbolKeyed.nested, Symbol('secret'), { value: 'must-not-render' })

    expect(() => normalizeGrantPayload(cyclic)).toThrow(/\$\.nested\.parent is cyclic/)
    expect(() => normalizeGrantPayload(symbolKeyed)).toThrow(/\$\.nested contains symbol-keyed data/)
    expect(() => normalizeGrantPayload(symbolKeyed)).not.toThrow(/must-not-render|secret/)
  })

  it('shows the mutation the current credential and leaves it alone when declined', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }))
    const seen: unknown[] = []

    const unchanged = await store.modify('openai-codex', (current) => {
      seen.push(current)
      return Promise.resolve(undefined)
    })

    expect(seen).toEqual([{ type: 'oauth', access: 'first', refresh: 'r', expires: 1 }])
    expect(unchanged).toEqual({ type: 'oauth', access: 'first', refresh: 'r', expires: 1 })
  })

  it('lists only the records this adapter family owns', async () => {
    const ctx = await stored()
    const store = credentialStoreFrom(ctx)
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))
    await store.modify('cloudflare', () => Promise.resolve({ type: 'api_key', key: 'k' }))
    // Another plugin's record for a provider name this one also serves: its
    // payload is written in a format pi-ai never agreed to.
    await ctx.credentials.modifyRecord(credentialKey('llm-kimi', 'openai-codex'), () =>
      Promise.resolve({ kind: 'grant', payload: { theirs: true } }))

    await expect(store.list()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'cloudflare', type: 'api_key' },
    ])
  })

  it('forgets a credential on delete, and stays quiet when there was none', async () => {
    const store = credentialStoreFrom(await stored())
    await store.modify('openai-codex', () =>
      Promise.resolve({ type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }))

    await store.delete('openai-codex')
    await store.delete('openai-codex')

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('reads empty but refuses to write without a credentials service', async () => {
    const store = credentialStoreFrom(new Context())

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
    await expect(store.modify('openai-codex', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/mounts no credentials service/)
    await expect(store.delete('openai-codex')).rejects.toThrow(/mounts no credentials service/)
  })

  it('treats a provider id outside the record grammar as holding nothing', async () => {
    const store = credentialStoreFrom(await stored())

    // A hand-declared route key is an arbitrary settings dict key, and pi-ai
    // reads it during auth resolution: the answer is "not signed in", never a
    // thrown address error…
    await expect(store.read('My_Proxy')).resolves.toBeUndefined()
    // …nothing can ever be stored under it, so a logout has nothing to remove…
    await expect(store.delete('My_Proxy')).resolves.toBeUndefined()
    // …while a write that cannot land must refuse rather than report success.
    await expect(store.modify('My_Proxy', () => Promise.resolve({ type: 'api_key', key: 'k' })))
      .rejects.toThrow(/cannot address a stored credential record/)
  })
})

describe('pi-ai ambient auth context', () => {
  beforeEach(() => {
    vi.stubEnv('PI_AUTH_AMBIENT', 'from-environment')
  })

  it('answers an environment name from the credential seam first', async () => {
    const ctx = await stored()
    await ctx.credentials.set(credentialRef('PI_AUTH_SEAM'), 'from-seam')

    await expect(authContextFrom(ctx).env('PI_AUTH_SEAM')).resolves.toBe('from-seam')
  })

  it('falls back to the launch environment when nothing is stored', async () => {
    await expect(authContextFrom(await stored()).env('PI_AUTH_AMBIENT')).resolves.toBe('from-environment')
  })

  it('answers "not set" for a name no reference could ever address', async () => {
    // pi-ai asks about provider-declared names; one outside the reference
    // grammar has no reference to miss, and must not throw.
    await expect(authContextFrom(await stored()).env('not a var')).resolves.toBeUndefined()
  })

  it('answers about the host filesystem, expanding a leading ~', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-home-'))
    dirs.push(dir)
    await writeFile(join(dir, 'creds'), 'x')
    // Both spellings of "home": os.homedir() reads HOME on POSIX and
    // USERPROFILE on Windows, and the expansion under test goes through it.
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    const context = authContextFrom(await stored())

    await expect(context.fileExists('~/creds')).resolves.toBe(true)
    await expect(context.fileExists('~/missing')).resolves.toBe(false)
    await expect(context.fileExists(join(dir, 'creds'))).resolves.toBe(true)
    await expect(context.fileExists('~')).resolves.toBe(true)
  })
})
