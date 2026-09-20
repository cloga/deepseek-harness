# Agent Note: Qualify managed Desktop Copilot maintenance separately from Core promotion

Status: implemented

English | [中文](2026-09-20-managed-desktop-copilot-maintenance.zh.md)

## Problem

The managed Windows Desktop must advance its release-owned Copilot package without silently promoting the Core baseline or carrying companion behavior after official Core provides complete parity. Plugin publication, Core compatibility, packaged Desktop behavior, and installed-machine activation are separate evidence.

The current release plan retains Core `0.1.6-alpha.1` and pins immutable [Copilot `0.4.0-alpha.30`](https://github.com/cloga/dsh-github-copilot/releases/tag/v0.4.0-alpha.30). Copilot alpha.30 supports both Core alpha.1 and alpha.2, but that compatibility does not qualify the separately owned Core alpha.2 Desktop adaptation.

## Decision

A Copilot-only Desktop maintenance release keeps the reviewed Core baseline and exact dependency registry while replacing the complete verified-release source lock. The plan binds the release tag, asset identifiers, byte sizes, SHA-256, SHA-512 SRI, target source, and checksum manifest. Tests compare the complete provisioning object rather than selected fields. This decision refines provider-release selection and official-first review; the [verified release transaction](2026-09-15-desktop-verified-release-plugin-transactions.md) remains authoritative for acquisition, staging, ownership, rollback, and receipts.

Packaged acceptance stays signed out and read-only. It checks the real account and Manage surfaces, the absence of the retired compatibility disclosure, the read-only Model roles view, provider-only **Search provider** and **Fallback provider** controls, the registered provider catalog, exact provisioning inventory, and restart-stable receipts. It never saves settings, initiates OAuth, opens a verification address, calls a model or search provider, or changes a profile. Copilot's own synthetic Client tests cover Desktop same-window verification navigation, Web new-tab behavior, and selectable manual URL handoff; the Desktop acceptance does not repeat those actions against an operator browser.

Alpha.28 retains plugin-owned independent prompt and combined input/output admission while signaling the official bounded compaction path. Alpha.29 retains provider-only routing, one routing-namespace compare-and-swap, one distinct final fallback, and account-owned Copilot search-model resolution without a model prerequisite. Alpha.30 retains the existing Desktop external-navigation handoff and manual selectable verification address. These behaviors remain plugin-owned where official Core does not provide equivalent policy.

## Official-first comparison

The exact official review target is [Core `0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2). The plugin's [alpha.2 comparison](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.30/docs/official-first-016-alpha2.md) and [compaction decision](https://github.com/cloga/dsh-github-copilot/blob/v0.4.0-alpha.30/docs/copilot-compaction.md) provide the source-level evidence.

| Area | Official alpha.2 support | Decision and migration condition |
|---|---|---|
| OAuth, normal Copilot transport, strict Remote factories, service tracing, serialized initialization, native subagent descriptors | Complete primitives used by alpha.30 | Continue official primitives. Retire the alpha.1 compatibility bridge only after the supported Core floor advances and packaged alpha.2 acceptance passes. |
| Account-owned model discovery | Partial; the official catalog does not replace authenticated Copilot account refresh and ownership proof | Retain discovery, proof, cache, cooldown, and route handling until official account and entitlement discovery preserves supported endpoint, capability, route, Session, and profile state. |
| Cross-provider search routing | Partial; official provider selection does not supply the complete initiating-Chat, explicit primary, one-final-fallback, cancellation, account-invalidation, disclosure, and legacy-migration policy | Retain the provider-only companion policy until official settings and runtime provide equivalent behavior and migration tests. |
| Compaction and recovery | Partial; official bounded compaction is authoritative, while Copilot-specific independent admission and summary-purpose defaults are not official policy | Reuse official recovery. Retire companion admission/defaults only after official behavior enforces equivalent provider budgets and oversized-history acceptance. |
| Plugin Manager and runtime unload | Available in alpha.2 | Prefer those primitives only after the separate alpha.2 Desktop lane qualifies exact source conversion, ownership retention, staged health, rollback, recovery, and packaged runtime behavior. |
| Desktop verification navigation | Existing Desktop navigation owns same-window external handoff; Copilot still owns provider-specific presentation and manual recovery | Retire plugin glue only when official provider/account UI supplies equivalent Desktop handoff, manual URL, cancellation, and packaged acceptance. |

No entire companion feature has sufficient parity evidence for removal in this maintenance release. The separately owned alpha.2 draft remains independent; this release does not modify, merge, rebase, or absorb it.

## Publication evidence boundary

Copilot alpha.30 PR CI completed successfully across the alpha.1/alpha.2 and operating-system matrix in [run 35509010326](https://github.com/cloga/dsh-github-copilot/actions/runs/35509010326). Post-merge [run 35509515713](https://github.com/cloga/dsh-github-copilot/actions/runs/35509515713) reported failure after immutable GitHub publication and the npm step. Independent read-only verifier [run 35509895667, attempt 2](https://github.com/cloga/dsh-github-copilot/actions/runs/35509895667/attempts/2) passed and recorded publication verification plus GitHub/npm byte parity in artifact `10604789589`. The Desktop consumes the already published immutable GitHub bytes; it neither republishes nor rewrites the plugin release.

This evidence does not establish live OAuth, model inference, hosted search, fallback charges, local installation, or activation. Those operations require separate authorization and must not be inferred from CI, package hashes, or packaged signed-out acceptance.

## Alternatives considered

**Promote Core alpha.2 with the plugin pin.** Compatibility is not packaged qualification. Combining the lanes would absorb separately owned work and lose a narrow maintenance rollback point.

**Delete companion behavior whose official primitive has a similar name.** Similar names do not establish policy, persistence, cancellation, or migration parity. Removal waits for the conditions in the comparison table.

**Exercise OAuth or search during Desktop packaging.** That would require account state, may incur charges, and would mutate acceptance state. Immutable bytes plus read-only UI, inventory, and restart checks are the release gate; live-provider checks remain separate.

## Consequences

Each managed Copilot update advances the Desktop version and sequence even when Core and shell code remain unchanged. The packaged release carries the exact plugin source and dependency registry, while Windows Ops can independently pin the resulting Desktop assets. A later Core promotion must refresh this comparison and satisfy its own packaged rehearsal before companion behavior is migrated or retired.
