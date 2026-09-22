# Agent Note: Official-first Desktop safety migration

Status: proposed

English | [中文](2026-09-18-official-first-desktop-safety.zh.md)

## Problem

The official `0.1.6-alpha.2` Desktop shares the Web application, plugin manager, and update presentation. Carrying forward the fork's separate plugin window, framed byte-pipe Host, and protocol-2 update strip duplicates official ownership. Deleting the fork's acquisition, snapshot, isolation, and rollback rules at the same time would remove safety properties that a shared interface alone does not establish.

## Proposal

Core#67 integrates the official Web-backed Host and shared `runProfile` topology. The official PluginManager remains the sole management UI. A typed app-boot transaction backend is proposed to preserve restricted acquisition and staging without allowing a request-serving Host to stop itself. This integration is WIP: source declarations or retained helper tests do not establish a usable, verified, or published transaction path.

The backend should stage a private candidate and report PREPARED (`state: 'prepared'`), with transaction identity, base fingerprint, and health status. PREPARED is neither an active receipt nor authorization to stop a Host. A separate shell-owned action must obtain current interruption authorization before health-check interruption, promotion, and final-location activation. Recheck the base fingerprint under one canonical external lease, reject stale candidates, and retain the old profile and recovery journal until final-location Host readiness and inventory verification. Preserve the journal and rollback data if restoration fails; two renames are recoverable, not crash-atomic.

### Official-first decisions

| Customization | Official evidence at `0.1.6-alpha.2` | Decision and return condition |
|---|---|---|
| Separate update strip and protocol 2 | Settings `DesktopUpdateIndicator`, collapsed `DesktopUpdateBadge`, and protocol-1 `status`/`open`/`subscribe` already own presentation | Retire the duplicate strip and its adapter; use the official owner, not a second polling UI. |
| Unsaved-input update protection | Official task inspection does not by itself establish coverage of every mounted draft, attachment, or pending send | Retain only optional scalar `reportImpact` (`hasDraft`, `attachmentCount`, `submitting`); remove it when official equivalent coverage is verified. It can block installation, never authorize it or carry content. |
| Fork plugin window and plugin IPC | Shared Web PluginManager and authenticated HTTP routes own management | Retire the separate UI; migrate the justified backend safety through typed app-boot integration. Do not claim those operations ready before end-to-end qualification. |
| Source snapshots and verified releases | Shared package installation is not evidence of equivalent immutable acquisition, snapshot reconstruction, ownership retention, or rollback | Retain the existing mechanisms and migrate their consumers; retire only after equivalent official behavior and failure coverage are verified. |
| InputHub shell and detached-send safety | Official conversation/input changes require a consumer migration; name similarity is not parity evidence | Retain InputHub and migrate shell/detached-send handling; require draft, attachment, in-flight send, disposal, and navigation regressions before removing any adapter. |
| Ancestor SDK/package confinement | Runtime resolution generations do not alone confine ancestor package lookup | Retain profile/shared-package and inherited Worker constraints; require equivalent native resolution and negative escape cases before retirement. |
| Windows filesystem birthtime | A general file identity check does not establish delete/recreate detection on Windows | Retain the birthtime distinction until a Windows replacement regression demonstrates official parity. |
| Multiline Goal editing | An official Goal control does not establish multiline objective editing parity | Retain the multiline behavior until line-break preservation and existing Goal actions pass equivalent UI coverage. |
| Manual compaction model selection | Partial: exact official `0.1.6-alpha.2` and the pre-merge candidate use the durable prior request route rather than the accepted current selector snapshot; evidence owners are `packages/compaction/compaction-basic/src/index.ts` and `packages/core/agent/src/model-selection.ts` | Retain PR #92's once-captured owner-scoped selection at maintenance acceptance for policy and the default summary target; explicit summary overrides still take precedence, and automatic pressure/overflow keeps the durable route. Retire only after equivalent official selection, scope, cancellation, error, UI, and replay coverage is verified. |

### Retained rationale and partial supersession

The [source snapshot decision](../../implemented/feature/2026-09-17-desktop-plugin-source-snapshots.md) retains the restricted input grammar, prebuilt-output validation, hook rejection, isolated packing, content-addressed archives, explicit same-version replacement, and damaged-snapshot removal rules. A snapshot identifies bytes, not a publisher; a verified source must never silently degrade into a registry or general source. These constraints remain necessary behind the shared UI.

The [verified release transaction decision](../../implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.md) retains immutable release/asset/checksum binding, bounded allowlisted acquisition, application-package peer identity, ancestor lookup confinement, staged reconstruction, rollback, and final-location completion requirements. The [retention decision](../../implemented/bug-fix/2026-09-17-desktop-plugin-retention-and-lockfiles.md) retains user-versus-release ownership, conservative legacy inference, exact-plan removal, optional failure isolation, and artifact-backed Windows separator normalization without weakening frozen installs. They are partial supersessions: backend rationale survives, while the old shell-only exposure is not current authority for the new UI.

The [persistent-notice decision](../../implemented/feature/2026-09-17-persistent-desktop-update-notice.md) is partially superseded. Its duplicate presentation and polling realization are retired; noninterrupting discovery, shell-owned update authority, and unsaved-input protection still guide migration. Keep it active and cross-linked rather than archiving a mixed current/retired decision or rewriting it into its opposite. Already sealed archive triplets and their original hashes remain unchanged; incoming official archive seals remain intact.

The [fork release-channel decision](../../implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.md) continues to own unsigned managed discovery, verified helper handoff, and installed-completion evidence. Signed native and unsigned managed modes remain mutually exclusive. A dependency-free copied-helper acknowledgement, an isolated Models fixture, a prepared profile, and authenticated provider usability are different observations; none substitutes for the others.

## Alternatives considered

**Keep both plugin managers and both update indicators.** This preserves old wiring but creates competing ownership, duplicates user actions, and misses the official-first requirement.

**Take the official implementation wholesale and discard every fork safety rule.** This removes code without establishing equivalent acquisition integrity, reconstruction, isolation, unsaved-input protection, or recoverable activation.

**Activate from the staging request.** This can stop the Host serving that request, conflate prepared bytes with user consent, and lose the response. Separate preparation from shell-owned, explicitly authorized activation.

**Archive all older fork notes now.** Their security, durable-data, and rollback rationale remains useful, and the migration is unqualified. Partial supersession requires active cross-links, not sealed history used as present authority.

## Acceptance criteria

- The official PluginManager is the only management UI; protocol 1 owns update presentation, with no fork strip or protocol-2 requirement.
- PREPARED survives cancellation and status queries without live activation, successful active receipts, or Host interruption. Concurrent requests, stale fingerprints, process exit, and restart recovery fail closed under the same lease.
- Malicious archives, hooks, source drift, corrupted retained artifacts, peer identity conflicts, ancestor SDK lookup, and Worker inheritance retain their negative tests. Windows birthtime and artifact-lock separator cases run on Windows.
- Explicitly authorized shell activation verifies staged health, final-location readiness, actual inventory and receipts, and rollback on failure. No successful receipt is recorded for an optional failure or preparation alone.
- Official update UI and InputHub migration receive mounted-composer, detached-send, stale-report, disposal, and multiline Goal browser evidence. Installation never accepts scalar impact reporting as consent.
- Manual compaction uses the accepted selection without consuming a pending chat selection. `MAX_TOKENS` / `summary-truncated` fails closed without increasing the output cap, retrying, or committing an incomplete checkpoint. Scoped cancellation, error, UI, and replay checks do not establish oversized-history rescue, live-provider acceptance, or qualification of the alpha2 candidate.
- [Own-input scroll following](../../../../packages/client/ui-chat/README.md#scroll-ownership) survives an ordered local-echo/durable-append transition while a reader sample is pending, without weakening first-open restoration, paging anchors or later reader intent. Real browser acceptance remains required; a truncated historical trace cannot establish the internal ordering.
- Documentation pairing, archive seals, focused unit tests, integrated build/type checks, and isolated packaged release qualification pass on the exact selected source. Existing installations, active Sessions, and immutable releases remain untouched during qualification.

## Risks

The typed transaction backend requires coordinated app-boot, PluginManager, launcher, and shell changes. Leaving any consumer on in-place mutation or old IPC can bypass staging or deadlock the profile lease. Retained helpers alone do not qualify the integrated path; full tests and packaged acceptance remain outstanding. Migration does not authorize installation, activation, restart, or publication. Existing readonly source evidence and prior release tests cannot be promoted into acceptance of this WIP.
