# Agent Note: Guard Desktop user inventory before profile replacement

Status: implemented

English | [中文](2026-09-19-desktop-user-inventory-guards.zh.md)

## Problem

A missing runtime-state file does not prove that a Desktop profile is new. Reinitializing its manifest before staging can remove plugin declarations even when the subsequent health check fails. A healthy release plan also says nothing about disabled or off-plan user plugins, and an optional same-name replacement can discard the existing manual installation when acquisition fails.

Source receipts, source locks, dependency specifiers and artifact files can disagree. Ownership labels alone cannot authorize replacement of those contradictory declarations. Recovery controls can also destroy profile contents, so selecting a reset action must not itself count as informed confirmation.

## Decision

Profile initialization refuses existing package, runtime or reserved Desktop composition metadata before writing anything. Canonical-path `lstat` checks honor the filesystem's case semantics and detect broken links. Unrelated files do not prevent a genuinely new profile from being initialized. Orphan user metadata and contradictory dependency/source declarations require inspection rather than implicit reconstruction.

Every mutation captures user dependency specifiers, enabled flags, receipt identities and owners, source locks, and validated artifact digests before pruning or package operations. The protected inventory includes disabled plugins and registry packages without receipts. Release ownership excludes a declaration only when its receipt and artifact reference agree and no source lock conflicts. The inventory is checked after staged preparation and health, against the still-active profile before its replacement, and after final Host activation before commit. Failure uses the existing rollback path.

Explicit installation and update may change only the acquired target package name, which the private acquisition result carries independently of the public receipt result. The prepared target's identity and presence are fixed before health checks; a target-name exception is not permission to lose that package. Removal requires the target declaration to disappear and does not require its broken artifact bytes to be usable. Toggle changes only the named enabled flag; disable-all changes only enabled flags.

A release plan cannot take over a conflicting manual installation. Only an enabled, user-owned verified package with the identical planned source may be reconstructed automatically. Different sources, versions, commits, artifacts, installation kinds or user-disabled state require an explicit user operation. If an optional reconstruction fails and would remove a protected package, the whole transaction fails.

The retained backend safeguards for any destructive profile replacement require a held lock, a stopped Host, and a verified private configuration/artifact copy before the first destructive write. Generated node_modules are excluded, linked configuration is refused, copy failure attempts to restart the original Host, and final readiness or failure receives a separate immutable outcome. Official alpha2 uses native recovery and exposes no startup configuration-reset IPC or preload-independent emergency reset document; these backend requirements do not reintroduce those obsolete controls.

This partially supersedes desired-name precedence and optional-failure exclusion in the [ownership decision](2026-09-17-desktop-plugin-retention-and-lockfiles.md) and [verified transaction decision](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.md). Their source verification, ownership migration, lock normalization and ordinary activation rollback remain applicable. Public IPC, plugin receipt, source and Session schemas remain unchanged; private activation-journal version 2 adds recovery evidence.

## Recovery evidence

Version-2 journals bind the operation and acquired target name to before/after fingerprints of validated declarations, ownership, source locks, referenced artifact bytes, runtime state, lockfile and workspace metadata. Generated node_modules and Host documents are excluded. Recovery verifies every surviving profile candidate before any rename or cleanup. Legacy journals have no historical fingerprints: incomplete critical metadata or differing manual inventories retains the candidates for inspection. Missing active metadata plus an orphan rollback is not a new installation; healthy active profiles are not blocked merely by unrelated orphan staging.

Journal writes use exclusive random temporary files, complete writes, synchronization and atomic replacement, never a predictable truncating temporary path. Retained audit receipts survive journal cleanup and contain only operation kind, target package, transaction id, inventory hashes/names and outcome. The private audit bounds retained groups, counts partial writes, and never serializes source URLs, raw errors, configuration or prompts. Audit publication failure before mutation refuses the operation; failure after a committed journal retains it and rollback for verified recovery instead of relabeling the commit as failed.

Reset copies live outside the active profile, carry a last-published verification receipt, and retain failed outcomes and partial evidence. They are not automatic restore instructions and may contain private configuration. These mechanisms synchronize file data, not filesystem-directory durability across power loss.

## Alternatives considered

**Treat missing runtime state as a fresh installation.** This writes over active declarations before a rollback copy exists. A failure afterward cannot undo that write.

**Protect only enabled or receipted packages.** Disabled plugins remain installed, registry packages legitimately have no receipt, and source snapshots use a separate lock store.

**Exempt every desired or explicitly named package from checking.** Plan membership does not authorize replacing a manual source. Even an explicitly requested installation must survive its health and activation callbacks with the prepared identity.

**Reconstruct user intent from damaged metadata.** Conflicting or orphan records do not establish which source was selected. Refusing the operation preserves evidence instead of inventing a replacement.

## Consequences

Automatic upgrades can stop for inspection rather than replacing an incompatible manual choice. Optional failures remain isolated only when excluding that entry does not discard an existing user installation. Explicit source changes and removal of damaged snapshots remain available through their named operations.

The regression suite checks bootstrap preservation, source conflicts, disabled declarations, staged and final inventory tampering, exact acquired targets, artifact corruption, and filesystem case aliases. Published-code filesystem reproductions use explicit package-manager, acquisition and Host stubs; they are not packaged application acceptance and do not attribute a particular user's loss to reset or any specific upgrade event.

These checks protect observed inventory and preserve attributable operation evidence; they cannot reconstruct an unrecorded history or restore inventory consistently erased before the first capture. Ambiguous legacy recovery requires inspection instead of a guessed commit or rollback. Audit retention is bounded, recovery copies exclude materialized dependencies, and directory durability is not guaranteed. Reinstallation or restoration still requires verified inputs and an explicit recovery decision.
