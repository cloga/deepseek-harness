import { describe, expect, it } from 'vitest'
import { DesktopUpdateInputGuard } from '../src/update-input-guard.ts'

const clear = { hasDraft: false, attachmentCount: 0, submitting: false }

describe('Desktop unsent input admission', () => {
  it('requires a known clear document and invalidates navigation generations', () => {
    const guard = new DesktopUpdateInputGuard()
    expect(() => guard.check('preserve input')).toThrow('preserve input')
    guard.report(clear)
    const revision = guard.check('preserve input')
    guard.report(clear)
    expect(guard.check('preserve input', revision)).toBe(revision)
    guard.reset()
    expect(() => guard.check('preserve input')).toThrow('preserve input')
  })

  it.each([
    { ...clear, hasDraft: true },
    { ...clear, attachmentCount: 2 },
    { ...clear, submitting: true },
  ])('blocks each unsent state and rejects a stale approval after it clears: %j', (impact) => {
    const guard = new DesktopUpdateInputGuard()
    guard.report(clear)
    const approved = guard.check('preserve input')
    guard.report(impact)
    expect(() => guard.check('preserve input')).toThrow('preserve input')
    guard.report(clear)
    expect(() => guard.check('preserve input', approved)).toThrow('preserve input')
    expect(guard.check('preserve input')).toBeGreaterThan(approved)
  })

  it('invalidates a previously clear state on malformed or overpowered IPC', () => {
    const guard = new DesktopUpdateInputGuard()
    guard.report(clear)
    expect(() => { guard.report({ ...clear, executable: 'untrusted.exe' }) }).toThrow('invalid update impact')
    expect(() => guard.check('preserve input')).toThrow('preserve input')
  })
})
