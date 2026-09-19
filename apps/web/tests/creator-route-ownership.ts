/** Test-private release of one held Creator request before removing its interception handler. */

/** An assertion or registration failure can itself be undefined; absence is a separate outcome. */
export type CreatorRoutePrimaryOutcome =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown }

/** Only the continuation owned by this fixture is exposed to cleanup. */
interface HeldCreatorRoute {
  continue(): Promise<void>
}

/**
 * Settle one owned continuation before removing its exact handler, retaining every original failure.
 * @param primary - Outcome of route registration and the assertions while the request was held.
 * @param route - Synchronously captured route, absent when interception never reached the handler.
 * @param removeHandler - Remove only this fixture's handler, even after continuation failure.
 * @returns Only after successful body and cleanup; otherwise rejects with original error identities.
 */
export async function finishCreatorRoute(
  primary: CreatorRoutePrimaryOutcome,
  route: HeldCreatorRoute | undefined,
  removeHandler: () => Promise<void>,
): Promise<void> {
  const cleanupErrors: unknown[] = []
  if (route !== undefined) {
    try { await route.continue() } catch (error) { cleanupErrors.push(error) }
  }
  try { await removeHandler() } catch (error) { cleanupErrors.push(error) }

  if (primary.failed) {
    if (cleanupErrors.length !== 0) {
      throw new AggregateError([primary.error, ...cleanupErrors], 'Creator request assertions failed and route cleanup is incomplete', { cause: primary.error })
    }
    throw primary.error
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Creator route cleanup is incomplete', { cause: cleanupErrors[0] })
  }
}
