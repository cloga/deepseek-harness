# Agent Note: Bundle the Desktop runtime and retain external plugins

Status: implemented

English | [中文](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)

Plugin mutation and recovery follow the [verified release transaction decision](2026-09-15-desktop-verified-release-plugin-transactions.md). The [profile resolution generation decision](2026-09-09-profile-resolution-generations.md) supersedes this note's upstream-Node, physical-resource, and profile-link execution choices; bundled core ownership and external plugin isolation remain in force.

## Problem

Installing the core dependency graph during Desktop initialization repeats work already done by the release builder. An offline store eliminates downloads but retains extraction, package-manager startup, and installation costs. Users need the application to start with its production packages present while retaining ordinary npm plugin installation and plugin state across application upgrades.

Separate package directories can load duplicate Cordis or service modules. Retaining plugin files also does not prove compatibility with a new host API or Node runtime.

## Decision

[Runtime preparation](../../../../apps/desktop/scripts/prepare-dsh.ts) materializes the production graph once at build time. The packaged application carries it at `resources/app.asar/dsh`, with native executable entries in `app.asar.unpacked`. The Electron executable runs the private Desktop Host in Node mode and loads enabled plugins from `$DSH_HOME/profiles/desktop` through a runtime resolution generation.

This note supersedes core seed installation and single-project dependency ownership in the [Desktop packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md). That note continues to own release identity, signing, portless transport, process ownership, and Electron-only plugin authorization. The unpublished seed-based profile has no reader or migration; legacy package-resolution links remain available for older launches and rollback without participating in runtime-only resolution.

## Package ownership

The resource descriptor records the exact release, Node version, platform, architecture, shared package versions, and final file hashes. Build preparation copies ordinary files without links back to pnpm's build store; packaging puts that tree in ASAR and unpacks native executable entries. Native Mach-O files are signed before hashing, and the application signer preserves their bytes. An explicit `dsh/node_modules` file mapping bypasses electron-builder's root `node_modules` exclusion. Packaged inventory verification runs after packing and again after macOS signing, using archive-derived bytes and executable flags plus the exact physical unpacked file set and modes; Electron runs the unchanged verifier on a disposable verification copy.

The [Desktop file policy](../../../../apps/desktop/scripts/runtime-file-policy.ts) applies after production npm installation and before native signing or descriptor generation. npm publication lists serve library consumers and can include declarations, maps, tests, and native build inputs; they do not identify the files needed by the Desktop process. The Desktop copy omits declarations and recognized source maps because Host execution uses JavaScript and generated Typert artifacts, clears inherited `NODE_OPTIONS`, and does not enable source mapping. Reviewed plugin lifecycle builds cover native dependencies, not arbitrary TypeScript compilation. Published npm packages and external plugin directories retain their own files. Source debugger navigation is a development-package capability.

Package-specific exclusions remove Domino tests, fs-ext compilation outputs, Koffi's Windows import library, and non-target node-pty prebuilds and debug symbols. The policy retains native executable dependencies, node-pty's ConPTY source distribution, licenses, and unrecognized assets; broad `src`, `test`, `.ts`, or `.map` exclusions could remove executable code or runtime data. Copy tests preserve sentinel assets and seal the filtered inventory; the bundled-Node [payload smoke](../../../../apps/desktop/tests/fixtures/runtime-payload-smoke.mjs) verifies PTY output, native file seeking, FFI, image conversion, and HTML parsing. Runtime preparation still verifies every retained byte and boots the complete Host with an external plugin.

Every first-party package in the dsh and private Host production closures is shared. The Host installs its runtime resolution generation before profile rows mount, so shared package lookup does not require symlinks or Windows junctions. Distinct ESM and CommonJS conditional exports remain distinct entry points; selecting one package directory cannot merge a package's dual implementations.

External plugins declare shared host packages as peers. Ordinary dependencies remain plugin-owned and may differ from the versions used by dsh. Runtime-mode validation checks enabled shared peers against the packaged inventory and rejects private package links and required private dependencies resolved outside the profile. An optional non-host peer found only in an ancestor directory is treated as absent. Link-mode validation additionally rejects duplicate or aliased shared packages. A third-party package requiring host-wide instance identity must be explicitly added to the runtime's shared inventory; matching version numbers alone are insufficient.

The profile manifest records exact installed plugin dependencies separately from its enabled bundle list. Disabling a plugin preserves its package, lockfile entry, and user configuration. Runtime-mode preparation records the release identity and lockfile hash without creating, refreshing, or retiring legacy host links. Link-only callers retain their separately recorded link ownership.

## Transactions and upgrades

First launch creates profile metadata without installing core packages or creating host links. Runtime changes stage metadata and retained external plugins before validating peers and activating the final-location Host. Runtime-only startup leaves legacy resolution links untouched; package transactions and native rebuilds remain separate from resolution generation installation.

Native canonical paths identify shared package directories. Windows launchers can vary path casing without moving the application; string equality would trigger unnecessary profile preparation. Profile cleanup explicitly unlinks every nested directory link before removing real directories. A Windows fixture under Electron 44 reproduces recursive `fs.rmSync` deleting files through a nested junction, while bundled upstream Node 24.17 preserves them. Cleanup qualification therefore includes the real Electron runtime; Node-only tests do not establish target preservation.

Dependency mutations install with scripts disabled, validate the plugin graph and shared peer compatibility, run the reviewed pending lifecycle builds, and validate again. The `allowBuilds` policy remains explicit; unsupported build-requiring dependencies fail the transaction. Bundled upstream Node runs pnpm and the copied updater helper; the ASAR-backed Host instead uses Electron in Node mode.

Desktop validates package mutations and a staged Host before it swaps the active profile. The [verified release transaction decision](2026-09-15-desktop-verified-release-plugin-transactions.md) owns activation rollback, receipt attestation, and package-manager isolation. Retained host-link records identify legacy ownership independently of runtime-only package resolution.

The [immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md) owns direct Host startup and recovery in the main window. Users can update, remove, disable, or re-enable plugins and retry startup. Incompatible plugins are not silently deleted or automatically downgraded. Each backend launch requires the current runtime identity.

## Alternatives considered

Full runtime verification belongs to packaging. Startup reads the descriptor, checks shared package records and required Host entries, and uses the recorded runtime identity for profile reuse. The [release-validation decision](2026-09-09-desktop-build-release-validation.md) assigns release and target compatibility checks to packaging. It neither enumerates nor hashes installed runtime files, including on first launch or after an upgrade. Reading every file before backend loading adds startup I/O proportional to the distribution size. Installed content changes therefore are not detected by a startup checksum comparison; unusable modules fail when loaded. Build-time verification still rejects changed, missing, extra, or linked files against the recorded inventory.

- **Install the bundled offline seed at startup.** This preserves an ordinary pnpm installation procedure but repeats core extraction and installation on every affected machine. Materialized resources remove that work at the cost of more application files and release-builder responsibility.
- **Link all host dependencies into plugins.** This unnecessarily couples ordinary plugin dependencies to the host. The original link design shares only its explicit inventory; private packages retain independent versions.
- **Use hardlinks.** They cannot represent directories, may not cross volumes, share writable bytes, and retain old inodes after application replacement. These constraints motivate symlinks and Windows junctions in the retained link-only mode, not runtime-mode disk writes.
- **Use `NODE_PATH` or preserve symlink paths.** These do not provide uniform ESM resolution or shared module identity. Both the retained link mode and runtime generations keep Node responsible for selecting package exports.
- **Keep core packages in ASAR.** The original upstream-Node carrier could not read Electron's patched filesystem, so it required physical resources for loading and subprocess paths. The superseding generation decision chooses the Electron Node-mode carrier and unpacked executable entries instead; the ASAR rejection no longer applies.

## Consequences

Core package installation is absent from first launch and compatible upgrades. Metadata checks and backend loading still cost startup time; no release latency or download-size improvement is claimed without measurement. Plugin preservation is conditional on host API and native runtime compatibility, with a visible recovery path when that condition fails.

The [Desktop README](../../../../apps/desktop/README.md) owns operational guidance. Focused tests cover real pnpm installation and approved builds, shared ESM instance identity, private dependency versions, relocation, disabled plugins, native rebuild selection, activation failures, and transaction locking. Signed installed-artifact upgrades, macOS notarization, Windows junction/native behavior, release size and startup benchmarks, and real-model GUI recordings remain release-environment qualification requirements; unit fixtures do not substitute for them.
