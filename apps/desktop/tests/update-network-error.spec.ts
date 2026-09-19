import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { describeDesktopUpdateError, desktopUpdateNetworkDetails, withDesktopUpdateNetworkError } from '../src/update-network-error.ts'

async function caught(error: unknown, stage: 'release-list' | 'release-tag' | 'manifest-download' = 'manifest-download'): Promise<unknown> {
  try { await withDesktopUpdateNetworkError(stage, async () => { throw error }) }
  catch (failure) { return failure }
  throw new Error('expected failure')
}

function fetchFailure(code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('private signed URL https://example.invalid/?token=secret'), { code }) })
}

describe('Desktop update network error messages', () => {
  it('shows the failed stage, connection reset and recovery in both locales', async () => {
    const error = await caught(fetchFailure('ECONNRESET'))
    expect(describeDesktopUpdateError(error, zh)).toBe('下载更新清单时连接被重置（ECONNRESET）。\n请检查网络连接后重试。')
    expect(describeDesktopUpdateError(error, en)).toBe('Could not download the update manifest: the connection was reset (ECONNRESET).\nCheck your network connection and try again.')
  })

  it.each([
    ['ETIMEDOUT', '请求超时'], ['UND_ERR_CONNECT_TIMEOUT', '请求超时'],
    ['UND_ERR_HEADERS_TIMEOUT', '请求超时'], ['UND_ERR_BODY_TIMEOUT', '请求超时'],
    ['ENOTFOUND', '无法解析更新服务器地址'], ['EAI_AGAIN', '无法解析更新服务器地址'],
    ['ENETUNREACH', '无法连接更新服务器'], ['EHOSTUNREACH', '无法连接更新服务器'], ['ECONNREFUSED', '无法连接更新服务器'],
    ['CERT_HAS_EXPIRED', '无法验证安全连接的证书'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', '无法验证安全连接的证书'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', '无法验证安全连接的证书'], ['SELF_SIGNED_CERT_IN_CHAIN', '无法验证安全连接的证书'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', '无法验证安全连接的证书'], ['CERT_SIGNATURE_FAILURE', '无法验证安全连接的证书'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', '无法验证安全连接的证书'], ['UND_ERR_SOCKET', '连接中断'],
  ])('describes known %s without exposing raw network text', async (code, text) => {
    const error = await caught(fetchFailure(code), 'release-list')
    const message = describeDesktopUpdateError(error, zh)
    expect(message).toContain('读取发布列表时')
    expect(message).toContain(text)
    expect(message).toContain(code)
    expect(message).not.toMatch(/private|https:|secret|token=/u)
  })

  it('retains certificate verification in its advice', async () => {
    const error = await caught(fetchFailure('CERT_HAS_EXPIRED'))
    expect(describeDesktopUpdateError(error, zh)).toContain('保持证书校验开启')
    expect(describeDesktopUpdateError(error, en)).toContain('Keep certificate verification enabled')
  })

  it('does not turn cancellation into network unreachability', async () => {
    const error = await caught(new DOMException('secret', 'AbortError'), 'release-tag')
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(describeDesktopUpdateError(error, zh)).toBe('校验发布标签时请求已取消。\n需要检查更新时，请重新发起检查。')
    expect(describeDesktopUpdateError(error, en)).not.toContain('could not be reached')
  })

  it('recognizes the timeout signal without printing its raw message', async () => {
    const error = await caught(new DOMException('private detail', 'TimeoutError'))
    expect(error).toMatchObject({ name: 'TimeoutError' })
    expect(describeDesktopUpdateError(error, zh)).toContain('请求超时')
    expect(describeDesktopUpdateError(error, zh)).not.toContain('private')
  })

  it('keeps an unknown fetch failure generic instead of inventing a cause', async () => {
    const error = await caught(fetchFailure('PRIVATE_TOKEN_123'))
    const message = describeDesktopUpdateError(error, zh)
    expect(message).toBe('下载更新清单时网络请求失败。\n请检查网络连接后重试。')
    expect(message).not.toMatch(/PRIVATE|secret|https:/u)
  })

  it('preserves non-network integrity, protocol and configuration failures', async () => {
    for (const error of [new Error('manifest asset digest does not match GitHub'), new SyntaxError('manifest is not JSON'), new TypeError('invalid configuration')]) {
      expect(await caught(error)).toBe(error)
      expect(describeDesktopUpdateError(error, zh)).toBe(error.message)
    }
  })

  it('returns details only for owned network wrappers without replacing safe summaries', async () => {
    const primary = fetchFailure('ECONNRESET')
    const wrapped = await caught(primary)
    expect(wrapped).not.toBe(primary)
    expect((wrapped as Error).cause).toBe(primary)
    expect(desktopUpdateNetworkDetails(wrapped, zh)).toBe(describeDesktopUpdateError(wrapped, zh))
    expect(desktopUpdateNetworkDetails(wrapped, en)).toBe(describeDesktopUpdateError(wrapped, en))
    expect(desktopUpdateNetworkDetails(primary, en)).toBeUndefined()
    const error = wrapped as Error
    expect(error.message).toBe(desktopUpdateNetworkDetails(wrapped, en))
    expect(error.message).not.toMatch(/private|https:|secret|token=/u)
    const prototype: unknown = Object.getPrototypeOf(error)
    if (typeof prototype !== 'object' || prototype === null) throw new Error('owned wrapper must have an object prototype')
    expect(desktopUpdateNetworkDetails(Object.create(prototype))).toBeUndefined()
    expect(desktopUpdateNetworkDetails(new Proxy(error, {}))).toBeUndefined()
  })

  it.each(['code', 'name', 'message', 'cause'] as const)('preserves the primary failure when its %s getter throws', async (field) => {
    const primary = new TypeError('invalid configuration')
    Object.defineProperty(primary, field, { get() { throw new Error('private getter token=secret') } })
    expect(await caught(primary)).toBe(primary)
    expect(desktopUpdateNetworkDetails(primary)).toBeUndefined()
    expect(describeDesktopUpdateError(primary)).not.toMatch(/private|secret|token=/u)
  })

  it.each(['code', 'name', 'message', 'cause'] as const)('preserves the primary failure when its %s proxy read throws', async (field) => {
    const primary = new Proxy(new TypeError('invalid configuration'), {
      get(target, key, receiver) {
        if (key === field) throw new Error('private proxy token=secret')
        const value: unknown = Reflect.get(target, key, receiver)
        return value
      },
    })
    expect(await caught(primary)).toBe(primary)
    expect(desktopUpdateNetworkDetails(primary)).toBeUndefined()
    expect(describeDesktopUpdateError(primary)).not.toMatch(/private|secret|token=/u)
  })

  it.each(['code', 'name', 'message'] as const)('can classify a safe nested cause after an unreadable %s', async (field) => {
    const primary = fetchFailure('ECONNRESET')
    Object.defineProperty(primary, field, { get() { throw new Error('private getter token=secret') } })
    const wrapped = await caught(primary)
    expect((wrapped as Error).cause).toBe(primary)
    expect(desktopUpdateNetworkDetails(wrapped)).toContain('the connection was reset (ECONNRESET)')
    expect(describeDesktopUpdateError(wrapped)).not.toMatch(/private|secret|token=/u)
  })

  it('keeps a fetch failure generic when its cause cannot be read', async () => {
    const primary = new TypeError('fetch failed')
    Object.defineProperty(primary, 'cause', { get() { throw new Error('private getter token=secret') } })
    const wrapped = await caught(primary)
    expect((wrapped as Error).cause).toBe(primary)
    expect(desktopUpdateNetworkDetails(wrapped)).toContain('the network request failed')
    expect(describeDesktopUpdateError(wrapped)).not.toMatch(/private|secret|token=/u)
  })

  it('does not lose a classified failure when constructor name or prototype inspection would throw', async () => {
    const primary = new Proxy(Object.assign(new Error('private request token=secret'), { code: 'ECONNRESET' }), {
      get(target, key, receiver) {
        if (key === 'name') throw new Error('private constructor token=secret')
        const value: unknown = Reflect.get(target, key, receiver)
        return value
      },
      getPrototypeOf() { throw new Error('private prototype token=secret') },
    })
    const wrapped = await caught(primary)
    expect(wrapped).not.toBe(primary)
    expect((wrapped as Error).cause).toBe(primary)
    expect(desktopUpdateNetworkDetails(wrapped)).toContain('the connection was reset (ECONNRESET)')
    expect(describeDesktopUpdateError(wrapped)).not.toMatch(/private|secret|token=/u)
  })

  it('preserves revoked and prototype-trapping proxies without displaying their secondary failures', async () => {
    const revoked = Proxy.revocable(new Error('invalid configuration'), {})
    revoked.revoke()
    const prototypeTrap = new Proxy(new Error('invalid configuration'), {
      getPrototypeOf() { throw new Error('private prototype token=secret') },
    })
    const conversionTrap = { [Symbol.toPrimitive]() { throw new Error('private conversion token=secret') } }
    for (const primary of [revoked.proxy, prototypeTrap, conversionTrap]) {
      await withDesktopUpdateNetworkError('manifest-download', async () => { throw primary }).then(
        () => { throw new Error('expected failure') },
        (failure: unknown) => { expect(failure).toBe(primary) },
      )
      expect(desktopUpdateNetworkDetails(primary)).toBeUndefined()
      expect(describeDesktopUpdateError(primary, en)).toBe(en.unknownError)
      expect(describeDesktopUpdateError(primary, zh)).toBe(zh.unknownError)
    }
  })

  it('does not coerce hostile field values or change primitive failures', async () => {
    const hostile = { [Symbol.toPrimitive]() { throw new Error('private coercion token=secret') } }
    const primary = { code: hostile, name: hostile, message: hostile }
    expect(await caught(primary)).toBe(primary)
    expect(desktopUpdateNetworkDetails(primary)).toBeUndefined()
    for (const value of [null, undefined, 'validation failed', 7]) {
      expect(await caught(value)).toBe(value)
      expect(desktopUpdateNetworkDetails(value)).toBeUndefined()
      expect(describeDesktopUpdateError(value)).toBe(String(value))
    }
  })

  it.each([5, 6])('inspects at most five errors in a %i-node cause chain', async (depth) => {
    let primary: Error = Object.assign(new Error('private request token=secret'), { code: 'ECONNRESET' })
    for (let index = 1; index < depth; index++) primary = new Error('outer failure', { cause: primary })
    const result = await caught(primary)
    if (depth === 5) expect(desktopUpdateNetworkDetails(result)).toContain('ECONNRESET')
    else {
      expect(result).toBe(primary)
      expect(desktopUpdateNetworkDetails(result)).toBeUndefined()
    }
  })

  it('bounds nested causes and preserves successful results without retries', async () => {
    const outer = new TypeError('fetch failed')
    Object.defineProperty(outer, 'cause', { value: outer })
    expect(describeDesktopUpdateError(await caught(outer), en)).toContain('the network request failed')
    let calls = 0
    const value = { ok: true }
    expect(await withDesktopUpdateNetworkError('release-tag', async () => { calls++; return value })).toBe(value)
    expect(calls).toBe(1)
  })
})
