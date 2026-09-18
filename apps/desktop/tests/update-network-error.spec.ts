import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { describeDesktopUpdateError, withDesktopUpdateNetworkError } from '../src/update-network-error.ts'

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
    expect(describeDesktopUpdateError(error, zh)).toBe('校验发布标签时请求已取消。\n需要检查更新时，请重新发起检查。')
    expect(describeDesktopUpdateError(error, en)).not.toContain('could not be reached')
  })

  it('recognizes the timeout signal without printing its raw message', async () => {
    const error = await caught(new DOMException('private detail', 'TimeoutError'))
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
