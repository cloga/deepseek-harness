/** Standalone DOM measurement for the actual renderer's public, layout-neutral dock outlet. */
interface Box { x: number; y: number; width: number; height: number }
interface PillStyle { fontSize: string; lineHeight: string; color: string }

/** One browser-measured viewport of the native composer; this leaf has no Host dependencies. */
export interface NativeComposerGeometry {
  readonly viewportWidth: number
  readonly dock: Box
  readonly time: Box
  readonly usage: Box
  readonly copilot: Box
  readonly nativeStyle: PillStyle
  readonly copilotStyle: PillStyle
}

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
  const time = anchor.querySelectorAll('button[aria-label="1 turns 1 steps"]')
  const usage = anchor.querySelectorAll('button[aria-label="105 tok · Cache hit 90%"]')
  const copilot = anchor.querySelectorAll('button[data-copilot-usage-trigger]')
  if ([time, usage, copilot].some(matches => matches.length > 1)) throw new Error('Composer dock statistics controls are ambiguous')
  if ([time, usage, copilot].some(matches => matches.length === 0)) return null
  const physicalOwner = owner
  const controls = [time[0]!, usage[0]!, copilot[0]!]
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
