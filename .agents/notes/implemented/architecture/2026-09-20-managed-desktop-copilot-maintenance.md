# Agent Note: Qualify managed Desktop Copilot maintenance separately from Core promotion

Status: implemented

English | [中文](2026-09-20-managed-desktop-copilot-maintenance.zh.md)

## Problem

The managed Windows Desktop must advance its release-owned Copilot package without silently promoting the Core baseline or carrying companion behavior after official Core provides complete parity. Plugin publication, Core compatibility, packaged Desktop behavior, and installed-machine activation are separate evidence.

Copilot-only maintenance preserves the reviewed Core baseline independently of plugin selection. The alpha.2 Desktop candidate incorporates immutable [Copilot `0.4.0-alpha.33`](https://github.com/cloga/dsh-github-copilot/releases/tag/v0.4.0-alpha.33) and its maintenance acceptance requirements. Copilot alpha.33 supports both Core alpha.1 and alpha.2, but that compatibility does not qualify the Core alpha.2 Desktop adaptation.

## Decision

A Copilot-only Desktop maintenance release keeps the reviewed Core baseline and exact dependency registry while replacing the complete verified-release source lock. The plan binds the release tag, asset identifiers, byte sizes, SHA-256, SHA-512 SRI, target source, and checksum manifest. Tests compare the complete provisioning object rather than selected fields. This decision refines provider-release selection and official-first review; the [verified release transaction](2026-09-15-desktop-verified-release-plugin-transactions.md) remains authoritative for acquisition, staging, ownership, rollback, and receipts.

Packaged acceptance stays signed out and read-only. It checks the real account and Manage surfaces, the absence of the retired compatibility disclosure, the read-only Model roles view, provider-only **Search provider** and **Fallback provider** controls, the registered provider catalog, exact provisioning inventory, and restart-stable receipts. It awaits the visible signed-out account and sign-in entry before checking for absent quota controls and credit summaries on initial startup and restart. This DOM evidence does not observe Host quota packets, live account access, or Session billing; the immutable plugin's gateway regression owns its no-startup/signed-out-network claim. It never saves settings, initiates OAuth, opens a verification address, calls a model or search provider, requests live quota, or changes a profile. Copilot's own synthetic Client tests cover Desktop same-window verification navigation, Web new-tab behavior, and selectable manual URL handoff; the Desktop acceptance does not repeat those actions against an operator browser.

Alpha.28 retains plugin-owned independent prompt and combined input/output admission while signaling the official bounded compaction path. Alpha.29 retains provider-only routing, one routing-namespace compare-and-swap, one distinct final fallback, and account-owned Copilot search-model resolution without a model prerequisite. Alpha.30 retains the existing Desktop external-navigation handoff and manual selectable verification address. Alpha.31 delegates OAuth renewal and credential persistence to native ownership while retaining bounded managed-route HTTP 401 proof retirement. Alpha.32 adds normalized account quota snapshots and optional Session-scoped composer presentation without replacing the native Context meter or inventing Session credits. These behaviors remain plugin-owned where official Core does not provide equivalent policy.

Alpha.33 repairs the Client's required `useSession(selector)` call without changing Core. Original archive comparison against its direct alpha.32 predecessor preserves dependencies, exports, all 36 capability IDs and compaction behavior; Host JavaScript changes only its embedded version, while the other four runtime JavaScript files remain identical. Positive synthetic-Session acceptance supplements the signed-out checks using the actual packaged renderer and released Client; the [release-channel decision](2026-09-15-fork-owned-windows-desktop-release-channel.md#positive-packaged-plugin-acceptance) owns isolation and evidence limits. Core alpha.1 and alpha.2 already provide the selector hook and Slot error boundary; the plugin conforms to those official APIs rather than adding a Core fallback.

## Official-first comparison

The exact official review target is [Core `0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2). The plugin's [alpha.2 comparison](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/official-first-016-alpha2.md), [compaction decision](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/copilot-compaction.md), and [account-usage contract](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.33/docs/copilot-usage.md) provide the source-level evidence.

| Area | Official alpha.2 support | Decision and migration condition |
|---|---|---|
| OAuth, normal Copilot transport, strict Remote factories, service tracing, serialized initialization, native subagent descriptors | Complete primitives used by alpha.33 | Continue official primitives. Retire the alpha.1 compatibility bridge only after the supported Core floor advances and packaged alpha.2 acceptance passes. |
| Managed HTTP 401 recovery | Native `Models.getAuth()` and canonical credentials own renewal and persistence; Core does not own Copilot route proof, identical-token rejection, cooldown, or generation races | Retain only bounded managed-route rejection policy. Retire it when official provider transport exposes equivalent provider-scoped rejected-token renewal and Desktop qualification. |
| Account quota and composer usage | Public Remote codecs and the native Context meter are official primitives; Core does not expose complete provider-reported Copilot quota, credits, or Session attribution | Retain normalized account snapshots and optional Copilot Session UI. Retire them when official APIs provide equivalent account semantics and a supported Session-scoped composer seam. |
| Account-owned model discovery | Partial; the official catalog does not replace authenticated Copilot account refresh and ownership proof | Retain discovery, proof, cache, cooldown, and route handling until official account and entitlement discovery preserves supported endpoint, capability, route, Session, and profile state. |
| Cross-provider search routing | Partial; official provider selection does not supply the complete initiating-Chat, explicit primary, one-final-fallback, cancellation, account-invalidation, disclosure, and legacy-migration policy | Retain the provider-only companion policy until official settings and runtime provide equivalent behavior and migration tests. |
| Compaction and recovery | Partial; official bounded compaction is authoritative, while Copilot-specific independent admission and summary-purpose defaults are not official policy | Reuse official recovery. Retire companion admission/defaults only after official behavior enforces equivalent provider budgets and oversized-history acceptance. |
| Plugin Manager and runtime unload | Available in alpha.2 | The alpha.2 candidate adopts those primitives in source; packaged qualification of exact source conversion, ownership retention, staged health, rollback, recovery, and runtime behavior remains pending. |
| Desktop verification navigation | Existing Desktop navigation owns same-window external handoff; Copilot still owns provider-specific presentation and manual recovery | Retire plugin glue only when official provider/account UI supplies equivalent Desktop handoff, manual URL, cancellation, and packaged acceptance. |

No entire companion feature has sufficient parity evidence for removal solely from this maintenance update. The [official-first Desktop assessment](../../proposed/architecture/2026-09-18-official-first-desktop-safety.md) owns the alpha.2 source adoption and remaining artifact qualification; incorporating this maintenance work into that candidate does not establish packaged or installed acceptance.

## Publication evidence boundary

Copilot alpha.33 post-merge [run 35559690050](https://github.com/cloga/dsh-github-copilot/actions/runs/35559690050) passed compatibility, exact alpha.1/alpha.2 Windows/Ubuntu, verification and packaging checks and published the immutable GitHub Release; the overall run failed at npm publication/integrity verification. Read-only verifier [run 35560198211, attempt 2](https://github.com/cloga/dsh-github-copilot/actions/runs/35560198211/attempts/2) subsequently reported success. The original-asset review independently verified the GitHub tarball and checksum record, but did not acquire that verifier's receipt archive, so it provides no independent npm attestation. The Desktop consumes the already published immutable GitHub bytes; it neither republishes nor rewrites the plugin release.

This evidence does not establish live OAuth, model inference, hosted search, fallback charges, local installation, or activation. Those operations require separate authorization and must not be inferred from CI, package hashes, or packaged signed-out acceptance.

## Alternatives considered

**Treat the plugin pin as Core alpha.2 qualification.** Compatibility is not packaged qualification. A Copilot-only maintenance release preserves a narrow rollback point; a Core-upgrade candidate that incorporates it still requires its own artifact qualification.

**Delete companion behavior whose official primitive has a similar name.** Similar names do not establish policy, persistence, cancellation, or migration parity. Removal waits for the conditions in the comparison table.

**Exercise OAuth or search during Desktop packaging.** That would require account state, may incur charges, and would mutate acceptance state. Immutable bytes plus read-only UI, inventory, and restart checks are the release gate; live-provider checks remain separate.

## Consequences

Each managed Copilot update advances the Desktop version and sequence even when Core and shell code remain unchanged. The packaged release carries the exact plugin source and dependency registry, while Windows Ops can independently pin the resulting Desktop assets. A later Core promotion must refresh this comparison and satisfy its own packaged rehearsal before companion behavior is migrated or retired.
