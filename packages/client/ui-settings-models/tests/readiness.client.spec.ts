/** Pure first-run readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingReadiness, providerUsable } from '../src/client/store.ts'

const missingCredential: CredentialView = { configured: false, writable: true }
const TARGET = 'primary'

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: TARGET,
      displayName: 'Primary',
      settingsNs: 'llm-primary',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'PRIMARY_API_KEY',
    credential: missingCredential,
    ...overrides,
  }
}

/** A second provider the user configured themselves. */
function otherRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'hfai',
      displayName: 'HFAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'hfai'],
      active: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: 'HFAI_API_KEY',
    credential: { configured: true, source: 'file', writable: true },
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [row()],
    namespaces: new Map(),
    ...overrides,
  }
}

describe('providerUsable', () => {
  it('requires a registered route and a stored key for every named reference', () => {
    expect(providerUsable(otherRow())).toBe(true)
    expect(providerUsable(otherRow({ entry: { ...otherRow().entry, active: false } }))).toBe(false)
    expect(providerUsable(otherRow({ credential: missingCredential }))).toBe(false)
    expect(providerUsable(otherRow({ credential: undefined }))).toBe(false)
  })

  it('treats a reference-free registered route as provider-native authentication', () => {
    expect(providerUsable(otherRow({ apiKeyEnv: undefined, credential: undefined }))).toBe(true)
    expect(providerUsable(otherRow({
      configured: false,
      apiKeyEnv: undefined,
      credential: undefined,
    }))).toBe(false)
    expect(providerUsable(otherRow({
      configured: false,
      entry: { ...otherRow().entry, settingsNs: '', settingsPath: [] },
      apiKeyEnv: undefined,
      credential: undefined,
    }))).toBe(true)
  })
})

describe('onboardingReadiness', () => {
  it('waits for the first join and skips onboarding when the adapter directory entry is absent', () => {
    expect(onboardingReadiness(state({ status: 'idle', rows: [] }), TARGET)).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ status: 'loading', rows: [] }), TARGET)).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ rows: [] }), TARGET)).toEqual({ kind: 'adapter-absent' })
    expect(onboardingReadiness(state({
      rows: [row({
        entry: {
          ...row().entry,
          settingsNs: '',
        },
      })],
    }), TARGET)).toEqual({ kind: 'adapter-absent' })
    expect(onboardingReadiness(state({
      rows: [row({ configured: false })],
    }), TARGET)).toEqual({ kind: 'adapter-absent' })
  })

  it('reports a missing writable effective credential', () => {
    expect(onboardingReadiness(state(), TARGET)).toEqual({ kind: 'credential-missing' })
  })

  it('ends onboarding once any other registered provider can serve requests', () => {
    expect(onboardingReadiness(state({ rows: [row(), otherRow()] }), TARGET)).toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({
      rows: [row(), otherRow({ apiKeyEnv: undefined, credential: undefined })],
    }), TARGET)).toEqual({ kind: 'provider-ready' })
    // A provider the user cannot reach yet leaves the prompt in place.
    expect(onboardingReadiness(state({
      rows: [row(), otherRow({ credential: missingCredential })],
    }), TARGET)).toEqual({ kind: 'credential-missing' })
  })

  it('accepts file and process-environment credentials without prompting', () => {
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'file', writable: true } })],
    }), TARGET)).toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'env', writable: false } })],
    }), TARGET)).toEqual({ kind: 'provider-ready' })
  })

  it('turns missing capabilities into diagnostics that never block the product', () => {
    expect(onboardingReadiness(state({ status: 'error', error: 'settings down' }), TARGET)).toEqual({
      kind: 'unavailable',
      reason: 'load-failed',
    })
    expect(onboardingReadiness(state({
      rows: [row({ entry: { ...row().entry, active: false } })],
    }), TARGET)).toEqual({ kind: 'unavailable', reason: 'provider-inactive' })
    expect(onboardingReadiness(state({
      credentialError: 'credentials service is absent',
    }), TARGET)).toEqual({
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    })
    expect(onboardingReadiness(state({
      rows: [row({ credential: undefined })],
    }), TARGET)).toEqual({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: false, writable: false } })],
    }), TARGET)).toEqual({ kind: 'unavailable', reason: 'credential-read-only' })
    expect(onboardingReadiness(state({ writable: false }), TARGET)).toEqual({
      kind: 'unavailable',
      reason: 'settings-read-only',
    })
  })
})
