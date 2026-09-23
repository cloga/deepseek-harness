import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN')).toEqual({ id: 'zh-CN', messages: zh })
    expect(resolveDesktopLocale('en-US')).toEqual({ id: 'en', messages: en })
    expect(resolveDesktopLocale('fr-FR')).toEqual({ id: 'en', messages: en })
  })

  it('explains strict and compatible verified-source ownership in both languages', () => {
    expect(en.verifiedReleaseOwnership).toMatchInlineSnapshot('"Manual verified installs remain user-owned. Strict packaged entries require their requested source; compatible entries retain another verified source only after staged Host health passes."')
    expect(zh.verifiedReleaseOwnership).toMatchInlineSnapshot('"手动验证安装仍归用户所有。严格的打包条目要求其请求来源；兼容条目只有在暂存 Host 健康检查通过后才保留其他已验证来源。"')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('keeps visible plugin-manager HTML copy in the locale dictionaries', () => {
    const html = readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8')
    const staticText = [...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)].map(match => match[1]?.trim())
    expect(staticText).toEqual([])
  })
})
