# Agent Note: Preserve user plugins across Desktop provisioning

Status: implemented

English | [中文](2026-09-17-desktop-plugin-retention-and-lockfiles.zh.md)

## Problem

A verified installation receipt proves package provenance, not whether the release plan or the user installed it. Treating every receipt as release ownership lets a later exact plan remove a user's plugin. Reconstructing an unchanged source can also erase an explicit manual installation if ownership is derived only from the new plan.

Windows pnpm can record a local tarball specifier with backslashes while Desktop records the same artifact with forward slashes. The next frozen reconstruction rejects the different strings before the requested operation can repair them.

## Decision

The private receipt store records a complete `user` or `release` owner map independently of public source and receipt schemas. Manual verified installation records user ownership. Required and optional provisioning retain an existing user owner when the exact source and artifact reference match, including across runtime or plan changes; a genuine planned replacement records release ownership. The current plan still determines the required source for each desired package name. Exact removal covers only release-owned names absent from that plan, and inventory reuse permits unrelated user plugins.

Legacy ownership requires a consistent previous plan hash, an active result with the identical receipt, and the matching manifest artifact reference. Missing or incomplete evidence cannot authorize deletion. Invalid metadata fails closed. Migration writes only the staged copy and participates in the existing activation journal and rollback. An old receipt cannot reveal a manual reinstall that left exactly the same historical data; explicit ownership prevents that ambiguity for subsequent installs.

Lockfile repair applies only to a receipt-bound Windows separator mismatch. The manifest reference, locked package version and tarball path, artifact SHA-256, and locked SHA-512 must agree. The staged repair changes the specifier without changing dependency resolutions or integrity. Non-regular lockfiles are rejected so copied symbolic links cannot redirect the write into the active profile. Other drift remains subject to frozen installation.

This decision supersedes receipt-based deletion in the [verified release transaction decision](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.md); its acquisition, graph validation, health checks, and rollback requirements remain in force.

## Alternatives considered

**Treat verification as release ownership.** This conflates provenance with user intent and removes manually installed verified packages.

**Derive ownership only from the latest plan.** An explicit same-source manual reinstall becomes release-owned again during reconstruction. Durable owner metadata retains that choice without overriding a different required source.

**Disable frozen validation to recover an old lockfile.** A general dependency refresh can accept unrelated drift. Receipt-bound repair preserves the reviewed artifact and all existing locked resolutions.

## Consequences

Profile metadata gains private ownership records, while public provisioning capabilities and schemas remain unchanged. Empty plans preserve user plugins; optional failures still exclude the failed desired entry, and required failures preserve the previous profile. Older clients that ignore ownership do not provide this retention guarantee. Shared task, Session, and credential data are outside the transaction.

The owning regressions cover reuse and forced reconstruction, required and optional sources, explicit replacements, legacy evidence, malformed ownership, rollback, and real pnpm mutation of an old mismatched lock. File-link rejection is exercised with POSIX file symlinks and unprivileged Windows junctions; neither fixture requires changing the user's security settings. Published installer qualification remains the existing isolated Desktop release workflow, not a mutation of the installed application.
