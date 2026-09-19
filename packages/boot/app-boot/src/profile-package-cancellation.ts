/** Explicit post-cleanup cancellation acknowledgement for launcher-owned package staging. */
export class ProfilePackageCancelledError extends Error {
  constructor() {
    super('Package preparation was cancelled after owned work and cleanup settled')
    this.name = 'ProfilePackageCancelledError'
  }
}
