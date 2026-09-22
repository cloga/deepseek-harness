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
  const outlets = document.querySelectorAll('[data-slot="conversation.composer.dock"]')
  if (outlets.length !== 1 || outlets[0] !== anchor) throw new Error('Native statistics require one unique public composer dock outlet')
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
  // Labels belong to the actual seeded native buttons. Keep them inside this serialized browser function.
  const time = anchor.querySelectorAll('button[aria-haspopup="dialog"][aria-label="1 turns 1 steps"]')
  const usage = anchor.querySelectorAll('button[aria-haspopup="dialog"][aria-label="105 tok · Cache hit 90%"]')
  const copilot = anchor.querySelectorAll('[data-copilot-usage-trigger]')
  if (time.length > 1 || usage.length > 1 || copilot.length > 1) throw new Error('Composer dock statistics controls are ambiguous')
  if (time.length === 0 || usage.length === 0 || copilot.length === 0) return null
  for (const control of [time[0]!, usage[0]!]) {
    const role = control.getAttribute('role')
    if ((role !== null && role !== 'button') || control.hasAttribute('aria-labelledby')) {
      throw new Error('Native statistics must retain their exact button role and aria-label contract')
    }
  }
  const physicalOwner = owner
  const controls = [time[0]!, usage[0]!, copilot[0]!]
  if (new Set(controls).size !== 3) throw new Error('Composer dock statistics controls must be distinct')
  if (!controls.every(control => anchor.contains(control) && physicalOwner.contains(control))) {
    throw new Error('Composer dock owner must contain every actual statistics control')
  }
  if (controls.some(control => getComputedStyle(control).visibility !== 'visible')) return null
  const boxes = [physicalOwner, ...controls].map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  if (boxes.some(box => box.width <= 0 || box.height <= 0)) return null
  const nativeStyle = getComputedStyle(usage[0]!)
  const copilotStyle = getComputedStyle(copilot[0]!)
  return {
    viewportWidth: window.innerWidth,
    dock: boxes[0]!, time: boxes[1]!, usage: boxes[2]!, copilot: boxes[3]!,
    nativeStyle: { fontSize: nativeStyle.fontSize, lineHeight: nativeStyle.lineHeight, color: nativeStyle.color },
    copilotStyle: { fontSize: copilotStyle.fontSize, lineHeight: copilotStyle.lineHeight, color: copilotStyle.color },
  }
}
