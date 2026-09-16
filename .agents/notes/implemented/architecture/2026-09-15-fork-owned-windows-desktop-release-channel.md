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

Plugin compatibility retains the manifest schema 3 record for the complete generic `desktopNativeVerifiedRelease` capability, including capability schema 1 and structured source and receipt schema versions 1, with `automaticProvisioning: false`. Keeping this record unchanged lets installed 0.1.5 clients parse and install a release that contains the provisioning implementation.

The reviewed release plan schema 2 carries a generic exact-state Desktop plugin plan; schema 1 normalizes to an empty plan so the existing version-neutral release definition remains readable. The build receipt self-hashes independently and records the same source, build inputs, identity, artifact evidence, helper and capability hashes, the published provisioning plan's file and canonical hashes, native-updater exclusion, network policy, installation policy, and generic plugin schema compatibility. `SHA256SUMS` and `SHA512SUMS` cover the installer, provisioning plan, manifest, and receipt.

## Discovery and installation

Capability schema 3 contains the fixed `cloga/deepseek-harness` owner, `dsh-desktop-v` tag prefix, `release.json` asset name, packaged sequence, minimum sequence, exact plugin provisioning capability and canonical plan hash, and one exact migration record. It does not accept a user-selected repository or URL.

Check lists the fixed repository's GitHub Releases. Every matching release must be published, immutable, commit-pinned, and carry exactly one uploaded manifest asset with a GitHub SHA-256 digest. Desktop resolves the tag to the same commit, verifies the raw asset digest, parses the self-hashed manifest, and selects the highest non-conflicting sequence. The packaged sequence prevents self-selection after enterprise deployment; the durable completion receipt prevents rollback.

The selected handoff locks both the manifest's canonical self-hash and its raw release-asset SHA-256. The detached helper revalidates both before it downloads the receipt and installer. On the next launch, Desktop reconciles the packaged plugin plan before Host startup. Completion verifies the running executable, runtime descriptor, expected GitHub release and asset identifiers, and the packaged plan against capability schema 3 before it records the new sequence.

The detached helper is a self-contained bundle: only Node builtins remain external because the launcher copies no dependency directory. Finalization checks module syntax, and a mandatory packaged-byte smoke proves isolated bootstrap and a valid synthetic handoff acknowledgement before safe cancellation. Relative-import checks or source-runner tests alone cannot prove independence from workspace packages. Pre-acknowledgement stderr is bounded and redacted before persistence; discovery success is not helper boot evidence.

The loaded configuration distinguishes the packaged discovery floor from the persisted completed sequence. Discovery and handoff use the greater of packaged and completed sequences; completion uses only the durable receipt's sequence, or zero when absent. Using the packaged floor for completion would skip the newly installed release's own pending result and its inventory checks. Repeated completion is idempotent, failed inventory validation preserves the previous receipt, and a higher completed sequence never decreases.

The immutable `cloga/dsh-windows-ops` `dsh-local-0.1.5-rc.2.local.1` manifest remains an exact sequence-zero migration only when the source repository has no matching release. Any malformed, mutable, conflicting, or unreachable source release fails closed instead of falling back. Once a source release exists, Windows Ops cannot act as a second channel.

## Publication

The manual Windows workflow requires the operator to repeat the reviewed plan version. A rehearsal requires the checkout to equal the current selected remote branch, uses the credential-free build job with a clean checkout, pinned Node and pnpm, a frozen lockfile, focused Desktop tests, and unsigned packaging, then finalizes and uploads the checksummed asset set with seven-day retention. It never runs the release or remote-check job.

A publication run requires current `master`. The protected release job is the only job with `contents: write`. It downloads the build artifact, cross-checks the complete asset set, creates the exact source commit tag as a draft, uploads every asset, and publishes only after the asset set is complete. It then requires GitHub to report the release immutable, the tag and release target to resolve to the build commit, and every remote asset digest to match the local bytes. A final credential-free job runs the shipped discovery against GitHub and requires it to select the reviewed version, sequence, commit, and tree.

## Alternatives considered

**Keep Windows Ops as a second release owner.** Two manifests and build definitions can disagree, and an operational repository cannot authoritatively prove the source tree and application protocol it packages.

**Use electron-updater with an unsigned generic feed.** Native update mode relies on publisher and platform-signature validation. Enabling it for unsigned artifacts would weaken the official update security model and generate unsafe mutable channel metadata.

**Embed the next release URL and hash.** A current build cannot know an uncreated successor, so each package would end the channel or require an out-of-band rebuild.

**Use a mutable channel index.** A mutable index needs an independent signing and key-rotation system. Fixed GitHub owner and tag discovery, immutable releases, asset digests, exact tag commits, self-hashed manifests, and monotonic local sequence provide continuing discovery without another signing key.

## Consequences

Each new fork release requires a reviewed plan change and a protected manual workflow run. GitHub release immutability is mandatory; publication fails if the repository setting is absent. The source channel depends on GitHub's API and immutable Release service, and discovery rejects a channel that exceeds one bounded API page until the capability version changes.

Unsigned installers continue to show Windows trust warnings and may require UAC. The fork identity prevents those artifacts from appearing to be signed official vendor releases. Windows Ops retains enterprise pinning and deployment work while source code, protocol, release identity, and immutable bytes have one owner.
