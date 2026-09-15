# Agent Note: Verify release plugins before atomic Desktop activation

Status: implemented

English | [中文](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)

## Problem

Corporate networks can block the public npm registry while permitting GitHub Releases and an enterprise dependency registry. Installing a root plugin through a registry cannot prove that Desktop received the reviewed release asset, and modifying the active profile leaves a failed package or Host startup for manual repair.

## Decision

Desktop accepts a versioned `githubRelease` source that locks the repository owner, repository, tag, asset name, package name, package version, byte size, SHA-256, SHA-512 integrity, target commit, and optional dependency registry. Desktop constructs GitHub API and asset requests from those fields. It rejects mutable release selectors, unapproved redirect hosts, mismatched release or tag commits, asset metadata mismatches, archive path escapes, escaping links, unexpected archive roots, package identity mismatches, and package lifecycle scripts.

The root package is a verified local tgz. Bundled pnpm resolves only its transitive dependencies through the explicit credential-free HTTPS registry, ignores lifecycle scripts, uses Desktop-owned store and configuration paths, and receives no inherited package-manager credentials or secret environment values. Ordinary npm sources retain their exact registry package behavior.

Each plugin mutation copies the active profile into a private transaction directory, prepares the complete package graph, restores official Host package links, and validates composition while the active Host keeps running. Desktop then stops the active Host, boots a temporary Host against the staged profile, swaps the staged directory into the reserved profile path, and starts the new Host. A failed health check restarts the old Host without changing its profile. A failed activation restores the previous profile and restarts its Host before reporting failure. The transaction lock lives outside the swappable profile directory.

Verified installations persist the locked source, GitHub release and asset identifiers, artifact hash, package identity, and transaction states in a versioned receipt beside a private profile-local tgz. The typed preload API exposes source schema version 1 and capability `{ id: "desktopNativeVerifiedRelease", schemaVersion: 1 }`; it does not expose a free-form download URL. A transaction accepts one source path, so an external provisioner and the native installer cannot both supply the root package.

## Consumer transition

The native capability is available only in Desktop builds containing this decision. Windows Ops remains responsible for its external provisioner until its reviewed lock switches from `windowsOpsVerifiedRelease` to `desktopNativeVerifiedRelease` schema version 1. That switch removes the external root-package workaround; it does not change the enterprise registry used for transitive dependencies.

## Alternatives considered

**Accept an arbitrary tgz URL.** A URL does not bind release state, tag identity, asset metadata, or redirect ownership and would turn an internal lock into a general downloader.

**Install the root package from the enterprise registry.** The proxy may lag the reviewed GitHub release, so registry resolution cannot attest the required immutable root artifact.

**Modify the active profile and retain partial failures.** This uses less disk and avoids profile copying, but it cannot satisfy unattended activation and rollback for an externally supplied verified artifact. The former in-place decision is retained as a frozen historical record.

## Consequences

Plugin changes require temporary disk space for a complete profile and may repeat package preparation when pnpm links were created under another transaction path. Health checks take longer but keep package, composition, and Host failures away from the active profile. Tests pin release metadata, redirects, hashes, archive safety, package identity, lifecycle rejection, registry and credential isolation, official Host links, staged health, activation rollback, receipts, capability discovery, and single-source provisioning.
