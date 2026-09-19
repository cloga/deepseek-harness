import { describe, expect, it, vi } from 'vitest'
import { confirmDesktopPluginMutation, DesktopPluginMutationCancelled, type DesktopPluginMutationImpact } from '../src/plugin-mutation-confirmation.ts'
import { en, zh } from '../src/locale.ts'

const hostIdentity = {}
function impact(): DesktopPluginMutationImpact {
  return {
    host: { runningSessions: 1, queuedMessages: 2, runningJobs: 3 },
    renderer: { hasDraft: true, attachmentCount: 4, submitting: true }, hostIdentity, rendererIdentity: 1,
  }
}

describe('plugin mutation interruption consent', () => {
  it.each([
    { locale: 'en', messages: en, detail: 'The prepared plugin change requires restarting the Desktop Host. Active work may be interrupted. Cancel keeps the installed profile unchanged.\n\nCurrent work affected:\nRunning Sessions: 1\nQueued messages: 2\nRunning jobs: 3\nUnsaved draft: Yes\nDraft attachments: 4\nSubmission in progress: Yes' },
    { locale: 'zh', messages: zh, detail: '已准备的插件更改需要重启 Desktop Host，当前工作可能中断。取消会保留已安装的 profile。\n\n当前受影响的工作：\n运行中的 Session：1\n排队消息：2\n运行中的任务：3\n未保存草稿：是\n草稿附件：4\n正在提交：是' },
  ])('reports exact active-work copy in $locale and accepts only after a fresh unchanged read', async ({ messages, detail }) => {
    const readImpact = vi.fn(async () => impact())
    const confirm = vi.fn(async (_detail: string) => true)
    await confirmDesktopPluginMutation({ messages, readImpact, confirm, cancelled: () => false })
    expect(readImpact).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(detail)
  })

  it('rejects declined consent without reporting successful application', async () => {
    const readImpact = vi.fn(async () => impact())
    await expect(confirmDesktopPluginMutation({ messages: en, readImpact, confirm: async () => false, cancelled: () => false }))
      .rejects.toBeInstanceOf(DesktopPluginMutationCancelled)
    expect(readImpact).toHaveBeenCalledOnce()
  })

  it.each(['sessions', 'queue', 'jobs', 'draft', 'attachments', 'submitting', 'host', 'document'])('re-prompts when %s changes while the dialog is open', async (changed) => {
    const first = impact()
    const next = {
      ...first,
      host: { ...first.host, ...(changed === 'sessions' ? { runningSessions: 7 } : changed === 'queue' ? { queuedMessages: 7 } : changed === 'jobs' ? { runningJobs: 7 } : {}) },
      renderer: { ...first.renderer, ...(changed === 'draft' ? { hasDraft: false } : changed === 'attachments' ? { attachmentCount: 7 } : changed === 'submitting' ? { submitting: false } : {}) },
      ...(changed === 'host' ? { hostIdentity: {} } : changed === 'document' ? { rendererIdentity: 2 } : {}),
    }
    const readImpact = vi.fn<() => Promise<DesktopPluginMutationImpact>>()
      .mockResolvedValueOnce(first).mockResolvedValue(next)
    const confirm = vi.fn(async (_detail: string) => true)
    await confirmDesktopPluginMutation({ messages: en, readImpact, confirm, cancelled: () => false })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(readImpact).toHaveBeenCalledTimes(3)
  })

  it.each(['before', 'after'])('fails closed when impact is unavailable %s confirmation', async (when) => {
    const readImpact = vi.fn<() => Promise<DesktopPluginMutationImpact>>()
    if (when === 'after') readImpact.mockResolvedValueOnce(impact())
    readImpact.mockRejectedValue(new Error('private transport diagnostic'))
    const confirm = vi.fn(async (_detail: string) => true)
    await expect(confirmDesktopPluginMutation({ messages: en, readImpact, confirm, cancelled: () => false }))
      .rejects.toThrow(en.pluginImpactUnavailable)
    expect(confirm).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
  })

  it.each(['deadline', 'quit'])('aborts the actual in-flight impact reader on %s', async (reason) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const readImpact = (signal: AbortSignal): Promise<DesktopPluginMutationImpact> => {
      received = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('transport cancelled')), { once: true }))
    }
    try {
      const pending = confirmDesktopPluginMutation({
        messages: en, readImpact, confirm: async () => true, cancelled: () => false, signal: controller.signal,
      })
      const failure = expect(pending).rejects.toThrow(reason === 'quit' ? en.pluginMutationCancelled : en.pluginImpactUnavailable)
      if (reason === 'quit') controller.abort()
      else await vi.advanceTimersByTimeAsync(5000)
      await failure
      expect(received?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('does not read or confirm after quit begins', async () => {
    const readImpact = vi.fn(async () => impact()), confirm = vi.fn(async (_detail: string) => true)
    await expect(confirmDesktopPluginMutation({ messages: en, readImpact, confirm, cancelled: () => true }))
      .rejects.toThrow(en.pluginMutationCancelled)
    expect(readImpact).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
})
