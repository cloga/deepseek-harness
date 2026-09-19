# Agent Note: Preserve user plugins across Desktop provisioning

Status: implemented

English | [中文](2026-09-17-desktop-plugin-retention-and-lockfiles.zh.md)

## Problem

A verified installation receipt establishes package source verification, not whether the release plan or the user installed it. Treating every receipt as release ownership lets a later exact plan remove a user's plugin. Reconstructing an unchanged source can also erase an explicit manual installation if ownership is derived only from the new plan.

Windows pnpm can record a local tarball specifier with backslashes while Desktop records the same artifact with forward slashes. Frozen reconstruction can reject those strings during ordinary mutations, optional provisioning, or runtime rebuilds before the requested operation can proceed.

## Decision

The private receipt store records a complete `user` or `release` owner map independently of public source and receipt schemas. Manual verified installation records user ownership. Required and optional provisioning retain an existing user owner when the exact source and artifact reference match, including across runtime or plan changes. The [user-inventory decision](2026-09-19-desktop-user-inventory-guards.md) supersedes automatic desired-name precedence and optional-failure exclusion when they conflict with a manual installation; this note continues to own durable ownership migration and lock normalization. Exact removal covers only release-owned names absent from that plan, and inventory reuse permits unrelated user plugins.

Legacy ownership requires a consistent previous plan hash, an active result with the identical receipt, and the matching manifest artifact reference. Missing or incomplete evidence cannot authorize deletion. Invalid metadata fails closed. Migration writes only the staged copy and participates in the existing activation journal and rollback. An old receipt cannot reveal a manual reinstall that left exactly the same historical data; explicit ownership prevents that ambiguity for subsequent installs.

Every staged frozen pnpm install uses the existing [artifact lock normalizer](../../../../apps/desktop/src/plugin-lock-normalization.ts), including optional candidates and runtime rebuilds. Eligibility requires an exact canonical manifest reference backed by a validated source-snapshot lock or verified-release receipt, followed by matching artifact SHA-256. Only a Windows separator difference in the single importer's dependency specifier is normalized. Package resolutions, versions, integrity, the manifest, and frozen validation remain unchanged. The normalizer bounds reads, checks unlinked regular files and artifact directories, and atomically replaces the staged lockfile after validating all retained candidates. Unknown schemas, multiple importers, and unrelated mismatches remain unchanged for frozen validation; unsafe files, malformed text, and corrupt artifacts fail without rewriting the lock.

This decision supersedes receipt-based ownership and deletion in the [verified release transaction decision](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.md); its acquisition, graph validation, health checks, and rollback requirements remain in force. The [source snapshot decision](../feature/2026-09-17-desktop-plugin-source-snapshots.md) continues to own snapshot acquisition, durable identity, and artifact normalization; no separate receipt-only lockfile repair path is introduced.

## Alternatives considered

**Treat verification as release ownership.** This confuses source verification with user intent and removes manually installed verified packages.

**Derive ownership only from the latest plan.** An explicit same-source manual reinstall becomes release-owned again during reconstruction. Durable owner metadata retains that choice without overriding a different required source.

**Disable frozen validation to recover an old lockfile.** A general dependency refresh can accept unrelated drift. Artifact-backed separator normalization preserves the selected package graph and all existing locked resolutions.

## Consequences

Profile metadata gains private ownership records, while public provisioning capabilities and schemas remain unchanged. Empty plans preserve user plugins; optional failures exclude the failed desired entry only when the user-inventory checks allow its absence, and required failures preserve the previous profile. Older clients that ignore ownership do not provide this retention guarantee. Shared task, Session, and credential data are outside the transaction.

The owning regressions cover reuse and forced reconstruction, required and optional sources, explicit replacements, legacy evidence, malformed ownership, and rollback. Runtime-mode exact-plan upgrade cases retain a disabled user plugin from both legacy and explicit owner records. The existing normalization suites cover source snapshots and verified receipts, real pnpm reconstruction, bounded reads, unsafe files, and unchanged dependency resolutions. Published installer qualification remains the isolated Desktop release workflow, not a mutation of the installed application.
