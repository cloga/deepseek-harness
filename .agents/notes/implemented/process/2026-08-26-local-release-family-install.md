# Agent Note: Local release family installation

Status: implemented

English | [中文](2026-08-26-local-release-family-install.zh.md)

## Problem

A local DSH tarball names the same-version Harness packages it needs at runtime. Installing only `@deepseek-ai/dsh` delegates those names to npm, where a fork commit's versions may not be published. Installing many tarballs manually can omit vendored or native compatibility packages, and a successful launch can accidentally resolve modules from an embedding Desktop installation.

## Decision

`release:install-local` consumes the DSH, vendor, and native packed directories as one local artifact unit. It requires the complete DSH family and every fork-owned dependency or peer reachable from the supplied manifests, rejects missing order entries, validates every DSH payload, and installs the recursive runtime closure rooted at `@deepseek-ai/dsh` in deterministic dependency-first order. Test-support and build-only family members remain verified inputs without becoming runtime roots.

The command installs into a staging npm prefix, verifies the selected checkout commit and DSH version, applies the DSH tarball payload policy, records every tarball's SHA-256 and file count, and drives the installed JavaScript entry with `NODE_PATH` and `NODE_OPTIONS` removed. It creates a stable prefix-root shim that delegates to npm's internal shim. The staged root shim must report a Web URL from `dsh --profile web --port 0 --no-open` before the verified directory replaces the selected prefix, and publication restores the previous prefix if the replacement move fails. The receipt and `DSH_CLI_PATH` select the root shim so Desktop can derive `node_modules/@deepseek-ai/dsh` from the prefix.

This installation workflow extends the packed-artifact guarantees owned by the [npm release sequences](2026-08-10-npm-release-sequences.md); it does not change publication membership, versions, or registry behavior.

## Alternatives considered

**Install only the CLI tarball.** This depends on the registry already carrying every same-version fork package and cannot test an unpublished commit.

**Install tarballs directly into Desktop's packaged Core.** This mixes product-owned modules with a test candidate, makes rollback ambiguous, and cannot prove the candidate's runtime closure is self-contained.

**Use workspace links.** Links bypass packed payload selection and allow unbuilt or unshipped source files to satisfy imports, so they do not test the release artifact Desktop will execute.

## Consequences

Local Desktop testing has one repeatable prefix with an exact commit, version, payload inventory, and tarball hashes. Re-running the command replaces that prefix only after a fresh staged install passes, while an incomplete closure fails before registry resolution can hide it.

The workflow requires the complete DSH pack output but installs only the CLI runtime closure. This keeps payload verification aligned with maintained release-family membership while avoiding unrelated test and build dependencies in the Desktop prefix.
