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

  it('explains that a release conflict retains the user installation in both languages', () => {
    expect(en.verifiedReleaseOwnership).toMatchInlineSnapshot('"Manual verified installs remain user-owned. A conflicting packaged baseline stops startup without replacing them; explicitly install or enable the requested source to resolve it."')
    expect(zh.verifiedReleaseOwnership).toMatchInlineSnapshot('"手动验证安装仍归用户所有。发行版基线与其冲突时会停止启动，不会替换用户插件；请明确安装或启用要求的来源以解决冲突。"')
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
