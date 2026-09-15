import { describe, expect, it } from 'vitest'
import { parseDesktopRendererUpdateImpact } from '../src/ipc.ts'

describe('managed update renderer impact', () => {
  it('accepts only the fixed unsaved-state report', () => {
    expect(parseDesktopRendererUpdateImpact({
      hasDraft: true,
      attachmentCount: 2,
      submitting: false,
    })).toEqual({ hasDraft: true, attachmentCount: 2, submitting: false })
    expect(() => parseDesktopRendererUpdateImpact({
      hasDraft: true,
      attachmentCount: 2,
      submitting: false,
      executable: 'arbitrary.exe',
    })).toThrow(/invalid update impact/u)
    expect(() => parseDesktopRendererUpdateImpact({
      hasDraft: false,
      attachmentCount: -1,
      submitting: false,
    })).toThrow(/invalid update impact/u)
  })
})
