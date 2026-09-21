/** Owned inert evidence builders for producer/consumer tests; never actual renderer or model observations. */
import type { CopilotSettingsEvidence } from './fixtures/copilot-settings-smoke.ts'
import type { NativeComposerInspection } from './fixtures/native-composer-geometry.ts'

export function currentCopilotSettings(): CopilotSettingsEvidence {
  return { schemaVersion: 3, accountViewLoaded: true, retiredModelRolesAbsent: true, searchProviderCatalogLoaded: true,
    providerOnlySearchRouting: true, fallbackProviderLabel: true, registeredSearchProviders: ['github-copilot-hosted'], realSearch: false }
}
export function nativeComposerSeed() {
  return { sessionId: 'desktop-inline-composer-synthetic', scope: 'test-owned-persisted-session-with-synthetic-history-and-token-counts',
    workspaceRegistered: true, provider: 'github-copilot', seederModelCalls: 0, liveAccountQuota: false }
}
export function nativeComposerInspection(): NativeComposerInspection {
  return {
    geometry: [1280, 400].map(viewportWidth => ({
      viewportWidth, dock: { x: 16, y: 0, width: viewportWidth - 32, height: 40 },
      time: { x: 20, y: 5, width: 80, height: 20 }, usage: { x: 112, y: 5, width: 100, height: 20 },
      copilot: { x: 224, y: 5, width: 100, height: 20 },
      nativeStyle: { fontSize: '13px', lineHeight: '18px', color: 'rgb(1, 2, 3)' },
      copilotStyle: { fontSize: '13px', lineHeight: '18px', color: 'rgb(1, 2, 3)' },
    })),
    nativeDialogs: {
      time: { opened: true, closedOnEscape: true, focusReturned: true },
      usage: { opened: true, closedOnEscape: true, focusReturned: true },
    },
    copilotDialog: { signedOutObserved: true, sessionCreditsCount: 0, resetCount: 0, epochTextCount: 0, focusReturned: true },
  }
}
