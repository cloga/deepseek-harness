# Release scripts

English | [中文](README.zh.md)

This reference owns the package rehearsal in [release.yml](../../.github/workflows/release.yml) and the retired Core/Web GitHub release entry. [families.ts](families.ts) owns package membership, versions, payload policy and publish order. The separate [npm publisher](../../.github/workflows/release-publish.yml) is unchanged.

## Package rehearsal

The workflow runs dependency-layout checks, the official build, package packing and packed-install verification on pull requests, master pushes and manual dispatches. It has only `dependencies` and `pack` jobs, repository-read permission and per-workflow/per-ref cancellation. Existing hosted and trusted self-hosted runner selection remains unchanged. It accepts no publication inputs and has no GitHub Release writer, seal step or publication token.

The dsh tarballs and publish-order file are retained as CI artifacts for seven days. Vendored framework and Landlock entry tarballs support packed-install verification but are not uploaded with that artifact. These package artifacts are neither Windows Desktop installers nor an offline installation closure; optional native packages and registry dependencies remain external.

## Fork delivery and retired entry

For `cloga/deepseek-harness`, the default user-facing delivery is a verified Windows Desktop installer in the `dsh-desktop-v<version>` channel. Core/Web changes intended for that product ship through its qualified Desktop source and release process. A different public delivery type needs separate explicit user authorization recorded in the governing release plan or Issue; generic release approval, valid package checksums or a successful rehearsal is not that authorization. [Issue #90](https://github.com/cloga/deepseek-harness/issues/90) owns this correction; this isolated source does not acquire the fork's Desktop implementation.

[github-artifacts.ts](github-artifacts.ts) is a refusal-only compatibility entry. Every invocation, including the former `guard` and `publish` commands, missing or unknown arguments, and previously admitted environment selectors, exits nonzero with a retirement message. It reads no credentials or artifacts, performs no network requests, creates no journal or seal, and changes no release, tag or file. The old writer, evidence reader and preparation implementation are removed rather than retained behind an enable flag. There is no force or recovery option.

## Existing tags and releases

This source change does not modify code stored in an older immutable tag, stop a historical workflow run, delete a Release, move a tag or replace any published bytes. Do not dispatch the retired writer from an old ref. Its existing previous-writer-attempt refusal and immutable-tag non-reuse restrictions remain relevant to historical recovery; they are not a substitute for this source retirement and must not be bypassed. Withdrawal and replacement require the separately authorized release procedure, preservation of protected tags and verification of the replacement before retiring the old Release.

## Verification scope

The existing script test lane includes `github-artifacts.spec.ts`. It invokes the refusal entry under plain Node with legacy and empty environments, traps network and file-write attempts, and checks artifact preservation and absent journals. Workflow regressions reject reintroduced publication inputs, jobs, permissions, tokens, guard/seal commands and missing build or packed-install verification, while preserving runner routing and npm publication assertions. These checks do not establish a complete build, live GitHub dispatch behavior, Windows installation, published-artifact integrity or Desktop runtime acceptance.
