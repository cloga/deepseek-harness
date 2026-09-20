# Agent Note: Own the fork Windows Desktop release channel in source

Status: implemented

English | [中文](2026-09-15-fork-owned-windows-desktop-release-channel.zh.md)

## Problem

The cloga Windows Desktop fork needs an unsigned installer and managed update path without claiming the official vendor's application identity, signature, or native update trust. Release definitions split between the source repository and Windows Ops can diverge in version, source commit, installer hashes, plugin capability compatibility, or completion semantics.

A fixed future manifest URL cannot support continuing updates because a packaged application cannot know the next release's hash. A mutable arbitrary feed URL would move release authority outside reviewed source and allow rollback or origin changes.

## Decision

Windows Ops selects and locks one supported upstream baseline at a time. `cloga/deepseek-harness` records that selected baseline in the reviewed Windows x64 release plan and owns the fixed fork identity, installer build, managed capability, release manifest, build receipt, checksums, immutable Git tag, and GitHub Release. Windows Ops pins, verifies, and deploys these source-owned assets. It does not publish a parallel long-lived Desktop release definition.

The fork identity is `io.github.cloga.deepseek-harness.desktop`, product `DeepSeek Harness (cloga)`, package `cloga-deepseek-harness-desktop`, executable `cloga-deepseek-harness`, and artifact prefix `cloga-deepseek-harness`. The installer is unsigned, interactive NSIS. It receives no silent arguments, and Windows warnings, installer choices, elevation, and UAC remain user-controlled. Native `electron-updater` is disabled and the package contains no `app-update.yml`.

The reviewed plan advances a semantic channel version and integer sequence. The first source-owned version is greater than the `0.1.5-rc.2.local.1` transition build and uses sequence 2. Tags use `dsh-desktop-v<version>` and never overwrite history.

## Release records

Manifest schema 3 self-hashes canonical JSON and records the source repository, commit, tree, tag, upstream version, sequence, workflow path, lockfile hash, plan hash, pinned Node and pnpm versions, dependency materialization registry, fork identities, installer filename, byte size, SHA-256, SHA-512, unsigned Authenticode state, build-receipt hashes, installed executable and runtime hashes, network policy, and interactive post-restart completion semantics.

The installed runtime descriptor is `resources/app.asar/dsh/desktop-runtime.json`; receipts hash its exact archived bytes read through packaged Electron in Node mode, not reserialized JSON. Build-time [packaged runtime inspection](../../../../apps/desktop/scripts/packaged-runtime.mjs) uses the builder's ASAR reader to reject unsafe paths and links, audit the exact physical unpacked file set, and materialize actual bytes into a private temporary verification tree. Packed executable flags come from the archive; unpacked modes come from physical files because Electron's virtual stats synthesize permissions and omit orphan sidecar files. The unchanged inventory verifier runs on that copy through bounded, scrubbed Electron Node mode; cleanup follows child exit. The copy is not an installed runtime or a second authority, and no Host or profile boots. The release workflow runs packaged-Electron inventory canaries before finalization.

Plugin compatibility retains the manifest schema 3 record for the complete generic `desktopNativeVerifiedRelease` capability, including capability schema 1 and structured source and receipt schema versions 1, with `automaticProvisioning: false`. Keeping this record unchanged lets installed 0.1.5 clients parse and install a release that contains the provisioning implementation.

The reviewed release plan schema 2 carries a generic exact-state Desktop plugin plan; schema 1 normalizes to an empty plan so the existing version-neutral release definition remains readable. The build receipt self-hashes independently and records the same source, build inputs, identity, artifact evidence, helper and capability hashes, the published provisioning plan's file and canonical hashes, native-updater exclusion, network policy, installation policy, and generic plugin schema compatibility. `SHA256SUMS` and `SHA512SUMS` cover the installer, provisioning plan, manifest, and receipt.

Build-only metadata discovery can explicitly receive `DSH_DESKTOP_RELEASE_GITHUB_TOKEN` through the [release fetch adapter](../../../../apps/desktop/scripts/desktop-release-github-fetch.ts). CI supplies its read-only Actions token only to preparation and remote verification, not packaging or the application. Only canonical release-list and tag-resolution GET requests for the fixed GitHub API repository receive authorization. Authenticated redirects fail closed; downloads and other origins remain anonymous, and caller authorization/cookies are removed. Transport and response errors withhold arbitrary remote text and retain safe cancellation or numeric HTTP status. An absent token keeps anonymous discovery; no credential store or ambient `GH_TOKEN` is read, and receipts never contain the token. The shipped application remains unchanged.

## Discovery and installation

Capability schema 3 contains the fixed `cloga/deepseek-harness` owner, `dsh-desktop-v` tag prefix, `release.json` asset name, packaged sequence, minimum sequence, exact plugin provisioning capability and canonical plan hash, and one exact migration record. It does not accept a user-selected repository or URL.

Check lists the fixed repository's GitHub Releases. Every matching release must be published, immutable, commit-pinned, and carry exactly one uploaded manifest asset with a GitHub SHA-256 digest. Desktop resolves the tag to the same commit, verifies the raw asset digest, parses the self-hashed manifest, and selects the highest non-conflicting sequence. The packaged sequence prevents self-selection after enterprise deployment; the durable completion receipt prevents rollback.

The selected handoff locks both the manifest's canonical self-hash and its raw release-asset SHA-256. The detached helper revalidates both before it downloads the receipt and installer. On the next launch, Desktop reconciles the packaged plugin plan before Host startup. Completion verifies the running executable, runtime descriptor, expected GitHub release and asset identifiers, and the packaged plan against capability schema 3 before it records the new sequence.

The detached helper is a self-contained bundle: only Node builtins remain external because the launcher copies no dependency directory. Finalization checks module syntax, and a mandatory packaged-byte smoke proves isolated bootstrap and a valid synthetic handoff acknowledgement before safe cancellation. Relative-import checks or source-runner tests alone cannot prove independence from workspace packages. Pre-acknowledgement stderr is bounded and redacted before persistence; discovery success is not helper boot evidence.

The loaded configuration distinguishes the packaged discovery floor from the persisted completed sequence. Discovery and handoff use the greater of packaged and completed sequences; completion uses only the durable receipt's sequence, or zero when absent. Using the packaged floor for completion would skip the newly installed release's own pending result and its inventory checks. Repeated completion is idempotent, failed inventory validation preserves the previous receipt, and a higher completed sequence never decreases.

The immutable `cloga/dsh-windows-ops` `dsh-local-0.1.5-rc.2.local.1` manifest remains an exact sequence-zero migration only when the source repository has no matching release. The migration record fixes the manifest and installer hashes plus the build receipt's `dsh-v0.1.5-rc.2` source tag; the manifest-fixed receipt retains the source commit and tree. Any malformed, mutable, conflicting, or unreachable source release fails closed instead of falling back. Once a source release exists, Windows Ops cannot act as a second channel.

## Failed transactions and recovery

A helper failure before final-stage promotion cannot have launched the installer: both legacy and current helpers promote the stage first. Completion validates operation identity, acknowledgement, cancellation, and result evidence before classifying these failures as terminal without advancing the completed sequence. Current helpers retain the validated manifest before acknowledgement and mark possible installation before calling the launcher. Cancellation never overrides a final stage or installer evidence. Retained records remain available for diagnosis. Completion reads historical handoff identity separately from current launch eligibility: both schema 2 and early schema 3 contain exact `version`/`commit` migration sources. Read-only normalization validates the commit before constructing parser-only tag metadata, retains schema-3 provisioning validation, and discards the normalized capability without authorizing installation or rewriting retained files. Compatibility keyed only by capability schema would reject released schema-3 history because the migration fields changed within that schema. Unknown schemas and malformed records still fail closed.

Staged failures remain unresolved unless an independent candidate verifies the same or a newer installed release. An acknowledged helper that remains alive without a terminal result prevents supersession; checking liveness never terminates it. Completion binds retained manifest bytes to the handoff asset hash, checks executable/runtime hashes, requires the current packaged sequence and plugin inventory, and rejects newer or same-sequence conflicting staged transactions. A supplemental pre-install manifest can identify only the currently packaged release; an unstarted future download cannot prevent a valid current completion. Already completed history is validated without applying a newly raised discovery floor retroactively.

Transfer deadlines cover headers, redirects, and body consumption, with separate metadata and installer budgets. Bounded retry applies only to classified transient transport/HTTP failures, never identity or integrity validation. Installer cancellation closes the Node-wrapped Web stream and output before deleting its private partial file. Durable diagnostics retain phase, validated asset basename, error category, and possible-installation state, not remote messages, credentials, signed URL parameters, or operation tokens.

The installed executable owns `--recover-managed-update`. Later launches route recovery to the single-instance owner; evidence rechecking does not stop Host or reset profiles. Explicit recovery can authenticate the currently installed release independently of retained handoffs through immutable discovery and a manifest-authenticated build receipt. Exact version and sequence selection permits recovery when a newer release is published, without installing it. The receipt binds source identity, executable/runtime hashes, packaged capability bytes, and provisioning-plan bytes and canonical hash. Completion still requires final-location Host readiness and actual inventory, rereads retained operations after network access, and rejects a concurrently advanced completion. Historical operations remain unchanged. Ordinary startup uses local evidence only; offline or unverifiable publication metadata cannot authorize manual-install recovery. This entry cannot repair an unbootable Host. A still-blocked result offers the existing update flow with active-work confirmation. The [Desktop README](../../../../apps/desktop/README.md) owns recovery usage and transfer limits.

## Publication

The manual Windows workflow requires the reviewed plan version and source commit through required `confirm_version` and `expected_source_sha` inputs. Before dependency installation or packaging, the step-local `EXPECTED_SOURCE_SHA` must contain exactly 40 lowercase hexadecimal characters and match the checked-out `HEAD` exactly. A newer commit with the same plan is rejected rather than silently changing the reviewed source. A rehearsal still requires the checkout to equal the current selected remote branch, uses the build job with a clean checkout, pinned Node and pnpm, a frozen lockfile, focused Desktop tests, and unsigned packaging, then finalizes and uploads the checksummed asset set with seven-day retention. Only the metadata preparation step receives read-only GitHub credentials; packaging and acceptance processes remain credential-free. It never runs the release or remote-check job.

A publication run requires current `master`. The protected release job is the only job with `contents: write`. It downloads the build artifact, cross-checks the complete asset set, creates the exact source commit tag as a draft, uploads every asset, and publishes only after the asset set is complete. It then requires GitHub to report the release immutable, the tag and release target to resolve to the build commit, and every remote asset digest to match the local bytes. A final read-only job uses the build-only metadata adapter to run the shipped discovery against GitHub and requires it to select the reviewed version, sequence, commit, and tree.

## Alternatives considered

**Ignore every blocked result or delete operation history.** Either loses installation-interruption protection and forensic evidence. Only validated no-install failures are nonblocking; staged failures need independently verified replacement evidence.

**Advance completion from the installed version or retry every error.** A version cannot attest file hashes or plugin activation, and retrying integrity failures weakens diagnostics without repairing the bytes. Completion uses verified evidence; retry excludes validation and installer execution.

**Confirm only the version and current branch.** A branch can advance to an unreviewed commit without changing the plan version between controller review and workflow dispatch. Pinning the expected source commit inside the workflow closes that gap while retaining current-branch and version checks.

**Keep Windows Ops as a second release owner.** Two manifests and build definitions can disagree, and an operational repository cannot authoritatively prove the source tree and application protocol it packages.

**Use electron-updater with an unsigned generic feed.** Native update mode relies on publisher and platform-signature validation. Enabling it for unsigned artifacts would weaken the official update security model and generate unsafe mutable channel metadata.

**Embed the next release URL and hash.** A current build cannot know an uncreated successor, so each package would end the channel or require an out-of-band rebuild.

**Use a mutable channel index.** A mutable index needs an independent signing and key-rotation system. Fixed GitHub owner and tag discovery, immutable releases, asset digests, exact tag commits, self-hashed manifests, and monotonic local sequence provide continuing discovery without another signing key.

## Consequences

Each new fork release requires a reviewed plan change and a protected manual workflow run. GitHub release immutability is mandatory; publication fails if the repository setting is absent. The source channel depends on GitHub's API and immutable Release service, and discovery rejects a channel that exceeds one bounded API page until the capability version changes.

Unsigned installers continue to show Windows trust warnings and may require UAC. The fork identity prevents those artifacts from appearing to be signed official vendor releases. Windows Ops retains enterprise pinning and deployment work while source code, protocol, release identity, and immutable bytes have one owner.
