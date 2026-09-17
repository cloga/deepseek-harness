# Agent Note: Desktop plugin source snapshots

Status: implemented

English | [中文](2026-09-17-desktop-plugin-source-snapshots.zh.md)

## Problem

A prebuilt plugin can be available as a public GitHub repository or a local package without being published to npm or carrying an immutable Release attestation. A mutable checkout, moving branch, or package version alone cannot reproduce installed bytes after restart. Passing these inputs directly to a package manager also introduces source preparation, repository configuration, and package-manager selection that installation does not authorize.

## Decision

Desktop provides a general `packageSpec` source alongside registry-only `npmRegistry` and attested `githubRelease` sources. The [Desktop README](../../../../apps/desktop/README.md) owns the accepted input matrix and user recovery. This decision complements the [verified Release transaction decision](../architecture/2026-09-15-desktop-verified-release-plugin-transactions.md): source snapshots reuse its profile transaction, but never claim its immutable Release or publisher evidence. The [bundled-runtime decision](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own application packages and shared-module identity. Neither decision is superseded.

The [input parser](../../../../apps/desktop/src/plugin-install-spec.ts) accepts a deliberately narrow grammar rather than forwarding pnpm's complete transport syntax. GitHub acquisition uses credential-free public API requests to resolve one ref to a full commit, then downloads that commit's archive. It does not invoke Git, use private GitHub credentials, or accept SSH and arbitrary Git hosts. A missing GitHub ref selects the repository's default HEAD only during explicit acquisition.

### Source preparation and output

[Acquisition](../../../../apps/desktop/src/plugin-package-artifact.ts) validates package identity, declared prebuilt output, and archive contents as data before installation. Directory and GitHub inputs pass validation before packing and again after packing. A web `dsh.client` declaration requires the runtime's actual `./client` export form: a string or an object with a string `default`. Host conditional exports retain Node's terminal-null semantics. Neither validation step imports the plugin.

Packing invokes the bundled pnpm's built-in `pm pack` under bundled upstream Node, with an isolated environment and Desktop-owned package-manager state. `--pm-on-fail=ignore` prevents source-selected package-manager downloads; `--ignore-workspace` prevents workspace discovery; `--config.ignore-pnpmfile=true` and `--config.ignore-scripts=true` suppress package-manager hooks and source lifecycle preparation. A source script named `pack` does not replace the built-in command. Packing does not write Desktop metadata into the source directory. Before packing, `publishConfig.directory` must remain inside the selected source directory under both lexical and realpath checks; publishing metadata in an already packed tarball remains inert and is not re-evaluated.

Root `preinstall`, `install`, and `postinstall` declarations, root `binding.gyp`, and nonempty bundled-dependency declarations are unsupported. Direct runtime and optional dependencies must use real-name registry versions, tags, or semver ranges; peers use semver ranges. Inert build and packing scripts may remain only with prebuilt output. These restrictions prevent a source root from inheriting a native build grant merely by claiming an approved package name. They do not replace the existing reviewed registry-native dependency build policy or prove every transitive package's provenance.

### Durable identity and replacement

The [source lock store](../../../../apps/desktop/src/plugin-package-lock.ts) records original requested spec, resolved URL, optional GitHub commit, real package name and version, SHA-256, and SHA-512 integrity in `desktop-plugin-package-locks.json`. Each profile-owned archive has the dependency spec `file:.desktop-plugin-artifacts/<sha256>.tgz`. The [project manager](../../../../apps/desktop/src/project-manager.ts) normalizes manifest and lockfile agreement before frozen relocation. Hashes identify a snapshot, not a verified Release receipt. A repeated source installation may change commit or bytes without changing package version.

Restart and frozen reconstruction consume retained snapshots rather than acquiring their original source again. Registry, snapshot, and verified Release replacement remove obsolete provenance ownership. Exact-plan replacement also removes displaced source locks when an optional verified candidate fails, so an uninstalled source cannot leave a retained-artifact prerequisite. Source reinstall remains an explicit input operation; the verified update path never silently substitutes a weaker source.

Missing or corrupted snapshots remain visible and removable. Removal prunes the target before validating and reconstructing retained dependencies. Other corrupted retained archives stop the transaction before Host interruption. This permits remove-then-install recovery without treating disable-all or direct reinstallation as a repair path. Activation and rollback continue to follow the shared transaction; a successful apply restarts the Host and executes the selected plugin at runtime.

## Alternatives considered

**Forward arbitrary Git and directory specs to pnpm.** This couples source acquisition to Git availability, repository hooks, package-manager auto-selection, and mutable working directories. A restricted parser plus data-only snapshot acquisition keeps those inputs outside installation authority.

**Retain live directory links or resolve branches on restart.** These avoid copying bytes but let source edits or branch movement change the next startup without a new install decision. Profile-owned archives trade storage for stable reconstruction.

**Require verified Release attestations for every plugin.** This excludes prebuilt local and repository-only packages. Keeping snapshots separate preserves useful source installation without weakening the existing verified channel's claims.

**Disable all native dependency builds.** This breaks the reviewed registry-native dependency path. Source-root hooks, implicit root builds, bundled dependencies, and direct nonregistry dependencies are rejected instead; the existing registry build policy retains its own scope.

## Consequences

Source packages that compile during installation, depend on private or generic Git transports, or carry nonportable direct dependencies require repackaging with prebuilt output and registry dependencies. Snapshot storage and private transaction copies cost disk space. A stored snapshot survives loss of its original checkout, but loss of the profile archive requires explicit recovery. Content hashes and successful acquisition do not establish runtime compatibility, authentication readiness, or safe plugin behavior.

## Required verification

[Parser tests](../../../../apps/desktop/tests/plugin-install-spec.spec.ts) and [acquisition tests](../../../../apps/desktop/tests/plugin-package-artifact.spec.ts) pin accepted syntax, output selection, lifecycle rejection, dependency constraints, archive containment, and bounded downloads. [Real pnpm tests](../../../../apps/desktop/tests/plugin-source-pnpm.spec.ts) exercise the shipped package-manager invocation against hostile scripts, configuration hooks, and package-manager selectors; archive scenarios require the executable sentinel payload, not only its manifest reference.

[Transaction tests](../../../../apps/desktop/tests/project-manager.spec.ts) require frozen relocation, retained-source reconstruction, same-version byte replacement, opposite-provenance cleanup, failed optional replacement, damaged-snapshot removal, and pre-stop failure for retained corruption. [Plugin-window tests](../../../../apps/desktop/tests/plugin-manager.spec.ts) cover source reinstallation and verified-channel preservation. Target-platform Desktop acceptance additionally requires the actual plugin window, final-location Host startup, and rollback behavior; source tests do not qualify a specific external plugin's runtime or authenticated model use.
