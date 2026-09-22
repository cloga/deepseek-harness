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

  it('keeps native command consent distinct from ordinary staged-package review', () => {
    expect(en.pluginCommandPrompt).toBe('Restart the Desktop Host to apply this change?')
    expect(en.pluginCommandApply).toBe('Apply and Restart Host')
    expect(en.pluginCommandCancel).toBe('Cancel')
    expect(zh.pluginCommandPrompt).toBe('是否重启 Desktop Host 以应用此更改？')
    expect(zh.pluginCommandApply).toBe('应用并重启 Host')
    expect(zh.pluginCommandCancel).toBe('取消')
    expect(en.packageActivate).toBe('Activate and restart Host')
    expect(en.updateLater).toBe('Update later')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

})
