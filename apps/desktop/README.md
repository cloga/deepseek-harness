# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop application is an Electron shell around the dsh Web UI. It opens no listening port: an Electron child in Node mode boots the ASAR-backed dsh project, versioned framed byte pipes carry Fetch requests and streaming responses without an outer Base64 envelope, Node IPC carries lifecycle control, and `dsh-app://` serves the matching client assets.

## Key technical decisions

| Decision | Why | Direct consequence |
|---|---|---|
| Release identity | The shell API, Web client, backend, and plugin graph are qualified as one combination; independent versions would create untested combinations and ambiguous update availability. | Electron and `@deepseek-ai/dsh` always have the same exact version. A dsh upgrade is a Desktop release, even when the shell code is unchanged. |
| Runtime | The packaged Host needs Electron's ASAR filesystem; system runtimes and package-manager state are uncontrolled. | dsh runs through the packaged Electron executable with `ELECTRON_RUN_AS_NODE=1`. Bundled upstream Node runs pnpm and is copied with the detached updater; neither uses the Host executable. |
| Package sources | Core installation at startup adds work even when offline. | `resources/app.asar/dsh` carries the production dependency tree; native executable entries use `app.asar.unpacked`. The profile installs only external plugins. |
| Shared modules | Host APIs can depend on module identity without writable package links. | The Host installs an immutable profile resolution generation before mounting plugins; runtime resolution neither creates nor retires legacy links. Ordinary plugin dependencies remain local. |
| State ownership | Sharing executable dependency graphs would let CLI and Desktop change each other's dsh, Cordis, plugin, or native-module versions, while two desktop processes could race on the same profile. | Electron acquires its process-lifetime single-instance lock before any profile access and exclusively owns `$DSH_HOME/profiles/desktop` plus its package-manager state. CLI and Desktop share supported product data under `$DSH_HOME`, but never executable packages, plugin activation, lockfiles, or `node_modules`. |
| Transport | A listening Web service adds port ownership, authentication, CORS, and exposure concerns; the shell and Host child also need an explicit cross-process protocol. | The application opens no Web port. `dsh-app://` carries Web assets and Fetch traffic; framed byte pipes carry bounded request and response chunks with backpressure, while Node IPC carries only child lifecycle control. |
| Plugin changes | Package installation and Host startup can fail. | Desktop prepares and health-checks a private staging profile, then swaps it into place. Failed activation restores the previous profile and Host. |
| Updates | Independent shell and dsh updates would recreate version splits, while unsigned fork builds cannot weaken native publisher verification. | Signed releases use the native updater. The cloga fork publishes an unsigned, source-owned managed channel with a detached helper; the two modes are mutually exclusive and both replace the complete Desktop release. |

The [Electron packaging and update Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns release qualification, the [fork channel Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.md) owns unsigned release identity and discovery, the [verified release transaction Agent Note](../../.agents/notes/implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.md) owns plugin source verification and activation rollback, and the [plugin slash command Agent Note](../../.agents/notes/implemented/feature/2026-09-20-desktop-plugin-slash-command.md) owns the trusted Host-to-Electron command bridge.

## Installation ownership

Electron owns `$DSH_HOME/profiles/desktop`. Its `dependencies` contains registry plugins at exact versions, profile-owned source snapshots, or receipt-attested Release tgz files; `dsh.profile.bundles` contains the built-in bundles followed by enabled plugins. The application supplies dsh, the private Desktop Host, and their production packages from `resources/app.asar/dsh`. The Host and plugins execute in one Electron Node-mode process. Before profile rows mount, the Host installs an immutable [profile resolution generation](../../.agents/notes/implemented/architecture/2026-09-09-profile-resolution-generations.md); this does not create, update, or remove legacy package links. Node retains package-export and import/require selection. The [verified release transaction decision](../../.agents/notes/implemented/architecture/2026-09-15-desktop-verified-release-plugin-transactions.md) owns private dependency validation and module isolation. The CLI cannot boot or mutate this profile.

The local startup page exposes startup status and available recovery actions; the loaded dsh renderer receives the carrier marker, unsaved-input impact reporting, and a narrow update status/subscription/review bridge. Review always opens the existing user confirmation; it exposes no direct installation or arbitrary IPC capability. The separate plugin window receives structured list, source install, remove, update, capability, and update-check operations. Source input passes through Electron's restricted parser and acquisition checks; neither renderer receives direct filesystem access, raw Electron IPC, a shell, a general download API, or arbitrary pnpm arguments.

Electron chooses typed English or Chinese shell copy from its application locale and falls back to English. Menus, native dialogs, the startup page, and the plugin-management renderer use the same locale payload; the repository Client UI i18n gate checks these desktop sources.

Windows packaging and every application window use [assets/whale.png](assets/whale.png), a 256-pixel transparent rendering of the shared [whale favicon](../web/public/favicon.svg). Packaging includes this asset inside the application archive and uses it for the executable and installer-generated shortcut icons; a missing or malformed image fails packaging. Changing a shortcut alone does not replace a running window's icon. Install the updated release and reopen Desktop only after saving active work.

### Runtime and plugin activation

The packaged `resources/app.asar/dsh/desktop-runtime.json` binds the shell version, recorded Node version, platform, architecture, shared package versions, and final file inventory. Before native signing and inventory generation, runtime preparation applies the pinned packager's package-metadata transformation to its private production copy. Native, Host, and browser smokes consume that normalized, sealed tree. Packaging verifies release identity, target compatibility, and the complete archive and physical unpacked inventory, using a disposable verification copy rather than relying on Electron's virtual file stats. The descriptor bytes and strict after-pack checks remain unchanged; packaging never repairs a mismatch by resealing the archive. Startup reads the metadata and checks shared package records. Core packages are never copied into profile storage or installed by pnpm at first launch.

Preparation and packaging share `app-builder-lib` 26.15.3's metadata transformation and explicit script/keyword removal settings. Runtime package names, versions, module entry declarations, dependencies, and `dsh` metadata remain distinct from the shell's fork metadata. Removing package metadata is not universally behavior-neutral: a dependency may read a removed field at runtime, so a small ASAR canary does not replace the complete normalized-payload smokes and packaged release rehearsal. The [bundled-runtime decision](../../.agents/notes/implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) owns the internal-API coupling and verification limits.

1. The main window displays a local loading page before profile preparation or backend startup. A fresh profile creates its manifest and records runtime identity without materializing shared package links. Missing runtime metadata alongside existing package metadata stops initialization without overwriting that profile; orphan user receipts, bundles, or source locks require inspection. Reuse checks runtime identity and lockfile content; a packaged plugin plan also requires an exact observation of installed versions, receipts, local artifact hashes, and enabled state.
2. Application upgrades stage target runtime metadata and the desired plugin inventory together before checking peers. Obsolete release-owned plugins cannot block their planned replacement or removal. Profile configuration and manual plugin versions are retained.
3. Every changed profile copies metadata and retained artifacts, never `node_modules`. Bundled pnpm reconstructs private dependencies in staging with scripts disabled, validates shared peer compatibility, then runs approved pending builds and validates again. Runtime upgrades never run package operations against the active reserved profile.
4. Plugin add, update, and remove operations use bundled pnpm and Desktop-owned package-manager state. A `githubRelease` source binds exact release, asset, commit, size, hash, integrity, package identity, and dependency-registry metadata; Desktop downloads only through approved GitHub hosts and installs the root from the verified local tgz with lifecycle scripts disabled. Reserved host packages must be peers. Runtime-mode validation checks those peers against the packaged inventory without requiring profile links.
5. Plugin changes prepare the target graph privately, stop the active Host for the staged health check, then rename the staged profile into its final location and activate it. A failed staged health check restarts the prior Host. The old profile remains recoverable until the final-location Host starts and its required inventory validates. Failed activation restores the old profile; a failed restoration retains the transaction and recovery journal rather than deleting the remaining old data.

Native plugin-manager changes keep the application page open during private staging. Immediately before the first Host interruption, Electron reports running Sessions, queued messages, jobs, and fresh composer draft, attachment, and submission state in a native confirmation. It reads the impact again after confirmation and asks again if it changed. Unavailable impact prevents interruption; cancellation leaves the active profile, Host, and application page unchanged and does not report installation success. Once an approved transaction interrupts the Host, failure recovery restores the prior profile without another cancellable confirmation. Plugin changes, application update installation, and manual recovery cannot overlap. Quitting cancels pending consent and waits for the plugin transaction and its staged Host to settle before closing the active backend.

### Plugin sources and snapshots

The plugin window provides a separate verified-release JSON form that calls the versioned installation API with a `githubRelease` descriptor. Use a reviewed lock containing exact release, asset, commit, package, and checksum data; the native parser and downloader remain authoritative. This explicit installation records user ownership. Release-owned package names still follow the packaged plan at startup, so persistent changes to that baseline require a Desktop release. A Release tgz URL entered in the ordinary source form creates a source snapshot, not a verified-release receipt.

The built-in `/desktop-plugin` command offers the same Desktop-owned transaction without widening the preload or exposing the reserved profile to CLI package mutation. Use `list`; `install npm <spec>`; `install github <owner/repo[#ref]>`; `install release <verified-release-json>`; `remove`; `update`; `enable`; `disable`; or `disable-all`. Slash installation intentionally excludes local paths and arbitrary URLs because a Session working directory is not the Electron profile's package-resolution base. Preparation completes while the Host is alive. After observing the matching `command/done` event, the Host awaits a successful Session flush before acknowledging settlement; an unavailable observer or failed flush cancels the prepared operation. Electron then presents the same fresh impact report and default-Cancel native confirmation before stopping that Host. Acquisition, source parsing, ownership, health checks, activation, and rollback remain owned by `DesktopProjectManager`.

The ordinary source form accepts the following inputs. Installation requires a package with a real name, an exact package version, a `dsh.bundle.patch`, and its declared prebuilt Host and Client files. A repository name does not determine the installed package name.

| Source | Accepted input | Stored installation |
|---|---|---|
| npm registry | `plugin`, `@scope/plugin@next`, `plugin@^1.2.0`, or other valid semver ranges | Exact resolved registry version |
| Public GitHub repository | `github:owner/repo[#ref]`, `owner/repo[#ref]`, `https://github.com/owner/repo[.git][#ref]`, or the same GitHub URL with `git+https` | Full resolved commit and a profile-owned package snapshot |
| Local directory | Absolute Windows or POSIX path, explicit `./` or `../` path, `file:<path>`, or `link:<path>` | Packed snapshot; `link:` does not create a live link |
| Local archive | Explicit path or `file:<path>` ending in `.tgz` or `.tar.gz` | Copied package snapshot |
| HTTPS archive | Credential-free HTTPS URL ending in `.tgz` or `.tar.gz`, without query, fragment, or custom port | Downloaded package snapshot |

GitHub refs accept branch names, tags, and commits, including branch names with slashes; revision expressions and `semver:` selectors are unsupported. Acquisition uses public GitHub API requests and validated archive downloads, not Git executables, SSH, private-repository authentication, or generic Git hosts. An ambiguous bare name is a registry package; use an explicit path for local files. The versioned installation API keeps `npmRegistry` registry-only, uses `packageSpec` for general source input, and retains `githubRelease` for verified Release locks.

Source packages must already be built. Desktop rejects root `preinstall`, `install`, and `postinstall` hooks, root `binding.gyp`, bundled dependencies, and nonregistry direct runtime dependencies, including file, link, Git, URL, workspace, and npm-alias selectors. Dependencies and optional dependencies use registry versions, tags, or semver ranges; peers use semver ranges and remain subject to the shared-package rules. Inert `prepare`, `prepack`, `postpack`, and `build` scripts do not run during source acquisition. Missing declared output is an error, not permission to download a compiler or execute a build. Reviewed native registry-dependency builds retain the profile's `allowBuilds` policy; acquisition restrictions are not a promise that every transitive dependency executes zero scripts.

Each nonregistry source becomes `.desktop-plugin-artifacts/<sha256>.tgz` under the Desktop profile. The separate `desktop-plugin-package-locks.json` records the requested spec, resolved source URL, GitHub commit when applicable, package name and version, SHA-256, and SHA-512 integrity. These hashes identify stored bytes; they do not attest a publisher or grant the `githubRelease` verified receipt guarantees. Packing leaves the source directory's metadata unchanged. Restarts and frozen reinstalls reuse stored snapshots without requiring the original source directory or resolving its moving GitHub ref again.

Use **Reinstall from source** to review or edit the source in the in-page dialog; use an absolute path when selecting a local file again. Explicit reinstallation can select different bytes or a different commit even when the package version is unchanged. Registry updates continue to select versions. Verified Release updates use the verified channel and do not silently fall back to a registry or general source. Replacing a package's source clears the opposite source-lock or receipt ownership rather than presenting both as current source evidence.

A missing or corrupted snapshot remains listable and removable. Remove that package, then install the original source again to recover; disabling plugins or directly reinstalling a damaged snapshot is not a repair guarantee. Removal excludes the target before reconstructing retained dependencies. A corrupted snapshot belonging to a retained package rejects the transaction before the active Host stops. Applying a successful plugin transaction still restarts the Host; snapshot acquisition is not runtime compatibility or plugin-code trust verification. The [source snapshot decision](../../.agents/notes/implemented/feature/2026-09-17-desktop-plugin-source-snapshots.md) owns packing isolation, trade-offs, and required verification.

### Release-owned plugin provisioning

A managed fork release may carry `resources/desktop-provisioning/plan.json`. The exact-state plan lists external plugins without adding them to `desktop-runtime.json.sharedPackages`; Desktop keeps `@deepseek-ai/cordis` and `@deepseek-ai/dsh-*` packages application-owned, installs each external root from its verified release tgz, and enables its bundle in the reserved profile. The normal Host composition then loads the plugin's server patch, while `dsh.client` and `./client` make its Client contribution available to Settings. The plan is generic. The capability smoke uses a neutral provider fixture to prove Client-module and provider-card composition; acceptance of a selected provider requires its actual immutable artifact and Settings > Models account and authentication UI.

External packages must declare dependencies on the target runtime's `sharedPackages` as peers, never ordinary or optional dependencies. Declaring the same name in both dependency and peer sections still fails. This includes shared authorization and Schemastery packages; a checksum-valid artifact and a compatible peer range do not excuse a conflicting dependency declaration.

`dsh.client.external` declares modules supplied by the Client, such as React; it does not satisfy a required Node peer. A package that uses React only in its Client bundle declares that external instead of a Node runtime dependency.

Each entry is `required` or optional and contains a `githubRelease` source with a checksum-manifest lock. GitHub must positively report `immutable: true`. The artifact lock names the exact Release asset id, filename, byte size, and SHA-256. The checksum lock names the exact asset id, canonical GitHub Release URL, filename, byte size, SHA-256, and `sha256sums` format. Each acquisition has an exclusive private directory, so several sources may use `SHA256SUMS`. Desktop verifies exactly one `<sha256>  <artifact>` entry; missing, duplicate, malformed, renamed, or mismatched entries reject that source. Optional SHA-512 SRI fields are verified when supplied. Every entry in one plan uses the same credential-free HTTPS dependency registry.

Windows Ops changes `desktopProvisioning` in [`release/cloga-windows-x64.json`](release/cloga-windows-x64.json), then runs the protected `desktop-fork-release.yml` workflow with the reviewed plan's `confirm_version` and the reviewed commit's `expected_source_sha`; the [release-channel decision](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.md) defines source-pin validation. Use existing immutable versioned tgz and `SHA256SUMS` assets rather than republishing them. Prepare sets `DSH_DESKTOP_PLUGIN_PROVISIONING_PLAN` for packaging and embeds the plan plus capability schema 3. Finalization rejects disagreement between reviewed inputs, packaged capability and plan, published bytes, and receipt hashes. It publishes the packaged plan as `desktop-provisioning.json`, records both its file hash and canonical plan hash in `build-receipt.json`, and covers release files with `SHA256SUMS` and `SHA512SUMS`. Deployment requires a release with the actual non-empty provider plan.

At startup Desktop reconciles release-owned plugins to the packaged plan while preserving manual registry, source-snapshot, and verified-release declarations, including disabled plugins. A same-name manual installation blocks automatic replacement unless it is an enabled, user-owned verified installation of the exact planned source. Other source, version, artifact, commit, installation-kind, or activation conflicts require an explicit user operation. Required entries form a validated baseline. Each optional entry is tested in a separate candidate; failure records its phase and reason without a successful receipt. If excluding an optional entry would remove an existing user plugin, the entire transaction fails and retains the active profile. Reuse requires exact desired/result membership, matching sources, receipts, versions, artifact bytes, and enabled states, with no extra release-owned roots. An empty plan removes only release-owned roots.

The private receipt store records user or release ownership separately from source verification. Explicit manual verified installation records user ownership, including a reinstall of the same source; rebuilding that exact source retains the user ownership. Release ownership exempts a declaration from user retention only while its receipt artifact reference matches that declaration and no source snapshot conflicts. Legacy ownership is inferred only from an active, identical receipt in consistent prior provisioning state and its matching manifest reference; other verified plugins remain user-owned. Legacy records cannot distinguish a manual reinstall that left exactly the same receipt. Ownership migration and changes commit or roll back with the staged profile. The [plugin retention decision](../../.agents/notes/implemented/bug-fix/2026-09-17-desktop-plugin-retention-and-lockfiles.md) owns ownership migration; the [user-inventory decision](../../.agents/notes/implemented/bug-fix/2026-09-19-desktop-user-inventory-guards.md) owns initialization and conflict checks.

Each package mutation captures user dependency specifiers, enabled flags, receipt identities and owners, source-lock identities, and verified artifact digests before pruning or package operations. Receipt and snapshot references must agree with the declared dependency; contradictory or competing sources require inspection. The transaction freezes its prepared target declaration, compares retained declarations and artifact bytes after staged health verification and final activation, and checks that the active declarations still match before replacement. Explicit add, install, update, and remove operations may replace only their verified target name; toggle changes only that target's enabled flag, and disable-all changes only enabled flags. These checks do not recover inventory that was already consistently erased before capture. Versioned activation evidence and retained private operation receipts cover subsequent recovery and attribution; they do not identify an earlier unrecorded actor.

Before every staged frozen pnpm install, Desktop normalizes only Windows separators in artifact importer specifiers backed by an exact canonical manifest match, a validated source-snapshot lock or verified-release receipt, and matching artifact SHA-256. The existing normalizer bounds file reads, rejects unsafe files and artifact directories, and replaces the staged lockfile atomically. It leaves package resolutions, versions, integrity, and the manifest unchanged; unrelated drift remains subject to frozen validation.

Windows Ops verifies `resources/managed-update/capability.json` for `desktopNativePluginProvisioning`, the packaged and published plan hashes, `desktop-plugin-receipts.json` for release and artifact identity, and `$DSH_HOME/profiles/desktop/desktop-plugin-provisioning-state.json` for each plugin's `active` or `optional-failed` result plus removed-package evidence. Managed-update completion runs only after final-location Host readiness and independently checks the actual installed inventory and receipts against the packaged plan before recording the sequence. A staging-only health pass is not completion evidence.

The loading page does not depend on the Host. Errors offer restart and reinstallation guidance. Disabling plugins and resetting Desktop are offered only when packaged application resources support profile recovery; development and early initialization failures expose restart alone. The plugin manager remains available through the application menu. Runtime identity is checked before any backend starts.

Both the startup page and the preload-independent emergency page require native destructive confirmation, defaulting to cancellation, before reset stops the Host. Cancellation restores the recovery controls; quitting or closing the window invalidates late acceptance. Under the transaction lock, Desktop copies configuration and artifacts to `$DSH_HOME/desktop/profile-recovery/reset-*`, excluding generated `node_modules`, verifies and synchronizes the files, and publishes a copy receipt before deleting the active profile. Linked configuration or a failed copy stops reset and attempts to restart the unchanged Host. Reset then initializes the built-in profile; a separate outcome records final Host readiness or failure. Shared tasks, settings, and the Harness-home `.env` remain untouched. Copies may contain private configuration and are neither uploaded nor restored automatically; do not attach their payloads to public reports.

Package transactions hold `$DSH_HOME/desktop/profile.lock` through pnpm exit and activation. The version-2 `profile-activation.json` records operation identity and before/after inventory fingerprints. Recovery verifies active and retained candidates before renaming or cleanup. Version-1 journals cannot authorize differing manual inventories or incomplete runtime/workspace/required lock metadata. An orphan rollback prevents initializing an empty active path; healthy profiles can still coexist with orphan staging. Failed verification retains the journal and transaction for inspection. Do not delete these copies or run pnpm in the reserved profile. Runtime resolution leaves legacy links untouched; cleanup never follows directory links, and native builds retain the reviewed `allowBuilds` policy.

Private receipts under `$DSH_HOME/desktop/profile-operations` retain operation kind, verified target name, transaction identity, inventory hashes/names and outcome after activation-journal cleanup. Retention is bounded to 64 receipt groups, including partial writes, with a 128 KiB record limit; unknown files are not removed. Source URLs, raw errors, prompts and configuration contents are excluded. File data is synchronized before atomic receipt publication; directory durability after power loss is not guaranteed. A failed post-commit audit retains the committed journal and rollback instead of undoing the committed profile or declaring success.

### Fork-owned Windows managed updates

Desktop checks silently ten seconds after startup and every six hours while open. Available releases appear in a persistent strip above the main content; **Review update** or the application menu's **Check for updates** opens the existing confirmation and active-work check. Background checks never display an installation dialog or install automatically. Choosing **Later** leaves the strip visible. A temporary check failure retains the last verified available version; checks are coalesced and skipped during confirmation/installation, scheduled checks stop on quit, and late results are ignored. See the [update-notice decision](../../.agents/notes/implemented/feature/2026-09-17-persistent-desktop-update-notice.md). Windows warnings, installer choices, and UAC remain yours to approve.

Managed update check errors identify the failed release-list, tag-verification, or manifest-download step. Known connection resets, timeouts, DNS, reachability and certificate errors receive localized recovery advice; cancellation is reported separately. Unknown network causes stay generic, and certificate advice keeps verification enabled. Integrity and metadata validation errors retain their existing diagnostics. These messages do not change update sources, download paths or retry behavior.

Discovery, helper acknowledgement, installation completion, and authenticated model use are separate checks. The copied helper must boot with only its Node executable and bundle before it can acknowledge a handoff. A pre-acknowledgement failure keeps Desktop running and records bounded, redacted stderr in `helper-startup-error.json` under the owning managed-update operation directory.

The published `0.1.5-rc.3.cloga.1` and `.cloga.2` helpers contain an unresolved `semver` import and cannot repair themselves through that broken handoff. Recovery requires a newer verified installer obtained outside the updater. Save or finish active work, explicitly close Desktop, and verify its exact application and Host processes have exited before starting the hash-verified interactive installer. Do not rerun an old handoff, patch installed helper files, copy `node_modules`, or run pnpm against the live Desktop profile. Windows warnings and UAC remain user decisions.

Signed packages that contain `resources/app-update.yml` use `electron-updater` and retain its publisher and platform-signature checks. An unsigned cloga package selects managed mode only by carrying both `resources/managed-update/capability.json` and the packaged `resources/managed-update/helper.mjs`; startup rejects a package that enables both modes. Capability schema 3 fixes `cloga/deepseek-harness`, the `dsh-desktop-v` tag prefix, the `release.json` asset name, the packaged sequence, the minimum sequence, and the canonical plugin provisioning plan hash without accepting a URL. An exact `cloga/dsh-windows-ops` manifest remains available only as the sequence-zero migration.

**Check for updates** lists releases through the fixed GitHub API repository, requires an immutable release and commit-pinned tag, verifies the release asset digest, then validates manifest schema 3, its canonical self-hash, monotonic sequence, source commit and tree, build inputs, fork identity, installer hashes, installed evidence, network policy, interactive completion policy, and generic `desktopNativeVerifiedRelease` capability, source-schema, and receipt-schema compatibility. Schema 3 retains `automaticProvisioning: false` so existing 0.1.5 Desktop clients can parse and install the release; the installed capability and build receipt own the release's startup provisioning evidence. The packaged sequence prevents a release installed by enterprise deployment from selecting itself, and a completed sequence prevents rollback. Renderer messages cannot supply a repository, URL, executable, process id, path, or installer argument.

**Install** reports running Sessions, queued messages, active jobs, the current composer draft, attachments, and submission state before confirmation, then repeats the confirmation if that impact changes while the dialog is open. Electron writes a one-time handoff under its user-data directory and starts a copied Node.js plus standalone helper. Electron keeps the application and Host running unless the helper validates the selected manifest and acknowledges the same manifest hash. An acknowledgement failure marks the operation cancelled, terminates only that owned helper, and waits for its exit; a Host-stop failure rolls back updater-owned quit and performs the same cancellation. After acknowledgement and Host stop, Electron exits normally. The helper waits only for the recorded Electron and Host process ids, bounds metadata attempts to one minute with a fifteen-second inactivity limit and installer attempts to thirty minutes with a one-minute inactivity limit, retries only classified transient failures up to three attempts, bounds streamed bytes to the manifest size, downloads and revalidates the build receipt and installer, and stages them under the operation directory. It holds a non-writable installer handle while rehashing, checking the declared unsigned Authenticode state, and starting interactive NSIS with no arguments; child processes do not inherit credential-shaped environment variables. Windows warnings and UAC remain interactive user decisions.

The next Desktop process stages the packaged plugin plan with its runtime, starts the final-location Host, and accepts completion only when helper results, installed files, capability, plan, actual plugin inventory, receipts, and sequence agree. Completion uses the sequence in the durable completion receipt, not the packaged sequence used to prevent self-selection during discovery. A newly packaged version does not prove its pending installation completed. Retained schema-2 and schema-3 handoffs may contain commit-based migration source records; completion validates them without rewriting history or making them eligible for new installations. An identity-validated failure before stage promotion is terminal and does not block startup or advance the completion receipt; operation metadata remains intact. Staged or possibly launched installations require recovery unless an independent completion candidate verifies the same or a newer installed release against its locked manifest, executable/runtime hashes, packaged capability, and plugin inventory. Conflicting, malformed, interrupted, or mismatched evidence never becomes success by version comparison. Helper failures record phase, asset filename, error category, and whether installation may have started without persisting raw network errors or signed URLs.

The recovery command targets the installed executable with `--recover-managed-update`. It routes to the owning Electron instance and requires its final-location Host to be ready. After a manual reinstall, this explicit action can obtain independent completion evidence from the installed version's immutable GitHub Release, even without a managed helper operation for that version. It verifies the tag and source identity, manifest and build-receipt hashes, installed executable/runtime bytes, packaged capability and provisioning plan, and actual plugin inventory. It preserves retained operations unchanged and refuses malformed, live, newer, or conflicting installation evidence. Ordinary startup remains offline; unavailable or unverifiable publication metadata leaves recovery blocked and preserves the previous completion receipt.

Successful recovery opens the application without resetting plugins or restarting Host. If evidence still fails, the action offers the existing **Check for updates** flow, retaining active-work confirmation before replacement installation. Recovery never reruns an old handoff or bypasses hash checks. If Host cannot reach readiness, a verified interactive reinstall outside this flow is still necessary; reinstall alone does not complete an old managed operation. After manually launching the repaired application, run its displayed recovery command. The operator owns local installation and startup verification.

Windows Ops selects and locks one supported upstream baseline at a time. `cloga/deepseek-harness` records that selection in the reviewed release plan and owns the installer, manifest, receipt, checksums, immutable tag, and capability injection. Windows Ops then pins those source-owned assets, verifies them, and deploys them without maintaining another release definition. The legacy `dsh-local-0.1.5-rc.2.local.1` manifest is accepted only by the explicit migration entry and cannot become a second ongoing channel. Once the fork uses signed native artifacts with publisher validation, omitting the capability removes managed mode without changing the native updater.

## Develop

### Isolated provisioning acceptance

On Windows, the following commands build this checkout and run the real Models UI in a fresh headless Edge context against an isolated, workspace-linked Desktop Host. They do not launch installed Desktop or use live credentials. The runner writes provider-card, authorization-result, and restored-state screenshots with run evidence under `output/desktop-provisioning-fixes/`. Its synthetic authorization receipt proves generic composition, not immutable artifact integrity, real account/model discovery, or the installed unified-0.1.6 release. Packaged-runtime smoke uses Playwright Chromium; the fork release workflow prepares that browser before packaging.

```powershell
$env:npm_execpath = (Resolve-Path apps\desktop\node_modules\pnpm\bin\pnpm.mjs).Path
node node_modules\tsx\dist\cli.mjs scripts\build.ts
node node_modules\tsx\dist\cli.mjs apps\desktop\scripts\smoke-workspace-fixture.ts
```

### Development application

`dev:desktop` builds the current Host, client bundles, Web frontend, and Electron shell, projects the built CLI and private Desktop Host packages with their workspace dependencies into a disposable desktop npm project, and launches Electron without downloading the packaged Node.js runtime or resolving dsh from npm:

```sh
pnpm run dev:desktop
```

Development Harness state defaults to `apps/desktop/.desktop-build/development/home`, the disposable npm project lives at `apps/desktop/.desktop-build/development/project`, and Electron browser data lives at `apps/desktop/.desktop-build/development/electron-user-data`. Sessions, settings, credentials, package links, and browser data therefore stay out of the user's normal Harness home. An explicit `DSH_HOME` replaces only the development Harness home. Renderer DevTools opens automatically; Main, Renderer, and dsh Host debugging listen on ports 9229, 9222, and 9230. `DSH_DESKTOP_MAIN_INSPECT_PORT`, `DSH_DESKTOP_RENDERER_DEBUG_PORT`, and `DSH_DESKTOP_HOST_INSPECT_PORT` replace those ports, while `DSH_DESKTOP_OPEN_DEVTOOLS=0` keeps the detached Renderer tools closed.

After an explicit build, `start:desktop` reconstructs the disposable project and launches the existing artifacts without building again:

```sh
pnpm run start:desktop
```

Workspace development runs the current CLI and private Desktop Host packages under the invoking Node.js and disables desktop package mutations. Its explicitly linked disposable profile is the only mode allowed to resolve bundles outside its own directory. Use an unpacked application to exercise the Electron Node-mode Host, ASAR-backed dsh resources, bundled Node.js and pnpm, and plugin installation and repair paths.

## Package

The normal packaging path is one complete command. It performs release preparation before creating the host platform's installers and update metadata. Every target requires a reverse-DNS `DSH_DESKTOP_APP_ID`. macOS targets additionally require the electron-builder certificate qualifier in `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`, its 10-character Apple Team ID in `DSH_DESKTOP_MACOS_TEAM_ID`, and one complete notarytool credential strategy. The App Store Connect API-key strategy uses these variables:

```sh
export DSH_DESKTOP_APP_ID='<reverse-DNS application ID>'
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without the Developer ID Application prefix>'
export DSH_DESKTOP_MACOS_TEAM_ID='<10-character Apple Team ID>'
export APPLE_API_KEY='<absolute path to the .p8 file>'
export APPLE_API_KEY_ID='<App Store Connect API Key ID>'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
```

`prepare:desktop` is not a prerequisite:

```sh
pnpm run package:desktop
```

Release automation uses fixed target commands so runtime preparation, dsh preparation, and electron-builder receive the same platform and architecture:

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

The macOS arm64 command requires Apple Silicon. The macOS x64 command runs on Intel macOS or Apple Silicon with Rosetta. The Windows x64 command requires Windows x64. Linux is not a supported Desktop release target.

Each target owns its packed package inputs, prepared runtime, package set, dsh tree, pnpm preparation state, unpacked application, update metadata, and final artifacts under `apps/desktop/.desktop-build/targets/<target>/`. The Node.js archive cache remains shared under `.desktop-build/downloads` because every archive name includes its version, platform, and architecture and is verified before extraction. A target build never consumes another target's mutable preparation state.

### Runtime file selection

Production packages first pass through npm's publication rules and dependency installation. [Desktop's file policy](scripts/runtime-file-policy.ts) then filters the prepared `dsh/node_modules` tree before signing, integrity sealing, and ASAR packaging. It omits TypeScript declarations, recognized JavaScript/CSS/TypeScript source maps, TypeScript build caches, Domino's test directory, selected native compiler outputs, and node-pty prebuilds for other platforms. It preserves runtime JavaScript, native modules and their DLL/EXE helpers, WASM, unknown assets, licenses, and notices. The policy does not alter npm tarballs, the bundled package manager, or user-installed plugin files.

The packaged application runs compiled JavaScript and pre-generated Typert metadata; it does not compile TypeScript plugins. Source-level debugger navigation and editor declarations remain available in development packages. [Copy-policy tests](tests/runtime-file-policy.spec.ts) cover exclusions and retained assets; `prepare:dsh` runs the [payload smoke](tests/fixtures/runtime-payload-smoke.mjs) under the bundled Node before the Host smoke and final inventory verification.

Windows release qualification also runs [native cleanup and replacement checks](scripts/smoke-windows.ps1) manually after the Desktop build. Set `$Electron` to the prepared Electron executable and `$Makensis`, `$SevenZip`, and `$PluginDir` to the pinned builder’s NSIS compiler, 7-Zip executable, and x86-unicode NSIS plugin directory. From the repository root, run the command below. It verifies Electron junction cleanup, installer scratch cleanup, and both locked-file replacement modes; it is not part of the unit-test lane.

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Electron $Electron -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir
```

### Upload updates

`DSH_DESKTOP_AUTO_UPDATE_ENV` selects `test` or `production` for both the URL embedded during packaging and the later COS upload; an absent value selects `test`. Test packaging requires its HTTPS origin in `DOWNLOAD_TEST_ORIGIN`, while the production origin remains `https://download.deepseek.com`. Upload additionally requires the selected deployment's COS bucket in `DOWNLOAD_TEST_COS_BUCKET` or `DOWNLOAD_PROD_COS_BUCKET`. The target path is `_/harness/desktop/stable/<target>/`, where `target` is `mac-arm64`, `mac-x64`, or `win-x64`.

The update destination and upload credentials follow the selected deployment:

| Environment | Public origin | COS bucket | COS credentials |
|---|---|---|---|
| `test` or unset | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`, `DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`, `DOWNLOAD_PROD_COS_SECRET_KEY` |

Package and upload one target under the same environment. For example, the default test deployment uses:

```sh
export DOWNLOAD_TEST_ORIGIN='https://desktop-updates.example.com'
pnpm run package:desktop:mac:arm64

export DOWNLOAD_TEST_COS_BUCKET='<test COS bucket>'
export DOWNLOAD_TEST_COS_SECRET_ID='<test COS SecretId>'
export DOWNLOAD_TEST_COS_SECRET_KEY='<test COS SecretKey>'
pnpm run upload:mac:arm64
```

Set `DSH_DESKTOP_AUTO_UPDATE_ENV=production` before packaging, then provide `DOWNLOAD_PROD_COS_BUCKET` and the production credential pair before running `upload:mac:arm64`, `upload:mac:x64`, or `upload:win:x64`. Packaging does not require a COS bucket or credentials. It explicitly disables electron-builder publishing, strips all four COS credential fields from its subprocesses, and writes a target completion record only after electron-builder and every signing or notarization hook succeeds. Upload requires that record to match the selected environment, target, public URL, and current dsh version; it also requires the root dsh version, Desktop version, channel metadata version, artifact names, sizes, and SHA-512 values to agree before it reads the selected COS credential pair. It uploads only that target's immutable versioned artifacts, uploads the version-derived channel metadata last with `no-cache`, and never deletes historical objects. Stable releases use `latest-mac.yml` or `latest.yml`; a prerelease such as `alpha` uses `alpha-mac.yml` or `alpha.yml`, matching electron-builder's emitted filename.

The macOS configuration uses the required release environment instead of accepting whichever certificate appears first in a keychain. It rejects empty values, a malformed Team ID, a signing identity that includes electron-builder's unsupported `Developer ID Application:` prefix, and incomplete notarization credentials. macOS packaging requires the configured identity and its private key. Runtime preparation applies that identity, a secure timestamp, and hardened runtime to every embedded Mach-O file; after signing the application, a deep strict check rejects any other leaf authority or Team ID before artifact creation. The fixed-target macOS installer commands create separate copies of the signed application and run two artifact lanes concurrently. One lane notarizes and staples the App before generating the ZIP and its update metadata. The other encloses its signed App copy in a signed DMG, then notarizes, staples, and verifies the DMG; its inner App has no individually stapled ticket. Both lanes must finish successfully before their artifacts reach the final directory and the release completion record is written. Directory-only commands also require notarization credentials and wait for Apple notarization and App stapling. The [parallel notarization decision](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.md) owns copy isolation and container ticket semantics. The private key can come from the login keychain or electron-builder's standard `CSC_LINK` input; ambient `CSC_NAME` and certificate discovery order do not select the release owner. Notary credentials may instead use electron-builder's complete Apple ID or keychain-profile strategy. The two macOS identity variables are also required when repeating the application check manually with `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>`.

macOS signing visits real files without following Framework symlink aliases. PAK resources retain all shipped languages and are sealed by the enclosing Framework or application signature instead of receiving individual signatures. The [release policy](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the dependency patch and verification requirements.

Company proxies can accelerate uploads to Apple's notarization service. See the company internal documentation for configuration.

### Unsigned Windows test installer

On Windows x64, use the complete unsigned packaging command for local installation testing:

```sh
pnpm run package:desktop:win:x64:unsigned
```

The command requires `DSH_DESKTOP_APP_ID` and the normal build dependencies, including Python and Visual C++ build tools for native modules. Set `PYTHON` to the Python executable when it is absent from `PATH`. It writes the installer to `.desktop-build/targets/win-x64/unsigned-artifacts/`, omits automatic-update configuration, strips signing credentials, and creates no release completion record. It does not require EV credentials or an update origin. The signed packaging and upload commands retain their release requirements.

### Fork-owned Windows release

The reviewed plan at `release/cloga-windows-x64.json` advances both semantic version and integer sequence. The manual `Desktop fork release (Windows x64)` workflow requires the operator to confirm that reviewed version, pins Node 24.13.0 and pnpm 11.7.0, installs from the frozen lockfile, tests Desktop, packages the fixed cloga identity, and verifies the standalone helper, capability, unsigned installer, installed executable, runtime descriptor, and native-versus-managed exclusion. A rehearsal run requires the checkout to equal the current selected remote branch, performs the same build, finalization, checksum verification, and artifact upload, and skips both publication and remote release discovery. A publication run requires current `master`; its protected release job receives the only `contents: write` permission, cross-checks the downloaded workflow artifact, creates the exact commit tag as a draft, uploads every asset, publishes it, and fails unless GitHub reports the release immutable and every remote asset digest matches. A final job runs release discovery against GitHub only after publication. Preparation and remote verification may use the step-scoped `DSH_DESKTOP_RELEASE_GITHUB_TOKEN` for allowlisted metadata GETs; downloads remain anonymous, and the token never enters the packaged application or receipts. The [fork release decision](../../.agents/notes/implemented/architecture/2026-09-15-fork-owned-windows-desktop-release-channel.md) defines the build-only authentication limits.

Each release contains the interactive NSIS installer, `release.json`, `build-receipt.json`, `SHA256SUMS`, and `SHA512SUMS`. The manifest and receipt lock the source commit and tree, lockfile and plan hashes, build tools and dependency registry, fork package identity, installer size and hashes, plugin capability and structured source/receipt versions, allowed origins and redirects, and post-restart completion semantics. The workflow never starts the installer.

Before finalization, [packaged Copilot acceptance](tests/fixtures/copilot-release-smoke.ts) launches the unpacked Electron application with fresh Harness and Electron data directories. It requires the real Settings > Models account, sign-in entry, Manage panel, successfully loaded read-only Model roles view, and registered search-provider catalog. It validates the installed plugin graph and provisioning inventory, then repeats the observations after quitting and restarting. Its separate seven-day workflow artifact records screenshots, safe settings observations, receipts, packaged runtime/capability/plan records, executable metadata, and exact source identity. Failed runs retain redacted startup diagnostics and receipt/state existence, not credentials or a profile copy. The fixture never saves settings, creates Sessions, signs in, or calls a model or search provider. Catalog registration is not provider usability; these checks do not establish OAuth success, model availability, search routing/fallback, or an old-to-new installer upgrade. Rehearsal artifacts are not immutable Releases.

The independent graph check runs the built validator in packaged Electron Node mode against `app.asar/dsh`, with runtime resolution selected and the active profile as its working directory. It removes inherited `NODE_PATH`, `NODE_OPTIONS`, and ASAR overrides, uses no tsx loader, and binds the result to the original runtime descriptor hash. This validates the package inventory; the real Host acceptance separately verifies module loading. Source-runner lookup paths remain diagnostic only. Missing optional peers and optional non-host peers found only outside the profile are treated as absent; required dependencies outside the profile remain errors.

The release workflow also copies the exact packaged Node and helper into a dependency-free temporary directory. The helper-only bundle includes every nonbuiltin dependency; finalization rejects nonbuiltin static, dynamic, and CommonJS module references. The copied-byte smoke first reaches argument validation without a handoff, then uses a valid synthetic manifest transport to require a real acknowledgement and cancellation while the fixture process remains alive. It forbids receipt/installer requests and never executes an installer. A failure blocks finalization and publication; source-only helper tests do not replace this shipped-byte check.

### Windows EV signing

Windows packaging fixes the 7-Zip filter to `BCJ` for compatibility with the bundled NSIS decoder. This preserves ARM64 binaries carried by dependencies in x64 installers; automatic ARM64 filtering produces entries that this decoder cannot extract.

NSIS removes its temporary extraction tree during installation, before the completion page or an automatic launch. Installed production packages remain in `app.asar` with native executable entries in `app.asar.unpacked`; startup does not install or extract a second core dependency tree. Installation still writes the complete application tree.

Windows release packaging requires `DSH_DESKTOP_WINDOWS_CER_FILE` to identify the public GlobalSign EV leaf certificate, `DSH_DESKTOP_WINDOWS_SIGNTOOL` to identify the SafeNet-compatible SignTool executable, `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` to identify the matching private-key container, and `DSH_DESKTOP_WINDOWS_TOKEN_PIN` to contain the SafeNet Token Password. The certificate file remains outside source control, and the matching private key stays on the USB token. Set the four inputs before running the fixed Windows target:

```powershell
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL = 'C:\path\to\the\validated\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet private-key container name>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = '<SafeNet Token Password>'
pnpm run package:desktop:win:x64
```

Insert and unlock the token before packaging. The electron-builder hook passes each artifact to the CRLF `scripts/windows-sign.cmd`, which invokes the configured SignTool once with `/f`, SafeNet `/kc "[{{PIN}}]=container"`, `/csp "eToken Base Cryptographic Provider"`, a SHA-256 file digest, and a DigiCert SHA-256 RFC 3161 timestamp. The hook never substitutes electron-builder's bundled SignTool and never retries a failed signing request. Windows release packaging fails instead of emitting unsigned artifacts when the SignTool, certificate, container, PIN, token, or signature is unavailable.

The PIN cannot contain `]`, a quote, or a line break because those characters delimit the SafeNet `/kc` value or its CMD argument. The CMD disables delayed expansion so a PIN containing `!` reaches SafeNet unchanged. Packaging withholds every `DSH_DESKTOP_WINDOWS_*` field from build and runtime-preparation subprocesses, gives electron-builder only the four configured inputs, gives the signing CMD only the validated signing fields in an otherwise scrubbed environment, clears those fields before SignTool starts, and redacts SignTool diagnostics. SafeNet still requires the PIN in the SignTool process command line. Inject it as an ephemeral secret only on a controlled self-hosted Windows runner with the physical token attached; never commit it, put it in `.env`, or persist it as a Windows user or system environment variable.

Create a runnable application directory instead of an installer by using the matching `:dir` command, such as:

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

To inspect or troubleshoot the prepared host-target resources without invoking electron-builder, stop the same pipeline after preparation:

```sh
pnpm run prepare:desktop
```

This diagnostic command is an alternative stopping point, not the first half of a two-command build. A later `package:desktop*` command repeats the official build and preparation so it cannot consume stale dsh packages, runtime files, or dsh content.

Every package command builds the repository, packs the first-party production closures rooted at dsh and the private Desktop Host, and prepares target-specific Node and pnpm executables. `prepare:dsh` installs and materializes the production graph once at build time, removes package-manager metadata, and writes `desktop-runtime.json` with shared package versions and final file hashes. Electron-builder maps the prepared tree and its explicit `dsh/node_modules` entry into `app.asar/dsh`, unpacking native executable entries. On macOS preparation signs native files before inventory generation, and electron-builder excludes their unpacked tree from nested re-signing. Packaged Electron runs the full inventory verifier after packing and again after macOS signing. Signed installer, notarization, installed upgrade, and target-specific native-module qualification require the release environment.

An unpacked application contains Electron, the ASAR-backed dsh production tree and shell, unpacked native executables, and physical upstream Node.js and pnpm resources for package management and the copied updater. Installer size and filesystem size differ; release qualification measures both, plus the profile's plugin storage and first-launch latency. Bundling eliminates core package installation on the user's machine.

## Updates

A packaged application checks its target-specific release stream ten seconds after the main window opens; the localized **Check for Updates…** menu item triggers the same check manually. An available release opens one native confirmation dialog. Accepting it waits for an in-flight check, downloads and verifies the signed Desktop release, stops the dsh child, and hands installation plus restart to electron-updater. The next launch displays the local loading page while reconciling the version-bound runtime.

Signed packaging emits generic-provider channel metadata for the deployment selected by `DSH_DESKTOP_AUTO_UPDATE_ENV`. NSIS differential packages and the macOS ZIP target allow electron-updater to reuse unchanged blocks; the manually installed DMG is notarized without a blockmap because it is not a macOS updater payload. The runtime and shell still form one signed Desktop release. macOS signing and notarization credentials use electron-builder's standard environment; Windows EV signing uses the public certificate, validated SignTool, SafeNet container, and runner PIN described above. The required Desktop release environment selects the application and platform signature identities that the build verifies.

## Low-level development overrides

An unpackaged Electron process uses `.desktop-build/development/project` under its application directory as its development project. `DSH_DESKTOP_NODE_BINARY`, `DSH_DESKTOP_PNPM_ENTRY`, and `DSH_DESKTOP_DSH_DIR` select explicit runtime resources. Packaged applications ignore these variables, read dsh from `app.getAppPath()/dsh`, resolve physical runtime and updater resources from `process.resourcesPath`, and use the managed Desktop profile.

## Known limitations

- The Web "Open In..." action is disabled in Desktop because its host plugin requires HTTP routes; Desktop does not provide a `webServer`.
- Release signing, notarization, update hosting, and previous-version installed-artifact qualification require the production release environment.
- Desktop plugins with dependency lifecycle scripts are rejected unless their package appears in the desktop project's reviewed `allowBuilds` policy.
- The desktop shell shares sessions, settings, credentials, workspaces, and storage under `$DSH_HOME` with CLI dsh, while executable packages, plugin activation, lockfiles, and package-manager state remain separate.
