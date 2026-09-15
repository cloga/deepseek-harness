# Agent Note: Verify release plugins before atomic Desktop activation

Status: implemented

English | [中文](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)

## Problem

Corporate networks can block the public npm registry while permitting GitHub Releases and an enterprise dependency registry. Installing a root plugin through a registry cannot prove that Desktop received the reviewed release asset, and modifying the active profile leaves a failed package or Host startup for manual repair.

## Decision

Desktop accepts a versioned `githubRelease` source that locks the repository owner, repository, tag, asset name, package name, package version, byte size, SHA-256, SHA-512 integrity, target commit, optional dependency registry, and optional checksum-manifest asset. Release-owned automatic provisioning requires the checksum manifest. Desktop verifies its own size, hashes, and Release metadata, then requires its package, version, asset, SHA-256, and integrity fields to equal the root artifact lock. Desktop constructs GitHub API and asset requests from those fields. It rejects mutable release selectors, unapproved redirect hosts, mismatched release or tag commits, asset metadata mismatches, archive path escapes, escaping links, unexpected archive roots, package identity mismatches, and package lifecycle scripts.

The root package is a verified local tgz. Bundled pnpm resolves only its transitive dependencies through the explicit credential-free HTTPS registry, ignores lifecycle scripts, uses Desktop-owned store and configuration paths, and receives no inherited package-manager credentials or secret environment values. Ordinary npm sources retain their exact registry package behavior.

Each plugin mutation copies the active profile into a private transaction directory, prepares the complete package graph, restores official Host package links, and validates composition while the active Host keeps running. Desktop then stops the active Host, boots a temporary Host against the staged profile, swaps the staged directory into the reserved profile path, and starts the new Host. A failed health check restarts the old Host without changing its profile. A failed activation restores the previous profile and restarts its Host before reporting failure. The transaction lock lives outside the swappable profile directory.

Verified installations persist the locked source, GitHub release and asset identifiers, artifact hash, package identity, and transaction states in a versioned receipt beside a private profile-local tgz. The typed preload API exposes source schema version 1 and capability `{ id: "desktopNativeVerifiedRelease", schemaVersion: 1 }`; it does not expose a free-form download URL. A transaction accepts one source path, so an external provisioner and the native installer cannot both supply the root package.

Desktop releases may also carry a generic `desktopNativePluginProvisioning` schema 1 exact-state plan. Startup reconciles receipt-owned plugins to the plan before Host startup while preserving manually installed plugins and every application-owned shared package. It removes omitted receipt-owned plugins, installs or replaces required artifacts, enables their profile bundles, and validates the complete Host and Client composition through the same staged transaction. A required failure preserves the prior profile. A composition failure attributable to an optional entry disables optional entries, validates the remaining composition, and records the failure.

The active profile stores the canonical plan hash, per-plugin source and receipt, required flag, composition status, removed receipt-owned packages, rollback status, and verification status. Restart reuses that state only when installed versions, enabled states, receipt-backed sources, and local artifact evidence still match. Because enabled profile bundles feed the Desktop Host loader and the Client module registry, an external provider's server patch and `dsh.client` bundle enter the same application composition; the mechanism does not special-case a provider.

## Consumer transition

Windows Ops selects plugin locks in the source-owned Desktop release plan. The protected workflow embeds the normalized plan, publishes it beside the installer, and records its file and canonical hashes in the build receipt. A release must contain the plan before deployment can rely on automatic provisioning. Transitive dependencies continue to use the plan's credential-free enterprise registry.

## Alternatives considered

**Accept an arbitrary tgz URL.** A URL does not bind release state, tag identity, asset metadata, or redirect ownership and would turn an internal lock into a general downloader.

**Install the root package from the enterprise registry.** The proxy may lag the reviewed GitHub release, so registry resolution cannot attest the required immutable root artifact.

**Modify the active profile and retain partial failures.** This uses less disk and avoids profile copying, but it cannot satisfy unattended activation and rollback for an externally supplied verified artifact. The former in-place decision is retained as a frozen historical record.

**Add one hard-coded GitHub Copilot package to Desktop.** That would solve one provider while leaving restart, removal, rollback, and future external providers without a release-owned mechanism.

## Consequences

Plugin changes require temporary disk space for a complete profile and may repeat package preparation when pnpm links were created under another transaction path. Health checks take longer but keep package, composition, Host, and Client failures away from the active profile. Exact-state removal applies only to receipt-owned plugins; manual plugin state remains user-owned. Tests pin release metadata, checksum manifests, redirects, hashes, archive safety, package identity, lifecycle rejection, registry and credential isolation, official Host links, exact reconciliation, staged Host and Client composition, activation rollback, receipts, durable state, capability discovery, and single-source provisioning.
