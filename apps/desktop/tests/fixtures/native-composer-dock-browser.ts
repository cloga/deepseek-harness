/** Standalone DOM measurement for the actual renderer's public, layout-neutral dock outlet. */
import type { NativeComposerGeometry } from './native-composer-geometry.ts'

/**
 * Measure one public dock's physical owner and actual statistics controls atomically.
 * Null means only that controls are absent or temporarily have no rendered box; structural mismatches throw.
 * @param anchor - The unique conversation.composer.dock outlet, not a native pill's immediate parent.
 * @returns A complete browser observation, or null while the same outlet is not laid out.
 */
export function measureNativeComposerDock(anchor: Element): NativeComposerGeometry | null {
  if (anchor.getAttribute('data-slot') !== 'conversation.composer.dock'
    || getComputedStyle(anchor).display !== 'contents') {
    throw new Error('Expected the renderer public display:contents composer dock outlet')
  }
  let owner = anchor.parentElement
  let skipped = 0
  while (owner !== null && getComputedStyle(owner).display === 'contents') {
    if (++skipped > 4) throw new Error('Composer dock has too many layout-neutral ancestor wrappers')
    owner = owner.parentElement
  }
  if (owner === null || owner === document.body || owner === document.documentElement) {
    throw new Error('Composer dock has no bounded physical owner')
  }
  const ownerDisplay = getComputedStyle(owner).display
  if (ownerDisplay === 'none') return null
  if (ownerDisplay !== 'flex' && ownerDisplay !== 'inline-flex') {
    throw new Error('Composer dock physical owner must retain its shared flex layout')
  }
  const stats = anchor.querySelectorAll('[data-composer-stats]')
  const copilot = anchor.querySelectorAll('[data-copilot-usage-trigger]')
  if (stats.length > 1 || copilot.length > 1) throw new Error('Composer dock statistics controls are ambiguous')
  if (stats.length === 0 || copilot.length === 0) return null
  const native = stats[0]!.querySelectorAll('button')
  if (native.length > 2) throw new Error('Composer dock has unexpected native statistics controls')
  if (native.length !== 2) return null
  const physicalOwner = owner
  const controls = [native[0]!, native[1]!, copilot[0]!]
  if (!controls.every(control => anchor.contains(control) && physicalOwner.contains(control))) {
    throw new Error('Composer dock owner must contain every actual statistics control')
  }
  if (controls.some(control => getComputedStyle(control).visibility !== 'visible')) return null
  const boxes = [physicalOwner, ...controls].map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  if (boxes.some(box => box.width <= 0 || box.height <= 0)) return null
  const nativeStyle = getComputedStyle(native[1]!)
  const copilotStyle = getComputedStyle(copilot[0]!)
  return {
    viewportWidth: window.innerWidth,
    dock: boxes[0]!, time: boxes[1]!, usage: boxes[2]!, copilot: boxes[3]!,
    nativeStyle: { fontSize: nativeStyle.fontSize, lineHeight: nativeStyle.lineHeight, color: nativeStyle.color },
    copilotStyle: { fontSize: copilotStyle.fontSize, lineHeight: copilotStyle.lineHeight, color: copilotStyle.color },
  }
}
