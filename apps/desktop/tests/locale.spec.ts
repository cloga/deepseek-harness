import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('describes preserved user choices and non-destructive native recovery in both languages', () => {
    expect(en.baselinePreserved).toContain('removal, version, or disabled selection has been preserved')
    expect(zh.baselinePreserved).toContain('插件移除、版本或停用选择已保留')
    expect(en.baselineDetail).toContain('Core can remain usable with your current profile')
    expect(zh.baselineDetail).toContain('Core 可以继续使用当前 profile')
    expect(en.disableThirdPartyPlugins).toContain('back up profile patch')
    expect(zh.disableThirdPartyPlugins).toContain('备份 profile patch')
    for (const messages of [en, zh]) {
      expect(messages).not.toHaveProperty('resetConfiguration')
      expect(messages).not.toHaveProperty('confirmConfigurationReset')
      expect(messages).not.toHaveProperty('verifiedReleaseOwnership')
    }
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

})
