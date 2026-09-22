# Agent Note: Admit explicit compatible Desktop user overrides

Status: implemented

English | [中文](2026-09-21-desktop-compatible-user-plugin-overrides.zh.md)

## Problem

A user-owned checksum-attested same-name plugin can pass the complete staged Host health check when it is installed, yet a later cold startup rejects it because provisioning state previously required the receipt source to equal the release source. Exact source equality preserves release intent but cannot express a reviewed policy that permits a user choice, and version ordering does not establish runtime compatibility.

## Decision

Provisioning plan schema 2 gives every entry an explicit `strict-pin` or `compatible-user-override` source policy. Schema-1 plans remain strict and retain their canonical hash. A compatible override must be enabled, explicitly user-owned, checksum-attested, artifact-consistent, and use the planned package name. Registry packages, source snapshots, legacy-unknown ownership, disabled entries, damaged artifacts and contradictory receipts remain conflicts.

Provisioning state schema 2 records the plan schema, requested source and policy separately from the effective source and `plan` or `user-override` disposition. Schema-1 state is validated with its historical capability and normalized only in memory. A successful transaction writes schema 2; reads never rewrite retained evidence.

One resolver selects the effective source for startup, reuse, staging, user mutations and final activation checks. It never compares versions. A retained override remains user-owned and is copied into staging without another download; compatibility exists only after the complete staged graph validates and the target-runtime Host reaches readiness. Runtime changes therefore recheck the override. Unrelated user plugins and release-only removal rules remain unchanged.

A failed target-runtime health check retains the active profile. When exactly one override was active, Desktop publishes its packaged source as a typed recovery suggestion without attributing the failure to that override; several active overrides produce no arbitrary targeted suggestion. The startup page and preload-independent emergency page can restore only the packaged requested source named by that retained failure. Main revalidates the package against the packaged plan; the renderer supplies neither a source nor a package name. Recovery uses the existing staging, health, activation-journal and rollback transaction and preserves unrelated user plugins. Disable-all and reset remain separate broad fallbacks.

This decision partially supersedes the identical-source rule in [Desktop user inventory guards](2026-09-19-desktop-user-inventory-guards.md). Its malformed-inventory rejection, transaction checks, audit, recovery-copy and rollback rules remain applicable. Release plans opt in entry by entry; no existing schema-1 release gains override behavior.

## Alternatives considered

**Treat every verified newer version as compatible.** Semantic version order does not verify peer dependencies, bundle loading or Host readiness.

**Silently restore the release source after a failed startup check.** That discards explicit user intent without consent. The targeted action is the consent point.

**Store only the effective source.** Completion and startup could no longer distinguish release intent from the artifact that actually ran.

## Consequences

Compatible user choices survive cold startup and runtime upgrades only when the staged Host accepts them. Strict entries still reject an alternate verified source before profile activation, and ordinary mutations cannot commit a required planned name in a state that the next startup rejects. The durable state and capability versions change, while source receipts and ownership records remain unchanged.
