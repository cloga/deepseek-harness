# Agent Note: Verify release plugins before atomic Desktop activation

Status: implemented

English | [中文](2026-09-15-desktop-verified-release-plugin-transactions.zh.md)

## Problem

Corporate networks can block the public npm registry while permitting GitHub Releases and an enterprise dependency registry. Installing a root plugin through a registry cannot prove that Desktop received the reviewed release asset, and modifying the active profile leaves a failed package or Host startup for manual repair.

## Decision

Desktop accepts a versioned `githubRelease` source that locks the repository owner, repository, tag, artifact asset id and name, package name, package version, byte size, SHA-256, optional SHA-512 integrity, target commit, optional dependency registry, and optional checksum-manifest asset. Release-owned automatic provisioning requires the checksum manifest. Its lock contains the exact asset id, canonical GitHub Release URL, name, byte size, SHA-256, `sha256sums` format, and optional SHA-512 integrity. Desktop requires exactly one matching `<sha256>  <artifact>` line and rejects missing, duplicate, malformed, renamed, or mismatched entries. Desktop constructs GitHub API requests from the repository and locked asset ids. It rejects mutable release selectors, unapproved redirect hosts, mismatched release or tag commits, asset metadata mismatches, archive path escapes, escaping links, unexpected archive roots, package identity mismatches, and package lifecycle scripts.

The root package is a verified local tgz. Bundled pnpm resolves only its transitive dependencies through the explicit credential-free HTTPS registry, ignores lifecycle scripts, uses Desktop-owned store and configuration paths, and receives no inherited package-manager credentials or secret environment values. Ordinary npm sources retain their exact registry package behavior. A verified artifact still has to satisfy the target shared-package graph: application-owned packages must be peers, not ordinary or optional dependencies, even when the same name also appears as a peer. Artifact integrity cannot authorize a second Host package identity. Before profile composition, the Desktop Host registers a synchronous package-resolution policy for physical modules under the profile's `node_modules`. Their bare package requests may resolve only inside the profile or through the matching profile link into a packaged runtime package after realpath normalization; an ancestor optional peer has module-not-found semantics, while required dependencies remain invalid and built-in or explicit file requests retain Node.js behavior.

Each plugin mutation copies profile metadata and retained artifacts, excluding every `node_modules` directory, into a private transaction. Bundled pnpm reconstructs private dependencies there; application upgrades never install or rebuild inside the active profile. Target runtime links and the desired plugin inventory are prepared together before peer validation. Each source acquisition has its own exclusive directory, and GitHub must positively attest `immutable: true`.

Desktop retains the old profile through staged health checks, activation renames, final-location Host readiness, and active inventory verification. The external transaction lock and fsynced activation journal identify an interrupted rename. Recovery restores the uncommitted old profile under that lock. Failed restoration preserves the journal and rollback directory instead of deleting the only remaining old data. The two renames are recoverable, not a crash-atomic directory exchange.

Verified installations persist the locked source, GitHub release and asset identifiers, artifact hash, package identity, and transaction states in a versioned receipt beside a private profile-local tgz. The typed preload API exposes source schema version 1 and capability `{ id: "desktopNativeVerifiedRelease", schemaVersion: 1 }`; it does not expose a free-form download URL. A transaction accepts one source path, so an external provisioner and the native installer cannot both supply the root package.

Desktop releases may also carry a generic `desktopNativePluginProvisioning` schema 1 exact-state plan. Startup reconciles receipt-owned plugins while preserving unrelated manual registry plugins and application-owned shared packages. Required entries establish a validated baseline. Optional entries are tested in independent candidates so a download, validation, install, graph, or health failure excludes only its entry. Its durable result records phase and reason without a successful receipt; a required failure preserves the prior profile.

The active profile stores the canonical plan hash, per-plugin source and receipt, required flag, composition status, removed receipt-owned packages, rollback status, and verification status. Reuse requires exact desired/result membership, installed versions, enabled states, matching receipts and sources, matching local artifact bytes, and no undesired receipt-owned roots, including for an empty plan. Managed completion independently validates this inventory after final-location Host readiness. Neutral browser evidence qualifies generic Models composition and authentication dispatch, not a particular external provider release.

## Consumer transition

Windows Ops selects plugin locks in the source-owned Desktop release plan. The protected workflow embeds the normalized plan, publishes it beside the installer, and records its file and canonical hashes in the build receipt. A release must contain the plan before deployment can rely on automatic provisioning. The 0.1.5 recovery plan resolves transitive dependencies through `https://packagefeedproxy.microsoft.io/npm/`; later plans select their own credential-free HTTPS registry explicitly.

## Alternatives considered

**Accept an arbitrary tgz URL.** A URL does not bind release state, tag identity, asset metadata, or redirect ownership and would turn an internal lock into a general downloader.

**Install the root package from the enterprise registry.** The proxy may lag the reviewed GitHub release, so registry resolution cannot attest the required immutable root artifact.

**Modify the active profile and retain partial failures.** This uses less disk and avoids profile copying, but it cannot satisfy unattended activation and rollback for an externally supplied verified artifact. The former in-place decision is retained as a frozen historical record.

**Add one hard-coded GitHub Copilot package to Desktop.** That would solve one provider while leaving restart, removal, rollback, and future external providers without a release-owned mechanism.

## Consequences

Plugin changes require temporary disk space and package reconstruction even for a compatible runtime upgrade or bundle toggle. Required and optional health checks add startup work but prevent failed candidates from modifying the active graph. Exact-state removal applies only to receipt-owned plugins; unrelated manual plugin state remains user-owned. Tests cover multi-source checksum acquisition, source and inventory drift, Host-peer replacement/removal, phase-specific optional isolation, final activation failure, rollback restoration failure, interrupted renames, and completion withholding. Each selected provider release requires separate evidence from its actual immutable artifact, target shared-package graph, and Models, account, discovery, and device-code behavior; a neutral fixture does not qualify it.

The reviewed release plan selects immutable `dsh-github-copilot@0.4.0-alpha.22`, whose packed authorization and Schemastery dependencies are required Host peers. React is a Client external, not a required Node peer or a second private runtime copy. Published artifact and historical shared-inventory checks do not establish new Desktop materialization or installed UI behavior. Models, account, discovery, device-code, and update persistence remain rehearsal and release acceptance obligations.
