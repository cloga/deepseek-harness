/** Auto-card fixtures with the same asynchronous settings-write contract as the Client scope. */

import { vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AutoRoutingSettings } from '../src/client/auto-model-routing-form.ts'

/**
 * Preserve the common publication fixture while typing and wiring its mutation as Promise-returning.
 * @returns The settings scope, the exact mutation spy it calls, and publication controls.
 */
export function autoRoutingSettingsScope() {
  const fixture = stubSettingsScope<AutoRoutingSettings>()
  const mutate = vi.fn<SettingsScope<AutoRoutingSettings>['mutate']>(() => Promise.resolve())
  return { ...fixture, mutate, scope: { ...fixture.scope, mutate } }
}

/**
 * Create a controllable Promise without requiring the ES2024 withResolvers library.
 * @returns The Promise and its synchronous resolver/rejecter capabilities.
 */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}
