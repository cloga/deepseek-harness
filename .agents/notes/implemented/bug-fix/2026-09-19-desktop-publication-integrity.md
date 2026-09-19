# Agent Note: Verify Desktop release integrity before publication

Status: implemented

English | [中文](2026-09-19-desktop-publication-integrity.zh.md)

## Problem

The fork Desktop workflow invoked several native `gh` commands in one PowerShell step without checking each exit status. Failed draft creation or asset upload could therefore be followed by a publication command. Source, tag, and remote asset checks happened only after publication, and checking only returned assets could overlook missing files. An immutable release cannot be repaired after those checks fail.

## Decision

The [checked publisher](../../../../apps/desktop/scripts/publish-fork-release.mjs) uses Node builtins and explicit GitHub API results rather than an unchecked native-command sequence. The release job checks out the exact build source and verifies the downloaded artifact-set digest before invoking it. No additional package installation is required in that job.

Only a classified HTTP 404 establishes absence. The publisher validates reviewed manifest inputs, refuses existing releases or tags, creates a new lightweight tag pointing to the reviewed commit, and creates its own draft. It verifies that draft's identity, source, tag, and exact asset names, counts, sizes, and digests before making it public. It verifies the immutable result again afterward. Credentials are limited to the GitHub API and the explicit upload endpoint, without redirects.

Every failed or uncertain operation stops the sequence. There are no automatic write retries, tag moves, existing-draft edits, or cleanup writes. A retained tag or draft after interruption requires explicit reconciliation; it is not permission to publish an earlier writer's assets.

## Alternatives considered

**Only stop on native command failures.** This closes one error-propagation gap, but still leaves source and missing-asset checks after irreversible publication.

**Repair the release afterward.** Immutable assets and tags deliberately prohibit this recovery model. Verification belongs before publication, with post-publication verification as an additional check rather than the first one.

## Consequences

Offline negative tests exercise transport and API errors, ownership conflicts, source/tag mismatch, incomplete asset sets, and failed publication. Workflow tests require the exact-source publisher after artifact-set verification. These safeguards do not change Desktop runtime behavior, Core or dependency versions, installer interaction, or the separate requirement for user consent before installation.
