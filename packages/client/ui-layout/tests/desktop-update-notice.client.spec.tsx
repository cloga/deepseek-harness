// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import { DesktopUpdateNotice } from '../src/client/DesktopUpdateNotice.tsx'
import type { DesktopUpdateSnapshot, DesktopUpdateState } from '../src/client/desktop-update-adapter.ts'
import { en, zh } from '../src/client/locales.ts'

const t: PropsLocale<'layout'>['t'] = key => Object.hasOwn(en, key) ? en[key as keyof typeof en] : key
const notice = (state: DesktopUpdateState | null): DesktopUpdateSnapshot => ({ state, reviewing: false, reviewFailed: false })
afterEach(cleanup)

describe('Desktop update notice presentation', () => {
  it.each([null, { phase: 'idle' }, { phase: 'checking', version: '2.0.0' }, { phase: 'error' }] as const)(
    'occupies no space without an actionable version: %j', (state) => {
      const review = vi.fn(async () => {})
      const view = render(<DesktopUpdateNotice t={t} notice={notice(state)} review={review} />)
      expect(view.container.childElementCount).toBe(0)
      expect(review).not.toHaveBeenCalled()
    },
  )

  it('shows the parent snapshot without installing, opening review, or stealing focus', () => {
    const review = vi.fn(async () => {})
    const focused = document.activeElement
    render(<DesktopUpdateNotice t={t} notice={notice({ phase: 'available', version: '2.0.0' })} review={review} />)
    expect(screen.getByRole('status').textContent).toContain('Update available')
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(focused)
    expect(review).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }))
    expect(review).toHaveBeenCalledOnce()
  })

  it.each([
    ['installing', 'Preparing update'], ['ready', 'Update ready'],
  ] as const)('shows %s and disables explicit review', (phase, title) => {
    const review = vi.fn(async () => {})
    render(<DesktopUpdateNotice t={t} notice={notice({ phase, version: '2.0.0' })} review={review} />)
    expect(screen.getByRole('status').textContent).toContain(title)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(review).not.toHaveBeenCalled()
  })

  it('projects review progress, failure, and recovery from parent props', () => {
    const review = vi.fn(async () => {})
    const available = notice({ phase: 'available', version: '2.0.0' })
    const view = render(<DesktopUpdateNotice t={t} notice={{ ...available, reviewing: true }} review={review} />)
    expect(screen.getByRole('button', { name: en['desktopUpdate.reviewing'] }).hasAttribute('disabled')).toBe(true)
    view.rerender(<DesktopUpdateNotice t={t} notice={{ ...notice({ phase: 'error', version: '2.0.0' }), reviewFailed: true }} review={review} />)
    expect(screen.getByRole('status').textContent).toContain('Update incomplete')
    expect(screen.getByRole('alert').textContent).toBe(en['desktopUpdate.reviewFailed'])
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false)
    view.rerender(<DesktopUpdateNotice t={t} notice={available} review={review} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
  })

  it('uses the locale-owned translator for every notification label', () => {
    const translate: PropsLocale<'layout'>['t'] = key => Object.hasOwn(zh, key) ? zh[key as keyof typeof zh] : key
    render(<DesktopUpdateNotice t={translate} notice={{ ...notice({ phase: 'available', version: '2.0.0' }), reviewFailed: true }} review={async () => {}} />)
    expect(screen.getByRole('button').textContent).toBe(zh['desktopUpdate.review'])
    expect(screen.getByRole('status').textContent).toContain(zh['desktopUpdate.available'])
    expect(screen.getByRole('alert').textContent).toBe(zh['desktopUpdate.reviewFailed'])
  })
})
